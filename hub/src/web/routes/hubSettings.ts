import { Hono } from 'hono'
import { UpdateHubSettingsRequestSchema, type HubSettingsResponse } from '@hapi/protocol'
import { mergePeerSpawnDefaults } from '@hapi/protocol/peerSpawnDefaults'
import {
    getSettingsFile,
    readSettingsOrThrowCached,
    updateSettings,
    type Settings
} from '../../config/settings'
import { applyPeerSpawnDefaultsPatch } from '../../config/peerSpawnDefaults'
import { writeAutoBridgeTransientModelErrorsEnabled } from '../../config/autoBridgeTransientModelErrors'
import {
    isTelemetryLevel,
    readTelemetryLevelState,
    writeTelemetryLevel
} from '../../config/telemetryLevel'
import type { SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const OWNER_ONLY_ERROR = 'Hub settings are only available to the hub owner'

type TelemetryLevelResponse = HubSettingsResponse & {
    telemetryLevel: number
    telemetryLevelSource: 'env' | 'file' | 'default'
}

async function toHubSettings(settings: Settings, dataDir: string): Promise<TelemetryLevelResponse> {
    const levelState = await readTelemetryLevelState(dataDir)
    return {
        sessionSummaryContract: settings.sessionSummaryContract === true,
        sessionSummaryInChat: settings.sessionSummaryInChat === true,
        autoTitlePerTurn: settings.autoTitlePerTurn === true,
        disablePeerTools: settings.disablePeerTools === true,
        autoBridgeTransientModelErrors: settings.autoBridgeTransientModelErrors === true,
        peerSpawnDefaults: mergePeerSpawnDefaults(settings.peerSpawnDefaults),
        telemetryLevel: levelState.level,
        telemetryLevelSource: levelState.source
    }
}

export function createHubSettingsRoutes(
    dataDir: string,
    getSyncEngine?: () => SyncEngine | null,
    store?: Store
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Authenticated readers (any namespace) can observe hub-wide display/emit
    // flags. Mutations stay owner-only below.
    app.get('/hub-settings', async (c) => {
        c.header('Cache-Control', 'no-store')
        const settings = await readSettingsOrThrowCached(getSettingsFile(dataDir))
        return c.json(await toHubSettings(settings, dataDir))
    })

    app.put('/hub-settings', async (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }
        const json = await c.req.json().catch(() => null)
        // telemetryLevel lives outside the shared UpdateHubSettingsRequestSchema
        // (shared contract layer is frozen for this slice): peel it off, validate
        // locally, and keep the same one-field-per-request discipline.
        const rawBody = (json && typeof json === 'object' ? { ...(json as Record<string, unknown>) } : null)
        const telemetryPatch = rawBody?.telemetryLevel
        if (rawBody) delete rawBody.telemetryLevel
        if (telemetryPatch !== undefined && !isTelemetryLevel(telemetryPatch)) {
            return c.json({ error: 'telemetryLevel must be 0, 1, 2 or 3' }, 400)
        }
        // A body carrying ONLY telemetryLevel legitimately fails the shared
        // schema's "at least one known field" refine — accept it as a
        // single-field patch instead of 400ing.
        const telemetryOnly = telemetryPatch !== undefined && rawBody !== null && Object.keys(rawBody).length === 0
        const parsed = UpdateHubSettingsRequestSchema.safeParse(rawBody)
        if (!parsed.success && !telemetryOnly) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const providedFieldCount = [
            parsed.success ? parsed.data.sessionSummaryContract : undefined,
            parsed.success ? parsed.data.sessionSummaryInChat : undefined,
            parsed.success ? parsed.data.autoTitlePerTurn : undefined,
            parsed.success ? parsed.data.disablePeerTools : undefined,
            parsed.success ? parsed.data.autoBridgeTransientModelErrors : undefined,
            telemetryPatch
        ].filter((value) => value !== undefined).length
        if (providedFieldCount > 1) {
            return c.json({ error: 'Update one hub setting per request' }, 400)
        }
        // telemetryOnly means parsed failed the refine on an (now-)empty body;
        // every field access below then sees an empty patch object. A plain
        // peerSpawnDefaults-only patch has no boolean fields — that path keeps
        // working exactly as before (shared schema validates it).
        const fields = parsed.success ? parsed.data : {}
        // A telemetryLevel write under an env pin must be refused, not silently
        // shadowed — otherwise the operator thinks they changed the level.
        if (telemetryPatch !== undefined) {
            const levelState = await readTelemetryLevelState(dataDir)
            if (levelState.source === 'env') {
                return c.json({
                    error: 'telemetryLevel is pinned by HAPI_TELEMETRY_LEVEL',
                    code: 'telemetry_level_pinned_by_env'
                }, 409)
            }
            await writeTelemetryLevel(dataDir, telemetryPatch)
            const settings = await readSettingsOrThrowCached(getSettingsFile(dataDir))
            c.header('Cache-Control', 'no-store')
            return c.json(await toHubSettings(settings, dataDir))
        }
        // Auto-bridge is not a plain settings write: SyncEngine fans the pref out
        // to live Cursor CLIs and rolls the disk value back if any session refuses.
        // Keep it outside the updateSettings transaction so the engine owns both
        // halves under its own lock; the write still goes through updateSettings
        // underneath, so the settings read cache stays write-through fresh.
        if (fields.autoBridgeTransientModelErrors !== undefined) {
            const enabled = fields.autoBridgeTransientModelErrors
            const engine = getSyncEngine?.() ?? null
            if (engine) {
                try {
                    // Disk write + fanout + rollback share SyncEngine's lock so
                    // concurrent PUTs cannot leave CLI prefs ahead of settings.json.
                    await engine.applyAutoBridgeTransientModelErrorsSetting(dataDir, enabled)
                } catch (error) {
                    const message = error instanceof Error
                        ? error.message
                        : 'Failed to update every active Cursor session'
                    return c.json({ error: message }, 409)
                }
            } else {
                await writeAutoBridgeTransientModelErrorsEnabled(dataDir, enabled)
            }
        }
        const response = await updateSettings(getSettingsFile(dataDir), async (current) => {
            const settings: Settings = { ...current }
            if (fields.sessionSummaryContract !== undefined) {
                settings.sessionSummaryContract = fields.sessionSummaryContract
            }
            if (fields.sessionSummaryInChat !== undefined) {
                settings.sessionSummaryInChat = fields.sessionSummaryInChat
            }
            if (fields.autoTitlePerTurn !== undefined) {
                settings.autoTitlePerTurn = fields.autoTitlePerTurn
            }
            if (fields.disablePeerTools !== undefined) {
                settings.disablePeerTools = fields.disablePeerTools
            }
            if (fields.peerSpawnDefaults !== undefined) {
                settings.peerSpawnDefaults = applyPeerSpawnDefaultsPatch(
                    current,
                    fields.peerSpawnDefaults
                )
            }
            return {
                settings,
                result: await toHubSettings(settings, dataDir)
            }
        })
        // Re-enabling per-turn rewrites resets the "manual rename wins" era:
        // every nameLocked pin is cleared so the agent can retake the title.
        if (fields.autoTitlePerTurn === true) {
            store?.sessions.clearSessionNameLocks()
        }
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}

import { compareSessionSummaries, toSlimSessionSummary, DEFAULT_PR_CHIP_DISPLAY } from '@hapi/protocol'
import { Hono } from 'hono'
import { getConfiguration } from '../../configuration'
import { getProviderEnvironment } from '../../config/providerCredentials'
import { listConfiguredVoiceBackends, resolveHubVoiceBackend } from '@hapi/protocol/voice'
import { loadPrChipDisplayProfile } from '../../config/prChipDisplay'
import { readTelemetryLevelState } from '../../config/telemetryLevel'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSyncEngine } from './guards'

/**
 * GET /api/bootstrap — the cold-start round-trip consolidator.
 *
 * A fresh client (PWA launch, app shell start, tab reload) otherwise pays
 * three serial/parallel REST legs before first paint: the session list, the
 * machine list and the feature flags. On high-latency paths (~350-450ms per
 * leg on mobile networks or VPN-tunneled desktops) that stacks a full second
 * onto every cold start, and phones that wake in the background on a
 * schedule pay it over and over. This endpoint answers all three in one
 * request; each payload is byte-identical to its standalone endpoint so the
 * client can seed its per-key query caches directly.
 *
 * The session list is the slim projection (same as
 * GET /api/sessions?view=slim) — the list surface never reads the omitted
 * detail fields, and detail/prefetch flows keep using the full endpoint.
 */
export function createBootstrapRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/bootstrap', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const namespace = c.get('namespace')

        // Session list: slim projection, newest-activity order, cap 100.
        // (Same ordering the list surface uses; a cold start never needs
        // more than the visible viewport plus the eager-prefetch top rows.)
        // Same ordering as GET /api/sessions (pinned/globalPinned first,
        // then lastUserMessageAt??createdAt desc): the seeded first paint
        // must match what the standalone GET resolves to, or pinned rows
        // jump when the GET lands.
        const sessionRecords = engine
            .getSessionsByNamespace(namespace)
            .sort(compareSessionSummaries)
            .slice(0, 100)
        const sessionIds = sessionRecords.map((session) => session.id)
        const scheduledCounts = engine.getFutureScheduledMessageCounts(sessionIds)
        const nextScheduledAt = engine.getNextScheduledAtBySessionIds(sessionIds)
        const attachedJobVersions = new Map(sessionIds.map((id) => [id, engine.allocateAttachedJobVersion(id)]))
        const attachedJobs = engine.getPrimaryAttachedJobsBySessionIds(sessionIds)
        const sessions = sessionRecords.map((session) => {
            const extras = {
                attachedJob: attachedJobs.get(session.id) ?? null,
                attachedJobUpdatedAt: attachedJobVersions.get(session.id) ?? 0
            }
            const scheduledCount = scheduledCounts.get(session.id) ?? 0
            const scheduledAt = nextScheduledAt.get(session.id) ?? null
            return {
                ...toSlimSessionSummary(session, extras),
                ...(scheduledCount > 0 ? { futureScheduledMessageCount: scheduledCount } : {}),
                ...(scheduledAt !== null ? { nextScheduledAt: scheduledAt } : {})
            }
        })

        // Machines: same payload as GET /api/machines.
        const machines = engine.getOnlineMachinesByNamespace(namespace)

        // Features: same payload as GET /api/features. Bootstrap must never
        // 500 on a config hiccup — fall back to defaults like the env unset
        // state when the configuration object is not yet initialized.
        let features: {
            githubPrAwareness: { enabled: boolean; source: 'env' | 'file' | 'default' }
            prChipDisplay: ReturnType<typeof loadPrChipDisplayProfile>
            telemetry: boolean
            telemetryLevel: number
        }
        try {
            const configuration = getConfiguration()
            const telemetryLevelState = await readTelemetryLevelState(configuration.dataDir)
            features = {
                githubPrAwareness: {
                    enabled: configuration.githubPrAwareness,
                    source: configuration.sources.githubPrAwareness
                },
                prChipDisplay: loadPrChipDisplayProfile(configuration.dataDir),
                telemetry: true,
                telemetryLevel: telemetryLevelState.level
            }
        } catch {
            features = {
                githubPrAwareness: { enabled: false, source: 'default' },
                prChipDisplay: DEFAULT_PR_CHIP_DISPLAY,
                telemetry: true,
                telemetryLevel: 1
            }
        }

        // Voice backend selection: same payload as GET /api/voice/backend.
        // The realtime voice session refetches this on every mount; seeding
        // it removes the last cold-start leg the composer path still pays.
        const voiceEnv = getProviderEnvironment()
        const voiceBackend = {
            backend: resolveHubVoiceBackend(voiceEnv),
            backends: listConfiguredVoiceBackends(voiceEnv)
        }

        return c.json({ sessions, machines, features, voiceBackend })
    })

    return app
}

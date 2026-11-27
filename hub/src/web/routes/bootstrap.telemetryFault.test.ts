import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createBootstrapRoutes } from './bootstrap'
import { getConfiguration, createConfiguration, _resetConfigurationForTests } from '../../configuration'
import { __resetSettingsReadCacheForTests, getSettingsFile } from '../../config/settings'
import { writeTelemetryLevel } from '../../config/telemetryLevel'
import type { SyncEngine } from '../../sync/syncEngine'

/**
 * Review finding #4: readTelemetryLevelState used to sit inside the shared
 * features try/catch, so an unreadable settings.json knocked
 * githubPrAwareness and prChipDisplay back to their defaults too. The
 * telemetry read now degrades alone; this suite pins that with a real
 * initialized configuration (fresh HAPI_HOME so the singleton is ours).
 */

function makeEngine(): SyncEngine {
    return {
        getSessionsByNamespace: () => [],
        getFutureScheduledMessageCounts: () => new Map(),
        getNextScheduledAtBySessionIds: () => new Map(),
        getSessionTaskSummaries: () => new Map(),
        allocateAttachedJobVersion: () => 1,
        getPrimaryAttachedJobsBySessionIds: () => new Map(),
        getOnlineMachinesByNamespace: () => []
    } as unknown as SyncEngine
}

function createApp() {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createBootstrapRoutes(() => makeEngine()))
    return app
}

let homeDir = ''
let previousHome: string | undefined
let previousTelemetryEnv: string | undefined

beforeAll(async () => {
    previousHome = process.env.HAPI_HOME
    previousTelemetryEnv = process.env.HAPI_TELEMETRY_LEVEL
    delete process.env.HAPI_TELEMETRY_LEVEL
    homeDir = await mkdtemp(join(tmpdir(), 'hapi-bootstrap-fault-'))
    process.env.HAPI_HOME = homeDir
    // githubPrAwareness=true from the settings file so a regression to the
    // shared catch is observable (it would answer enabled:false/'default').
    await writeFile(join(homeDir, 'settings.json'), JSON.stringify({ githubPrAwareness: true }), 'utf8')
    _resetConfigurationForTests()
    await createConfiguration()
})

afterAll(async () => {
    _resetConfigurationForTests()
    if (previousHome === undefined) {
        delete process.env.HAPI_HOME
    } else {
        process.env.HAPI_HOME = previousHome
    }
    if (previousTelemetryEnv === undefined) {
        delete process.env.HAPI_TELEMETRY_LEVEL
    } else {
        process.env.HAPI_TELEMETRY_LEVEL = previousTelemetryEnv
    }
    if (homeDir) {
        await rm(homeDir, { recursive: true, force: true })
    }
})

describe('bootstrap features fault isolation', () => {
    it('keeps githubPrAwareness from settings when settings.json turns unreadable (review finding #4)', async () => {
        await writeFile(getSettingsFile(getConfiguration().dataDir), '{corrupted', 'utf8')
        __resetSettingsReadCacheForTests()

        const app = createApp()
        const response = await app.request('/api/bootstrap')
        expect(response.status).toBe(200)
        const body = await response.json() as {
            features: {
                githubPrAwareness: { enabled: boolean; source: string }
                telemetry: boolean
                telemetryLevel: number
            }
        }
        // The telemetry leg degrades alone: level 0, capability still true.
        expect(body.features.telemetryLevel).toBe(0)
        expect(body.features.telemetry).toBe(true)
        // ...while githubPrAwareness keeps its configured value instead of
        // being dragged back to the default by the shared catch.
        expect(body.features.githubPrAwareness).toEqual({ enabled: true, source: 'file' })
    })

    it('still serves the configured telemetry level when settings are healthy', async () => {
        // Repair the file test 1 corrupted (githubPrAwareness must survive
        // the repair — it is the non-regression anchor of this suite).
        await writeFile(
            getSettingsFile(getConfiguration().dataDir),
            JSON.stringify({ githubPrAwareness: true }),
            'utf8'
        )
        __resetSettingsReadCacheForTests()
        await writeTelemetryLevel(getConfiguration().dataDir, 1)
        const app = createApp()
        const response = await app.request('/api/bootstrap')
        expect(response.status).toBe(200)
        const body = await response.json() as {
            features: {
                githubPrAwareness: { enabled: boolean; source: string }
                telemetryLevel: number
            }
        }
        expect(body.features.telemetryLevel).toBe(1)
        expect(body.features.githubPrAwareness).toEqual({ enabled: true, source: 'file' })
    })
})

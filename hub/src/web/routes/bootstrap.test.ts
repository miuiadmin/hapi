import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createBootstrapRoutes } from './bootstrap'
import type { SyncEngine, Session } from '../../sync/syncEngine'

function makeEngine(overrides: Partial<SyncEngine> = {}): SyncEngine {
    const session = {
        id: 'sess-1',
        namespace: 'default',
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 2,
        metadata: { path: '/tmp/p', host: 'localhost', flavor: 'claude' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 2,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: 'default',
        collaborationMode: 'default',
        seq: 1,
        contentRevision: 0
    } as unknown as Session
    return {
        getSessionsByNamespace: () => [session],
        getFutureScheduledMessageCounts: () => new Map(),
        getNextScheduledAtBySessionIds: () => new Map(),
        getSessionTaskSummaries: () => new Map(),
        allocateAttachedJobVersion: () => 1,
        getPrimaryAttachedJobsBySessionIds: () => new Map(),
        getOnlineMachinesByNamespace: () => [{ id: 'machine-1', namespace: 'default', active: true } as never],
        ...overrides
    } as unknown as SyncEngine
}

function createApp(engine: SyncEngine | null, namespace = 'default') {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createBootstrapRoutes(() => engine))
    return app
}

describe('bootstrap routes', () => {
    it('returns slim sessions + machines + features in one payload', async () => {
        const app = createApp(makeEngine())
        const response = await app.request('/api/bootstrap')
        expect(response.status).toBe(200)
        const body = await response.json() as {
            sessions: Array<{ id: string; metadata?: unknown; model?: unknown; activeTaskCount?: number; nextTaskRunAt?: number | null }>
            machines: Array<{ id: string }>
            features: { githubPrAwareness: { enabled: boolean }; prChipDisplay: unknown }
            voiceBackend: { backend: string | null; backends: string[] }
        }
        expect(body.sessions).toHaveLength(1)
        expect(body.sessions[0].id).toBe('sess-1')
        // Slim projection: detail-only fields absent.
        expect(body.sessions[0].model).toBeUndefined()
        // Empty-default task counts are omitted too, like the scheduled extras.
        expect('activeTaskCount' in body.sessions[0]).toBe(false)
        expect('nextTaskRunAt' in body.sessions[0]).toBe(false)
        expect(body.machines).toHaveLength(1)
        expect((body.machines[0] as { id: string }).id).toBe('machine-1')
        expect(typeof body.features.githubPrAwareness.enabled).toBe('boolean')
        expect(Array.isArray(body.voiceBackend.backends)).toBe(true)
    })

    it('carries a session\'s task counts in the slim row when it has tasks', async () => {
        const asked: string[][] = []
        const app = createApp(makeEngine({
            getSessionTaskSummaries: (ids: string[]) => {
                asked.push(ids)
                return new Map([['sess-1', { activeTaskCount: 2, nextTaskRunAt: 1_700_000_000_000 }]])
            }
        }))
        const response = await app.request('/api/bootstrap')
        const body = await response.json() as { sessions: Array<{ id: string; activeTaskCount?: number; nextTaskRunAt?: number | null }> }
        expect(asked).toEqual([['sess-1']])
        expect(body.sessions[0].activeTaskCount).toBe(2)
        expect(body.sessions[0].nextTaskRunAt).toBe(1_700_000_000_000)
    })

    it('caps the session list at 100 newest-first', async () => {
        const many = Array.from({ length: 150 }, (_, i) => ({ id: `s-${i}`, updatedAt: i, createdAt: i }))
        const engine = makeEngine({
            getSessionsByNamespace: () => many as never
        })
        const app = createApp(engine)
        const response = await app.request('/api/bootstrap')
        const body = await response.json() as { sessions: Array<{ id: string }> }
        expect(body.sessions).toHaveLength(100)
        // Same ordering as the standalone list (compareSessionSummaries):
        // lastUserMessageAt??createdAt desc — s-149 (highest createdAt) leads.
        expect(body.sessions[0].id).toBe('s-149')
    })

    it('returns 503 when the sync engine is unavailable', async () => {
        const app = createApp(null)
        const response = await app.request('/api/bootstrap')
        expect(response.status).toBe(503)
    })
})

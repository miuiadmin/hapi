import { describe, expect, it } from 'bun:test'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'
import { SessionEnumerationCache } from './sessionEnumerationCache'
import type { RpcGateway } from './rpcGateway'
import type { AgentQuotasResponse } from '@hapi/protocol/apiTypes'

/**
 * Engine-level wiring tests for the agent-quota snapshot cache. The backing
 * RPC probes three providers on the runner and is one of the slowest
 * endpoints the hub serves (observed 3-6s healthy, 170+ whole-second hits
 * per 24h) while the web usage panel re-fetches on every focus/reconnect,
 * so the engine serves it through the same SessionEnumerationCache
 * treatment as model lists: TTL hits answer without an RPC, stale serves
 * are marked `fresh: false`, an explicit refresh forwards `refresh: true`
 * to the runner under the shared 8s cap, and a failed refresh falls back to
 * the last-good snapshot. The cache semantics themselves (single-flight,
 * stale-while-revalidate, cold cap) are covered by
 * sessionEnumerationCache.test.ts; these tests pin the wiring.
 */
describe('SyncEngine agent-quotas cache', () => {
    interface Harness {
        engine: SyncEngine
        rpcCalls: Array<{ refresh?: boolean } | undefined>
        clock: { now: number }
    }

    /** Distinct payload per fetch so cache hits are distinguishable. */
    const quotaSnapshot = (n: number): AgentQuotasResponse => ({
        accounts: [{
            agent: 'claude',
            available: true,
            status: 'ok',
            buckets: [],
            updatedAt: n
        }],
        fetchedAt: n
    })

    function makeEngine(): Harness {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        const rpcCalls: Array<{ refresh?: boolean } | undefined> = []
        const gateway = engine as unknown as { rpcGateway: RpcGateway }
        gateway.rpcGateway.getAgentQuotas = (async (
            _machineId: string,
            options?: { refresh?: boolean }
        ) => {
            rpcCalls.push(options)
            return quotaSnapshot(rpcCalls.length)
        }) as never as RpcGateway['getAgentQuotas']
        // The engine builds its cache on wall-clock time; swap in a
        // controllable clock so TTL expiry is testable without waiting.
        const clock = { now: 1_000 }
        ;(engine as unknown as { agentQuotasCache: SessionEnumerationCache }).agentQuotasCache =
            new SessionEnumerationCache({ ttlMs: 45_000, fetchTimeoutMs: 8_000, now: () => clock.now })
        return { engine, rpcCalls, clock }
    }

    it('serves repeated quota fetches with a single RPC and leaves fresh responses unmarked', async () => {
        const { engine, rpcCalls } = makeEngine()

        const first = await engine.getAgentQuotas('machine-1')
        const second = await engine.getAgentQuotas('machine-1')

        expect(second).toEqual(first)
        expect(rpcCalls.length).toBe(1)
        expect('fresh' in first).toBe(false)
    })

    it('scopes cache entries per machine', async () => {
        const { engine, rpcCalls } = makeEngine()

        await engine.getAgentQuotas('machine-1')
        await engine.getAgentQuotas('machine-2')

        expect(rpcCalls.length).toBe(2)
    })

    it('shares one in-flight fetch across concurrent cold callers', async () => {
        const { engine, rpcCalls } = makeEngine()

        const [a, b] = await Promise.all([
            engine.getAgentQuotas('machine-1'),
            engine.getAgentQuotas('machine-1')
        ])

        expect(a).toEqual(b)
        expect(rpcCalls.length).toBe(1)
    })

    it('serves a stale snapshot with fresh:false while revalidating in background', async () => {
        const { engine, rpcCalls, clock } = makeEngine()

        await engine.getAgentQuotas('machine-1')
        expect(rpcCalls.length).toBe(1)

        clock.now += 46_000
        const stale = await engine.getAgentQuotas('machine-1')
        // The expired snapshot answers immediately, marked stale, and the
        // revalidation RPC has been issued.
        expect(stale.fetchedAt).toBe(1)
        expect(stale.fresh).toBe(false)
        expect(rpcCalls.length).toBe(2)

        // Once the background revalidation lands, callers see the new value.
        await new Promise((resolve) => setTimeout(resolve, 0))
        clock.now += 1_000
        const refreshed = await engine.getAgentQuotas('machine-1')
        expect(refreshed.fetchedAt).toBe(2)
        expect('fresh' in refreshed).toBe(false)
        expect(rpcCalls.length).toBe(2)
    })

    it('keeps serving the last-good snapshot marked stale while the runner is unreachable', async () => {
        const { engine, rpcCalls, clock } = makeEngine()

        await engine.getAgentQuotas('machine-1')
        const gateway = engine as unknown as { rpcGateway: { getAgentQuotas: unknown } }
        gateway.rpcGateway.getAgentQuotas = (async () => {
            rpcCalls.push({})
            throw new Error('runner offline')
        }) as never

        // Repeated stale hits inside a stuck-offline window: every caller
        // gets the last-good snapshot marked fresh:false; the failing
        // revalidations never replace it and never surface as errors.
        clock.now += 46_000
        const first = await engine.getAgentQuotas('machine-1')
        clock.now += 1_000
        const second = await engine.getAgentQuotas('machine-1')
        expect(first).toEqual({ ...quotaSnapshot(1), fresh: false })
        expect(second).toEqual(first)
        // Let the background rejections settle without an unhandled rejection.
        await new Promise((resolve) => setTimeout(resolve, 0))
    })

    it('bypasses the TTL for an explicit refresh, forwards refresh to the runner, and pins the result', async () => {
        const { engine, rpcCalls } = makeEngine()

        await engine.getAgentQuotas('machine-1')
        expect(rpcCalls.length).toBe(1)

        const refreshed = await engine.getAgentQuotas('machine-1', { refresh: true })
        expect(refreshed.fetchedAt).toBe(2)
        expect('fresh' in refreshed).toBe(false)
        expect(rpcCalls).toEqual([{}, { refresh: true }])

        // The forced fetch repopulated the cache: a plain follow-up inside
        // the TTL window is served without another RPC.
        const pinned = await engine.getAgentQuotas('machine-1')
        expect(pinned.fetchedAt).toBe(2)
        expect(rpcCalls.length).toBe(2)
    })

    it('serves the last-good snapshot marked stale when a refresh hits an unreachable runner', async () => {
        const { engine, rpcCalls } = makeEngine()

        await engine.getAgentQuotas('machine-1')
        const gateway = engine as unknown as { rpcGateway: { getAgentQuotas: unknown } }
        gateway.rpcGateway.getAgentQuotas = (async () => {
            rpcCalls.push({ refresh: true })
            throw new Error('runner offline')
        }) as never

        const stale = await engine.getAgentQuotas('machine-1', { refresh: true })
        expect(stale).toEqual({ ...quotaSnapshot(1), fresh: false })
    })

    it('propagates a refresh failure when no snapshot is cached', async () => {
        const { engine } = makeEngine()
        const gateway = engine as unknown as { rpcGateway: { getAgentQuotas: unknown } }
        gateway.rpcGateway.getAgentQuotas = (async () => {
            throw new Error('runner offline')
        }) as never

        await expect(engine.getAgentQuotas('machine-1', { refresh: true })).rejects.toThrow('runner offline')
    })

    it('propagates cold RPC failures to callers without caching them', async () => {
        const { engine, rpcCalls } = makeEngine()
        const gateway = engine as unknown as { rpcGateway: { getAgentQuotas: unknown } }
        let failing = true
        gateway.rpcGateway.getAgentQuotas = (async () => {
            rpcCalls.push({})
            if (failing) throw new Error('runner offline')
            return quotaSnapshot(1)
        }) as never

        await expect(engine.getAgentQuotas('machine-1')).rejects.toThrow('runner offline')

        failing = false
        const recovered = await engine.getAgentQuotas('machine-1')
        expect(recovered.fetchedAt).toBe(1)
        expect(rpcCalls.length).toBe(2)
    })
})

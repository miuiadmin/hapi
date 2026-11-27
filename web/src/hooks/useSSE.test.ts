import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import type { Session } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { isSubscriptionTornDown, resetSubscriptionLivenessForTests } from '@/lib/sseSubscriptionLiveness'
import {
    applySessionDetailPatch,
    isGlobalScopedMessageStreamEvent,
    isNewerVersionedPatch,
    isRenderIrrelevantPatch,
    isRenderIrrelevantSessionPatch,
    sameSessionSummaryMetadata,
    shouldInvalidateSessionListForEvent,
    useSSE,
    type SseConnectInfo
} from './useSSE'

describe('session summary metadata equality', () => {
    it('detects capability changes that control list actions', () => {
        const base = { path: '/p', host: 'h' }
        expect(sameSessionSummaryMetadata(base, { ...base, conversationHistory: { forkCurrent: true } })).toBe(false)
        expect(sameSessionSummaryMetadata(
            { ...base, conversationHistory: { forkCurrent: true } },
            { ...base, conversationHistory: { forkCurrent: true } },
        )).toBe(true)
    })
})

class FakeEventSource {
    static instances: FakeEventSource[] = []
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    readonly url: string
    readyState = FakeEventSource.CONNECTING
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((error: unknown) => void) | null = null

    constructor(url: string) {
        this.url = url
        FakeEventSource.instances.push(this)
    }

    close(): void {
        this.readyState = FakeEventSource.CLOSED
    }

    simulateOpen(): void {
        this.readyState = FakeEventSource.OPEN
        this.onopen?.()
    }

    simulateMessage(data: unknown): void {
        this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
    }
}

function renderUseSSE(options?: {
    onDisconnect?: (reason: string) => void
    scope?: 'global' | 'full'
}) {
    const queryClient = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children)
    const hook = renderHook(() => useSSE({
        enabled: true,
        token: 'test-token',
        baseUrl: 'http://hub.test',
        subscription: { all: true },
        scope: options?.scope,
        onEvent: () => {},
        onDisconnect: options?.onDisconnect
    }), { wrapper })
    return { ...hook, queryClient }
}

describe('useSSE connection liveness (mobile suspend/resume)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeEventSource.instances = []
        vi.stubGlobal('EventSource', FakeEventSource)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    it('reconnects on visibility resume when a heartbeat interval was missed', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        expect(FakeEventSource.instances).toHaveLength(1)
        act(() => { FakeEventSource.instances[0]?.simulateOpen() })

        // Silence for 50s: above the 45s visibility-resume threshold, below
        // the 60s watchdog threshold (HEARTBEAT_STALE_MS). A resume from
        // background must not trust this connection.
        act(() => { vi.advanceTimersByTime(50_000) })
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })

        expect(onDisconnect).toHaveBeenCalledWith('visibility-recovery')
        expect(FakeEventSource.instances[0]?.readyState).toBe(FakeEventSource.CLOSED)

        // First reconnect attempt is immediate (jitter only)
        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)

        unmount()
    })

    it('keeps a fresh connection on visibility resume', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        act(() => { FakeEventSource.instances[0]?.simulateOpen() })
        act(() => { vi.advanceTimersByTime(20_000) })
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })

        expect(onDisconnect).not.toHaveBeenCalled()
        expect(FakeEventSource.instances).toHaveLength(1)

        unmount()
    })

    it('abandons a connection attempt that does not open in time', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        expect(FakeEventSource.instances).toHaveLength(1)
        // never opens (e.g. request hung on a dead pooled socket)
        act(() => { vi.advanceTimersByTime(10_100) })

        expect(onDisconnect).toHaveBeenCalledWith('connect-timeout')
        expect(FakeEventSource.instances[0]?.readyState).toBe(FakeEventSource.CLOSED)

        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)

        unmount()
    })

    it('does not time out a connection that opens promptly', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        act(() => { FakeEventSource.instances[0]?.simulateOpen() })
        act(() => { vi.advanceTimersByTime(30_000) })

        expect(onDisconnect).not.toHaveBeenCalled()
        expect(FakeEventSource.instances).toHaveLength(1)

        unmount()
    })

    it('abandons a hung reconnect attempt even after a prior reconnect request', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        act(() => { FakeEventSource.instances[0]?.simulateOpen() })
        // First cycle: transport error while the source is up routes through
        // requestReconnect, which is one-shot per EventSource instance.
        act(() => { FakeEventSource.instances[0]?.onerror?.({}) })
        expect(onDisconnect).toHaveBeenCalledWith('transport-error')

        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)

        // Second cycle never opens — the connect deadline must still fire
        // (force path) instead of being swallowed by the one-shot guard.
        act(() => { vi.advanceTimersByTime(10_100) })
        expect(onDisconnect).toHaveBeenCalledWith('connect-timeout')
        expect(FakeEventSource.instances[1]?.readyState).toBe(FakeEventSource.CLOSED)

        unmount()
    })
})

describe('useSSE visibility-recovery REST discipline (wake load)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeEventSource.instances = []
        vi.stubGlobal('EventSource', FakeEventSource)
        resetSubscriptionLivenessForTests()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    function handshake(source: FakeEventSource, subscriptionId: string, resume: 'ok' | 'gap') {
        act(() => { source.simulateOpen() })
        act(() => {
            source.simulateMessage({
                type: 'connection-changed',
                data: { status: 'open', subscriptionId, resume }
            })
        })
    }

    /** Wake the tab past the 45s resume-staleness threshold: the common
     * mobile-PWA resume path that used to fire REST invalidations up front. */
    function wakeStale() {
        act(() => { vi.advanceTimersByTime(50_000) })
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    }

    it('skips preemptive invalidation when the resume handshake replays the gap', () => {
        const onDisconnect = vi.fn()
        const { queryClient, result, unmount } = renderUseSSE({ onDisconnect })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

        handshake(FakeEventSource.instances[0]!, 'sub-1', 'ok')
        expect(result.current.subscriptionId).toBe('sub-1')
        // The connection URL declared the (jsdom-default) visible state, so
        // the hub already applies it for this subscription.
        expect(result.current.subscriptionVisibility).toBe('visible')

        wakeStale()
        expect(onDisconnect).toHaveBeenCalledWith('visibility-recovery')
        // Before this change the wake fired sessions+machines invalidations
        // immediately, duplicating what the replay delivers.
        expect(invalidate).not.toHaveBeenCalled()

        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)
        handshake(FakeEventSource.instances[1]!, 'sub-2', 'ok')
        expect(result.current.subscriptionId).toBe('sub-2')

        // The handshake disarmed the delayed REST fallback: zero invalidations
        // across the whole wake when the hub replayed the gap.
        act(() => { vi.advanceTimersByTime(10_000) })
        expect(invalidate).not.toHaveBeenCalled()

        unmount()
    })

    it('falls back to REST invalidations when the handshake never lands', () => {
        const { queryClient, unmount } = renderUseSSE()
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

        handshake(FakeEventSource.instances[0]!, 'sub-1', 'ok')
        wakeStale()

        // Reconnect opens the socket but the hub never handshakes (pooled
        // black hole). The fallback fires 5s after the wake — sessions and
        // machines, the old up-front freshness floor, now only on demand.
        act(() => { vi.advanceTimersByTime(600) })
        const second = FakeEventSource.instances[1]!
        act(() => { second.simulateOpen() })
        expect(invalidate).not.toHaveBeenCalled()

        act(() => { vi.advanceTimersByTime(5_000) })
        expect(invalidate).toHaveBeenCalledTimes(2)
        expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.machines })

        unmount()
    })

    it('keeps the machines freshness floor when the handshake verdict is a gap', () => {
        const { queryClient, unmount } = renderUseSSE()
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

        handshake(FakeEventSource.instances[0]!, 'sub-1', 'ok')
        wakeStale()

        act(() => { vi.advanceTimersByTime(600) })
        handshake(FakeEventSource.instances[1]!, 'sub-2', 'gap')

        // Sessions/details are App's onConnect resync's job; machines is not
        // covered there and the gap verdict means replay did not cover it
        // either — exactly one machines invalidation, no sessions duplicate.
        expect(invalidate).toHaveBeenCalledTimes(1)
        expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.machines })

        act(() => { vi.advanceTimersByTime(10_000) })
        expect(invalidate).toHaveBeenCalledTimes(1)

        unmount()
    })

    it('marks the dying subscription torn down and revives the replacement', () => {
        const { unmount } = renderUseSSE()

        handshake(FakeEventSource.instances[0]!, 'sub-1', 'ok')
        expect(isSubscriptionTornDown('sub-1')).toBe(false)

        wakeStale()
        // requestReconnect closed the socket synchronously; the visibility
        // reporter must be able to see the subscription is already dead.
        expect(isSubscriptionTornDown('sub-1')).toBe(true)

        act(() => { vi.advanceTimersByTime(600) })
        handshake(FakeEventSource.instances[1]!, 'sub-2', 'ok')
        expect(isSubscriptionTornDown('sub-2')).toBe(false)
        expect(isSubscriptionTornDown('sub-1')).toBe(true)

        unmount()
    })
})

describe('useSSE scratchlist status invalidation', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeEventSource.instances = []
        vi.stubGlobal('EventSource', FakeEventSource)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    it.each(['global', 'full'] as const)('refetches the tasks (and, by prefix, their history) and the session list on session-tasks-changed under scope %s', (scope) => {
        const { unmount, queryClient } = renderUseSSE({ scope })
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)

        act(() => {
            FakeEventSource.instances[0]?.simulateMessage({ type: 'session-tasks-changed', sessionId: 'session-1' })
            vi.advanceTimersByTime(20)
        })

        // The tasks key covers the run history, which is keyed under it.
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.sessionTasks('session-1') })
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.sessions })
        expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: queryKeys.session('session-1') })
        unmount()
    })

    it('keeps a session row\'s task count and next run when a full session record arrives without them', () => {
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({ id: 'session-1', activeTaskCount: 2, nextTaskRunAt: 123_456 })] })
        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: {
                ...makeSummary({ activeTaskCount: 0, nextTaskRunAt: null }), id: 'session-1', namespace: 'default', seq: 1,
                createdAt: 1, agentState: null, thinkingAt: 0
            }
        }))
        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]).toMatchObject({ activeTaskCount: 2, nextTaskRunAt: 123_456 })
        unmount()
    })

    it('invalidates both the session scratchlist and batch status queries', () => {
        const { unmount, queryClient } = renderUseSSE()
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)

        act(() => {
            FakeEventSource.instances[0]?.simulateMessage({
                type: 'session-updated',
                sessionId: 'session-1',
                data: { scratchlistUpdatedAt: 1234 }
            })
            vi.advanceTimersByTime(20)
        })

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.scratchlist('session-1') })
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.scratchlistSessionIds })
        unmount()
    })
})

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        activeTaskCount: 0,
        nextTaskRunAt: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides
    } as SessionSummary
}

describe('isNewerVersionedPatch (PR #897 review, HAPI Bot 2026-06-16 Major)', () => {
    // Pin the version-monotonicity contract for structured metadata /
    // agentState patches. Without this gate, an SSE reconnect that replays
    // a buffered older patch after a fresh REST refetch would regress the
    // cache (e.g. drop a newer resume id / pending request). Mirrors the
    // hub's CLI room handler check (`incoming.version > currentVersion`).
    it('accepts a strictly newer patch', () => {
        expect(isNewerVersionedPatch(5, 4)).toBe(true)
    })

    it('rejects an older patch (the bug case: stale buffered patch on reconnect)', () => {
        expect(isNewerVersionedPatch(4, 5)).toBe(false)
    })

    it('rejects a same-version patch (idempotent / duplicate replay)', () => {
        expect(isNewerVersionedPatch(5, 5)).toBe(false)
    })

    it('accepts the first write into a freshly-cached session (currentVersion=0)', () => {
        expect(isNewerVersionedPatch(1, 0)).toBe(true)
    })
})

describe('useSSE scope handling', () => {
    it('refreshes the session list for a task change on every connection scope, and only there besides ownership', () => {
        expect(shouldInvalidateSessionListForEvent('global', 'session-tasks-changed')).toBe(true)
        expect(shouldInvalidateSessionListForEvent('full', 'session-tasks-changed')).toBe(true)
        expect(shouldInvalidateSessionListForEvent('global', 'messages-invalidated')).toBe(true)
        expect(shouldInvalidateSessionListForEvent('full', 'messages-invalidated')).toBe(false)
        expect(shouldInvalidateSessionListForEvent('global', 'session-updated')).toBe(false)
    })

    it('invalidates the global session list when message ownership changes', () => {
        expect(shouldInvalidateSessionListForEvent('global', 'messages-invalidated')).toBe(true)
        expect(shouldInvalidateSessionListForEvent('full', 'messages-invalidated')).toBe(false)
    })

    it('treats message stream events as global-scoped skips', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'message-received')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'messages-consumed')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'message-cancelled')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'scheduled-matured')).toBe(true)
    })

    it('does not skip session lifecycle events on the global connection', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'session-updated')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-added')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-removed')).toBe(false)
    })

    it('processes message stream events on full-scoped connections', () => {
        expect(isGlobalScopedMessageStreamEvent('full', 'message-received')).toBe(false)
    })
})

describe('isRenderIrrelevantPatch', () => {
    it('treats a keep-alive that only moves activeAt as irrelevant', () => {
        const current = makeSummary({ activeAt: 1_000 })
        const next = makeSummary({ activeAt: 11_000 })

        expect(isRenderIrrelevantPatch(current, next)).toBe(true)
    })

    it('treats an identical summary as irrelevant', () => {
        expect(isRenderIrrelevantPatch(makeSummary(), makeSummary())).toBe(true)
    })

    it('does not throw when the slim projection omitted the pending fields on both sides', () => {
        // Regression: the slim list projection deletes empty pendingRequestKinds/
        // pendingRequests (typed required, omitted on the wire), and the bare
        // `.length` compare threw a TypeError as an unhandled rejection on every
        // keep-alive patch of a slim list entry (telemetry fingerprint
        // TypeError:bf50c0bb, caught live 2026-11-20).
        const strip = (s: SessionSummary): SessionSummary => {
            const copy = { ...s } as Partial<SessionSummary>
            delete copy.pendingRequestKinds
            delete copy.pendingRequests
            return copy as SessionSummary
        }
        const current = strip(makeSummary({ activeAt: 1_000 }))
        const next = strip(makeSummary({ activeAt: 11_000 }))

        expect(() => isRenderIrrelevantPatch(current, next)).not.toThrow()
        expect(isRenderIrrelevantPatch(current, next)).toBe(true)
    })

    it('reports pending fields appearing (absent → present) as relevant', () => {
        const current = makeSummary({ activeAt: 1_000 })
        delete (current as Partial<SessionSummary>).pendingRequestKinds
        const next = makeSummary({ activeAt: 11_000, pendingRequestKinds: [] })

        expect(isRenderIrrelevantPatch(current, next)).toBe(false)
    })

    it.each([
        ['active', { active: false }],
        ['thinking', { thinking: true }],
        ['updatedAt', { updatedAt: 9_999 }],
        ['backgroundTaskCount', { backgroundTaskCount: 3 }],
        ['model', { model: 'opus' }],
        ['modelReasoningEffort', { modelReasoningEffort: 'high' }],
        ['effort', { effort: 'medium' }],
        ['pendingRequestsCount', { pendingRequestsCount: 2 }],
        ['metadata.path', { metadata: { path: '/other', name: undefined } }],
        ['metadata.flavor', { metadata: { path: '/tmp', flavor: 'claude' as const } }],
        ['metadata.machineId', { metadata: { path: '/tmp', machineId: 'Teemo' } }],
        ['metadata.worktree.branch', {
            metadata: {
                path: '/tmp',
                worktree: {
                    basePath: '/tmp',
                    branch: 'feat/x',
                    name: 'x',
                    worktreePath: '/tmp/x'
                }
            }
        }]
    ] as Array<[string, Partial<SessionSummary>]>)('reports %s changes as relevant', (_field, change) => {
        const current = makeSummary()
        const next = makeSummary({ ...change, activeAt: 11_000 })

        expect(isRenderIrrelevantPatch(current, next)).toBe(false)
    })

    it('reports attachedJob.startedAt changes as relevant', () => {
        const job = {
            key: 'beets',
            label: 'beets',
            status: 'running' as const,
            heartbeatAt: 100,
            startedAt: 100,
            updatedAt: 100
        }
        const current = makeSummary({ attachedJob: job })
        const next = makeSummary({
            attachedJob: { ...job, startedAt: 50 },
            activeAt: 11_000
        })
        expect(isRenderIrrelevantPatch(current, next)).toBe(false)
    })
})

describe('isRenderIrrelevantSessionPatch', () => {
    const session = {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
        model: 'opus',
        effort: null,
        permissionMode: 'default',
        serviceTier: null
    } as unknown as Session

    it('treats a sub-minute activeAt keep-alive as irrelevant', () => {
        // Relative age stays in the `just now` bucket until 60s; accepting
        // every ~10s heartbeat would thrash the full chat tree for no visible change.
        expect(isRenderIrrelevantSessionPatch(session, {
            active: true,
            thinking: false,
            activeAt: 11_000,
            model: 'opus',
            effort: null,
            permissionMode: 'default',
            serviceTier: null
        })).toBe(true)
    })

    it('treats an activeAt move of at least one minute as render-relevant', () => {
        // Live sessions need the cached stamp to advance so the header does
        // not flip from `just now` to `1m ago` while keep-alives continue.
        expect(isRenderIrrelevantSessionPatch(session, {
            active: true,
            thinking: false,
            activeAt: 1_000 + 60_000,
            model: 'opus',
            effort: null,
            permissionMode: 'default',
            serviceTier: null
        })).toBe(false)
    })

    it('reports a changed field as relevant even alongside a new activeAt', () => {
        expect(isRenderIrrelevantSessionPatch(session, {
            thinking: true,
            activeAt: 11_000
        })).toBe(false)
    })

    it('reports a field the session does not carry yet as relevant', () => {
        // scratchlistUpdatedAt is absent from the cached session, so the patch
        // genuinely adds information and must not be dropped.
        expect(isRenderIrrelevantSessionPatch(session, {
            activeAt: 11_000,
            scratchlistUpdatedAt: 5_000
        })).toBe(false)
    })

    it('treats an empty patch as irrelevant', () => {
        expect(isRenderIrrelevantSessionPatch(session, {})).toBe(true)
    })
})

describe('applySessionDetailPatch (PR #897 review, Copilot keep-alive)', () => {
    const session = {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
        model: 'gpt-5',
        effort: null,
        permissionMode: 'default',
        collaborationMode: undefined,
        copilotAgentMode: 'interactive',
        serviceTier: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        todosUpdatedAt: 0,
        teamStateUpdatedAt: 0
    } as unknown as Session

    it('applies a copilotAgentMode keep-alive change to the detail session', () => {
        // Hub emits copilotAgentMode from markSessionActive keep-alives. The
        // field-by-field mapper must copy it — otherwise detailPatched=true
        // suppresses invalidation and SessionChat keeps the stale mode.
        const next = applySessionDetailPatch(session, {
            active: true,
            thinking: false,
            activeAt: 11_000,
            copilotAgentMode: 'plan'
        })
        expect(next).not.toBeNull()
        expect(next?.copilotAgentMode).toBe('plan')
        expect(next?.activeAt).toBe(11_000)
    })

    it('returns null for a keep-alive that only repeats the current Copilot mode', () => {
        expect(applySessionDetailPatch(session, {
            active: true,
            thinking: false,
            activeAt: 11_000,
            copilotAgentMode: 'interactive'
        })).toBeNull()
    })
})

describe('useSSE user-activity ordering', () => {
    beforeEach(() => {
        FakeEventSource.instances = []
        vi.stubGlobal('EventSource', FakeEventSource)
    })
    afterEach(() => vi.unstubAllGlobals())

    it('ignores agent/status updates, promotes new input, and rejects stale replay', () => {
        const { queryClient, unmount } = renderUseSSE()
        const sessions = [
            makeSummary({ id: 'new', createdAt: 3_000, lastUserMessageAt: 8_000 }),
            makeSummary({ id: 'old', createdAt: 1_000, lastUserMessageAt: 5_000 })
        ]
        queryClient.setQueryData(queryKeys.sessions, { sessions })
        const patch = (sessionId: string, data: Record<string, unknown>) => act(() => {
            FakeEventSource.instances[0]?.simulateMessage({ type: 'session-updated', sessionId, data })
        })
        const read = () => queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)!.sessions
        for (let i = 0; i < 10; i++) {
            patch('old', { updatedAt: 90_000 + i, thinking: true, active: true })
            patch('new', { updatedAt: 100_000 + i, thinking: false, active: false })
            expect(read().map(s => s.id)).toEqual(['new', 'old'])
        }
        patch('old', { lastUserMessageAt: 200_000 })
        expect(read().map(s => s.id)).toEqual(['old', 'new'])
        patch('old', { lastUserMessageAt: 4_000 })
        expect(read()[0]!.lastUserMessageAt).toBe(200_000)
        expect(read().map(s => s.id)).toEqual(['old', 'new'])
        unmount()
    })

    it('preserves the user timestamp through a stale full-session event', () => {
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({ id: 'session-1', lastUserMessageAt: 9_000 })] })
        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: {
                ...makeSummary(), id: 'session-1', namespace: 'default', seq: 1,
                createdAt: 1, agentState: null, thinkingAt: 0, lastUserMessageAt: 1_000
            }
        }))
        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]?.lastUserMessageAt).toBe(9_000)
        unmount()
    })
})

describe('useSSE handshake info', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeEventSource.instances = []
        vi.stubGlobal('EventSource', FakeEventSource)
        resetSubscriptionLivenessForTests()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    function handshake(source: FakeEventSource, subscriptionId: string, resume: 'ok' | 'gap') {
        act(() => { source.simulateOpen() })
        act(() => {
            source.simulateMessage({
                type: 'connection-changed',
                data: { status: 'open', subscriptionId, resume }
            })
        })
    }

    /** A session-scoped stream for `sessionId`, reporting every handshake to `onConnect`. */
    function renderSessionStream(sessionId: string, onConnect: (info: SseConnectInfo) => void) {
        const queryClient = new QueryClient()
        const wrapper = ({ children }: { children: ReactNode }) =>
            createElement(QueryClientProvider, { client: queryClient }, children)
        return renderHook(({ current }: { current: string }) => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { sessionId: current },
            scope: 'full',
            onEvent: () => {},
            onConnect
        }), { wrapper, initialProps: { current: sessionId } })
    }

    it('a session\'s first handshake is initial and names the session', () => {
        const connects: SseConnectInfo[] = []
        const { unmount } = renderSessionStream('s-a', (info) => connects.push(info))

        handshake(FakeEventSource.instances[0]!, 'sub-1', 'gap')
        expect(connects).toEqual([{ resumed: false, initial: true, sessionId: 's-a' }])

        // A replayed gap reads as resumed.
        handshake(FakeEventSource.instances[0]!, 'sub-2', 'ok')
        expect(connects[1]).toEqual({ resumed: true, initial: true, sessionId: 's-a' })
        unmount()
    })

    it('a connection that dropped and came back is not initial', () => {
        const connects: SseConnectInfo[] = []
        const { unmount } = renderSessionStream('s-a', (info) => connects.push(info))
        const first = FakeEventSource.instances[0]!
        handshake(first, 'sub-1', 'gap')

        act(() => { first.onerror?.({}) })
        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)
        handshake(FakeEventSource.instances[1]!, 'sub-2', 'gap')

        expect(connects).toEqual([
            { resumed: false, initial: true, sessionId: 's-a' },
            { resumed: false, initial: false, sessionId: 's-a' }
        ])
        unmount()
    })

    it('a session selected again after another one starts over as initial', () => {
        const connects: SseConnectInfo[] = []
        const { rerender, unmount } = renderSessionStream('s-a', (info) => connects.push(info))
        handshake(FakeEventSource.instances[0]!, 'sub-1', 'gap')

        rerender({ current: 's-b' })
        expect(FakeEventSource.instances).toHaveLength(2)
        handshake(FakeEventSource.instances[1]!, 'sub-2', 'gap')

        rerender({ current: 's-a' })
        expect(FakeEventSource.instances).toHaveLength(3)
        handshake(FakeEventSource.instances[2]!, 'sub-3', 'gap')

        expect(connects).toEqual([
            { resumed: false, initial: true, sessionId: 's-a' },
            { resumed: false, initial: true, sessionId: 's-b' },
            { resumed: false, initial: true, sessionId: 's-a' }
        ])
        unmount()
    })

    it('the global stream carries no session', () => {
        const connects: SseConnectInfo[] = []
        const queryClient = new QueryClient()
        const wrapper = ({ children }: { children: ReactNode }) =>
            createElement(QueryClientProvider, { client: queryClient }, children)
        const global = renderHook(() => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            onEvent: () => {},
            onConnect: (info) => connects.push(info)
        }), { wrapper })
        handshake(FakeEventSource.instances[0]!, 'sub-g', 'gap')
        expect(connects).toEqual([{ resumed: false, initial: true, sessionId: null }])
        global.unmount()
    })

    it('a handshake that lands after its subscription was left is not reported', () => {
        const connects: SseConnectInfo[] = []
        const { rerender, unmount } = renderSessionStream('s-a', (info) => connects.push(info))
        const leftBehind = FakeEventSource.instances[0]!

        // The user switches to s-b; s-a's source is closed on the way out,
        // but its handshake was already queued for dispatch.
        rerender({ current: 's-b' })
        act(() => {
            leftBehind.simulateMessage({
                type: 'connection-changed',
                data: { status: 'open', subscriptionId: 'sub-a', resume: 'gap' }
            })
        })
        expect(connects).toEqual([])

        handshake(FakeEventSource.instances[1]!, 'sub-b', 'gap')
        expect(connects).toEqual([{ resumed: false, initial: true, sessionId: 's-b' }])
        unmount()
    })

    it('a subscription set up again after the stream was disabled is initial', () => {
        const connects: SseConnectInfo[] = []
        const queryClient = new QueryClient()
        const wrapper = ({ children }: { children: ReactNode }) =>
            createElement(QueryClientProvider, { client: queryClient }, children)
        const hook = renderHook(({ enabled }: { enabled: boolean }) => useSSE({
            enabled,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { sessionId: 's-a' },
            onEvent: () => {},
            onConnect: (info) => connects.push(info)
        }), { wrapper, initialProps: { enabled: true } })
        handshake(FakeEventSource.instances[0]!, 'sub-1', 'gap')

        hook.rerender({ enabled: false })
        expect(FakeEventSource.instances).toHaveLength(1)
        hook.rerender({ enabled: true })
        expect(FakeEventSource.instances).toHaveLength(2)
        handshake(FakeEventSource.instances[1]!, 'sub-2', 'gap')

        expect(connects).toEqual([
            { resumed: false, initial: true, sessionId: 's-a' },
            { resumed: false, initial: true, sessionId: 's-a' }
        ])
        hook.unmount()
    })
})

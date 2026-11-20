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
    canApplyVersionedSummaryPatch,
    isGlobalScopedMessageStreamEvent,
    isNewerVersionedPatch,
    isRenderIrrelevantPatch,
    isRenderIrrelevantSessionPatch,
    sameSessionSummaryMetadata,
    shouldInvalidateSessionListForEvent,
    useSSE
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
}) {
    const queryClient = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children)
    const hook = renderHook(() => useSSE({
        enabled: true,
        token: 'test-token',
        baseUrl: 'http://hub.test',
        subscription: { all: true },
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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides
    } as SessionSummary
}

describe('canApplyVersionedSummaryPatch (PR #897 review, HAPI Bot 2026-07-23 Major)', () => {
    it('allows non-versioned patches without a detail cache', () => {
        expect(canApplyVersionedSummaryPatch({}, false)).toBe(true)
        expect(canApplyVersionedSummaryPatch({ metadata: undefined, agentState: undefined }, false)).toBe(true)
    })

    it('refuses metadata/agentState/todos summary patches when detail version source is missing', () => {
        expect(
            canApplyVersionedSummaryPatch(
                { metadata: { version: 1, value: null } },
                false
            )
        ).toBe(false)
        expect(
            canApplyVersionedSummaryPatch(
                { agentState: { version: 1, value: null } },
                false
            )
        ).toBe(false)
        expect(
            canApplyVersionedSummaryPatch(
                { todos: { version: 1, value: [] } },
                false
            )
        ).toBe(false)
    })

    it('allows teamState-only patches without detail (summary no-op)', () => {
        expect(
            canApplyVersionedSummaryPatch(
                { teamState: { version: 1, value: null } },
                false
            )
        ).toBe(true)
    })

    it('allows versioned summary patches when detail is present', () => {
        expect(
            canApplyVersionedSummaryPatch(
                { metadata: { version: 2, value: null } },
                true
            )
        ).toBe(true)
        expect(
            canApplyVersionedSummaryPatch(
                { todos: { version: 2, value: [] } },
                true
            )
        ).toBe(true)
    })
})

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { clearMessageWindow, getMessageWindowState, recoverWindowAfterGapResume } from '@/lib/message-window-store'
import { SESSION_OPEN_TRACE_SETTLE_GRACE_MS, noteSessionOpenStreamJoined, resetSessionOpenTrace } from '@/lib/sessionOpenTrace'
import { useMessages } from './useMessages'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn(), getLevel: vi.fn(() => 1) },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const captureMock = vi.mocked(telemetryClient.capture)
const getLevelMock = vi.mocked(telemetryClient.getLevel)

function agentMessage(id: string, seq: number, at: number): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: { type: 'codex', data: { type: 'reasoning', message: id, id: `stream-${id}` } }
        },
        createdAt: at,
        invokedAt: at
    } as DecryptedMessage
}

function latestResponse(messages: DecryptedMessage[], epoch = 1): MessagesResponse {
    return {
        messages,
        page: {
            direction: 'latest',
            limit: 200,
            epoch,
            reset: false,
            nextBeforeAt: null,
            nextBeforeSeq: null,
            nextAfterAt: null,
            nextAfterSeq: null,
            snapshotHeadAt: null,
            snapshotHeadSeq: null,
            hasMore: false
        }
    }
}

function makeApi(handler: ApiClient['getMessages']): ApiClient {
    return { getMessages: handler, getMessageContext: async () => null } as unknown as ApiClient
}

function eventsOf(kind: string): Array<Record<string, unknown>> {
    return captureMock.mock.calls.filter((call) => call[1] === kind).map((call) => call[2])
}

function expectSchemaValid(kind: string, data: unknown): void {
    const spec = TELEMETRY_KINDS[kind]
    expect(spec, `kind ${kind} must be registered`).toBeDefined()
    const parsed = spec!.data.safeParse(data)
    if (!parsed.success) {
        throw new Error(`schema violation for ${kind}: ${JSON.stringify(parsed.error.issues)}`)
    }
}

/** A persisted v3 window with one cached row, the shape the store hydrates on re-entry. */
function cacheWindow(sessionId: string): void {
    localStorage.setItem(`hapi:message-window:v3:${sessionId}`, JSON.stringify({
        messages: [agentMessage('cached', 1, 1_000)],
        hasMore: true,
        oldestPositionAt: 900,
        oldestPositionSeq: 0,
        newestPositionAt: 1_000,
        newestPositionSeq: 1,
        contextNewestAt: null,
        contextNewestSeq: null,
        epoch: 1,
        requiresLatestReset: false,
    }))
}

/** One entry of the browser's Resource Timing for a request of this session. */
function timing(name: string, start: number, end: number, extra: Record<string, number> = {}): PerformanceResourceTiming {
    return {
        name,
        entryType: 'resource',
        startTime: start,
        duration: end - start,
        requestStart: start,
        responseStart: start + (end - start) / 2,
        responseEnd: end,
        transferSize: 1_300,
        encodedBodySize: 1_200,
        decodedBodySize: 9_000,
        responseStatus: 200,
        ...extra
    } as unknown as PerformanceResourceTiming
}

let sessionIdCounter = 0
let sessionId: string

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
    // One presented frame every 16ms of fake time: a row committed now is on
    // screen after the frame that follows.
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
        setTimeout(() => callback(performance.now()), 16)
    })
    captureMock.mockClear()
    getLevelMock.mockReturnValue(1)
    localStorage.clear()
    sessionIdCounter += 1
    sessionId = `telemetry-use-messages-${sessionIdCounter}`
})

afterEach(() => {
    cleanup()
    clearMessageWindow(sessionId)
    localStorage.clear()
    sessionStorage.clear()
    resetSessionOpenTrace()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('useMessages telemetry', () => {
    it('data_loaded on cold open: cacheHitOnActivate=false + messageCountAfterSync', async () => {
        const api = makeApi(async () => latestResponse([agentMessage('m1', 1, 1_000)]))
        const { result } = renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(400)
        })

        expect(result.current.messages).toHaveLength(1)
        const loaded = eventsOf('data_loaded')
        expect(loaded).toHaveLength(1)
        expect(loaded[0]).toMatchObject({ cacheHitOnActivate: false, messageCountAfterSync: 1 })
        expect(typeof loaded[0]!.settledAt).toBe('number')
        expectSchemaValid('data_loaded', loaded[0])
    })

    it('data_loaded on cached re-entry: cacheHitOnActivate=true (v3 window direct read)', async () => {
        cacheWindow(sessionId)
        const api = makeApi(async () => latestResponse([agentMessage('fresh', 2, 2_000)]))

        const { result } = renderHook(() => useMessages(api, sessionId))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400)
        })

        const loaded = eventsOf('data_loaded')
        expect(loaded).toHaveLength(1)
        expect(loaded[0]).toMatchObject({ cacheHitOnActivate: true })
        expect(result.current.messages.length).toBeGreaterThan(0)
        expectSchemaValid('data_loaded', loaded[0])
    })

    it('load_slow fires for the tail-sync phase past 5s (session-detail also crossed)', async () => {
        const api = makeApi(() => new Promise((resolve) => {
            setTimeout(() => resolve(latestResponse([agentMessage('m1', 1, 1_000)])), 5_500)
        }))
        renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(6_200)
        })

        const slow = eventsOf('load_slow')
        const tailSync = slow.filter((e) => e.phase === 'tail-sync')
        expect(tailSync).toHaveLength(1)
        expect(tailSync[0]).toMatchObject({ durationMs: 5_500, fromCache: false })
        expectSchemaValid('load_slow', tailSync[0])
        // a 5.5s cold open also crosses the 3s session-detail budget — both
        // phases legitimately report
        const sessionDetail = slow.filter((e) => e.phase === 'session-detail')
        expect(sessionDetail).toHaveLength(1)
        expectSchemaValid('load_slow', sessionDetail[0])
        // data_loaded still settles
        expect(eventsOf('data_loaded')).toHaveLength(1)
    })

    it('load_slow fires for the session-detail phase between 3s and 5s', async () => {
        const api = makeApi(() => new Promise((resolve) => {
            setTimeout(() => resolve(latestResponse([agentMessage('m1', 1, 1_000)])), 3_500)
        }))
        renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(4_200)
        })

        const slow = eventsOf('load_slow')
        expect(slow).toHaveLength(1)
        expect(slow[0]).toMatchObject({ phase: 'session-detail', durationMs: 3_500, fromCache: false })
        expectSchemaValid('load_slow', slow[0])
    })

    it('level 0 (telemetry off): the session-detail observation never starts a poll interval', async () => {
        getLevelMock.mockReturnValue(0)
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
        const api = makeApi(async () => latestResponse([agentMessage('m1', 1, 1_000)]))
        renderHook(() => useMessages(api, sessionId))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000)
        })
        expect(setIntervalSpy).not.toHaveBeenCalled()
        setIntervalSpy.mockRestore()
    })

    it('confirmed-empty session: the poll stops after the sync settles with zero messages', async () => {
        const api = makeApi(async () => latestResponse([]))
        renderHook(() => useMessages(api, sessionId))
        // The open timeline waits for the session's event stream; it has joined.
        act(() => { noteSessionOpenStreamJoined(sessionId) })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_OPEN_TRACE_SETTLE_GRACE_MS + 600)
        })
        // no session-detail metric fires for an empty window, and the poll
        // has torn itself down (no pending timers left behind)
        expect(eventsOf('load_slow')).toHaveLength(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('session_open_trace on a cold open: when the first row was on screen, when the tail settled, and the legs it took', async () => {
        vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
            timing(`/api/sessions/${sessionId}`, 2, 40, { transferSize: 900, encodedBodySize: 800, decodedBodySize: 5_200 }),
            timing(`/api/sessions/${sessionId}/messages?limit=20&minConversation=1`, 10, 230, { transferSize: 12_300, encodedBodySize: 12_000, decodedBodySize: 90_000 })
        ] as never)
        // The page lands 100ms after the tap.
        const api = makeApi(() => new Promise((resolve) => {
            setTimeout(() => resolve(latestResponse([agentMessage('m1', 1, 1_000), agentMessage('m2', 2, 1_100)])), 100)
        }))
        const { result } = renderHook(() => useMessages(api, sessionId))

        // React commits the rows when this scope closes, at 100ms; the frame callbacks follow.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100)
        })
        act(() => { noteSessionOpenStreamJoined(sessionId) })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_OPEN_TRACE_SETTLE_GRACE_MS - 100)
        })
        expect(result.current.messages).toHaveLength(2)
        // The rows are in; the timeline keeps watching for a gap recovery that may follow the first page.
        expect(eventsOf('session_open_trace')).toHaveLength(0)

        await act(async () => {
            await vi.advanceTimersByTimeAsync(400)
        })
        const traces = eventsOf('session_open_trace')
        expect(traces).toHaveLength(1)
        expect(traces[0]).toMatchObject({
            entry: 'open',
            outcome: 'settled',
            fromCache: false,
            // The page landed and the rows committed at 100; they are on screen after the frame that follows (2 × 16ms).
            firstRowMs: 132,
            settledMs: 100,
            rowCount: 2,
            requestCount: 2,
            wireBytes: 13_200,
            decodedBytes: 95_200
        })
        expect(typeof traces[0]!.openedAt).toBe('number')
        expect(traces[0]!.requests).toEqual([
            { kind: 'detail', startMs: 2, ttfbMs: 19, totalMs: 38, wireBytes: 900, decodedBytes: 5_200, status: 200 },
            { kind: 'latest', startMs: 10, ttfbMs: 110, totalMs: 220, wireBytes: 12_300, decodedBytes: 90_000, status: 200, rows: 2 }
        ])
        expectSchemaValid('session_open_trace', traces[0])
    })

    it('session_open_trace on cached re-entry: fromCache, with the first row on screen at once', async () => {
        cacheWindow(sessionId)
        vi.spyOn(performance, 'getEntriesByType').mockReturnValue([] as never)
        const api = makeApi(async () => latestResponse([agentMessage('cached', 1, 1_000), agentMessage('fresh', 2, 2_000)]))
        const { result } = renderHook(() => useMessages(api, sessionId))
        act(() => { noteSessionOpenStreamJoined(sessionId) })

        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_OPEN_TRACE_SETTLE_GRACE_MS + 100)
        })

        const traces = eventsOf('session_open_trace')
        expect(traces).toHaveLength(1)
        expect(traces[0]).toMatchObject({ outcome: 'settled', fromCache: true, firstRowMs: 32 })
        expect(result.current.messages.length).toBeGreaterThan(0)
        expectSchemaValid('session_open_trace', traces[0])
    })

    /**
     * A cached window (row seq 1) that fell far behind: the fresh 20-row page (seq 32-51)
     * does not reach it, so the first sync arms a gap recovery. The recovery then
     * catches up from the cached cursor (seq 2-31) and reconciles the newest page.
     */
    function gapApi(): ApiClient {
        const rows = (from: number, to: number) => (
            Array.from({ length: to - from + 1 }, (_, index) => agentMessage(`r${from + index}`, from + index, (from + index) * 100))
        )
        const page = (messages: DecryptedMessage[], fields: Partial<MessagesResponse['page']>): MessagesResponse => (
            { messages, page: { ...latestResponse([]).page, ...fields } }
        )
        const tail = () => page(rows(32, 51), { hasMore: true, nextBeforeAt: 3_100, nextBeforeSeq: 31 })
        const getMessages = vi.fn(async (_sessionId: string, query: { afterAt?: number | null; afterSeq?: number | null; limit?: number }) => {
            if (query.afterAt !== undefined && query.afterAt !== null) {
                return page(rows(2, 31), {
                    direction: 'after', nextAfterAt: 3_100, nextAfterSeq: 31, snapshotHeadAt: 5_100, snapshotHeadSeq: 51
                })
            }
            return tail()
        })
        return makeApi(getMessages)
    }

    it('session_open_trace waits for the gap recovery and records the whole open: first page, catch-up, reconcile', async () => {
        cacheWindow(sessionId)
        vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
            timing(`/api/sessions/${sessionId}/messages?limit=20`, 10, 60),
            timing(`/api/sessions/${sessionId}/messages?afterAt=1000&afterSeq=1&epoch=1&limit=200`, 70, 120),
            timing(`/api/sessions/${sessionId}/messages?limit=200`, 130, 180)
        ] as never)
        const api = gapApi()
        const { result } = renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(result.current.messages.length).toBeGreaterThan(0)
        expect(getMessageWindowState(sessionId).pendingGapRecovery).toBe(true)
        // The cached rows are on screen and the first page landed, but a recovery is pending: not settled.
        expect(eventsOf('session_open_trace')).toHaveLength(0)

        await act(async () => {
            await recoverWindowAfterGapResume(api, sessionId)
        })
        expect(getMessageWindowState(sessionId).pendingGapRecovery).toBe(false)
        // Still open: the timeline also waits for the session's event stream.
        expect(eventsOf('session_open_trace')).toHaveLength(0)
        act(() => { noteSessionOpenStreamJoined(sessionId) })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_OPEN_TRACE_SETTLE_GRACE_MS + 100)
        })

        const traces = eventsOf('session_open_trace')
        expect(traces).toHaveLength(1)
        expect(traces[0]).toMatchObject({
            outcome: 'settled', fromCache: true, firstRowMs: 32, rowCount: 51, requestCount: 3
        })
        // Three round trips, one after another: that is what the user waited for.
        expect(traces[0]!.requests).toEqual([
            { kind: 'latest', startMs: 10, ttfbMs: 25, totalMs: 50, wireBytes: 1_300, decodedBytes: 9_000, status: 200, rows: 20 },
            { kind: 'catch-up', startMs: 70, ttfbMs: 25, totalMs: 50, wireBytes: 1_300, decodedBytes: 9_000, status: 200, rows: 30 },
            { kind: 'latest', startMs: 130, ttfbMs: 25, totalMs: 50, wireBytes: 1_300, decodedBytes: 9_000, status: 200, rows: 20 }
        ])
        expectSchemaValid('session_open_trace', traces[0])
    })

    it('session_open_trace records the open as left when the user moves on while a gap recovery is pending', async () => {
        cacheWindow(sessionId)
        vi.spyOn(performance, 'getEntriesByType').mockReturnValue([] as never)
        const api = gapApi()
        const { result, unmount } = renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(result.current.messages.length).toBeGreaterThan(0)
        expect(getMessageWindowState(sessionId).pendingGapRecovery).toBe(true)
        expect(eventsOf('session_open_trace')).toHaveLength(0)

        act(() => unmount())
        const traces = eventsOf('session_open_trace')
        expect(traces).toHaveLength(1)
        expect(traces[0]).toMatchObject({ outcome: 'left', fromCache: true, firstRowMs: 32 })
        expect(traces[0]).not.toHaveProperty('settledMs')
        expectSchemaValid('session_open_trace', traces[0])
    })

    it('session_open_trace: a sync that fails is not a settled tail; the failed leg is kept', async () => {
        vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
            timing(`/api/sessions/${sessionId}/messages?limit=20&minConversation=1`, 5, 9_005, {
                responseStatus: 0, responseStart: 0, transferSize: 0, encodedBodySize: 0, decodedBytes: 0
            })
        ] as never)
        const api = makeApi(() => new Promise((_, reject) => {
            setTimeout(() => reject(new Error('network down')), 9_000)
        }))
        const { result, unmount } = renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(9_800)
        })
        expect(result.current.warning).not.toBeNull()
        expect(eventsOf('session_open_trace')).toHaveLength(0)

        act(() => unmount())
        const traces = eventsOf('session_open_trace')
        expect(traces).toHaveLength(1)
        expect(traces[0]).toMatchObject({ outcome: 'left', fromCache: false, requestCount: 1 })
        expect(traces[0]).not.toHaveProperty('settledMs')
        expect(traces[0]).not.toHaveProperty('firstRowMs')
        expect(traces[0]!.requests).toEqual([{ kind: 'latest', startMs: 5, totalMs: 9_000, status: 0 }])
        expectSchemaValid('session_open_trace', traces[0])
    })

    it('level 0 (telemetry off): no open trace is collected', async () => {
        getLevelMock.mockReturnValue(0)
        const api = makeApi(async () => latestResponse([agentMessage('m1', 1, 1_000)]))
        renderHook(() => useMessages(api, sessionId))

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_200)
        })

        expect(eventsOf('session_open_trace')).toHaveLength(0)
    })
})

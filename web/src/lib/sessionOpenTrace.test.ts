import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn(), getLevel: vi.fn(() => 1) },
    bindTelemetryClient: vi.fn()
}))

import { telemetryClient } from '@/lib/telemetryClient'
import { recordSessionEntry } from '@/chat/sessionVisitTelemetry'
import {
    SESSION_OPEN_TRACE_EVENT,
    SESSION_OPEN_TRACE_MAX_LEGS,
    SESSION_OPEN_TRACE_SETTLE_GRACE_MS,
    beginSessionOpenTrace,
    cancelSessionOpenSettle,
    endSessionOpenTrace,
    getSessionOpenTrace,
    installSessionOpenTraceDebugHook,
    noteSessionOpenFirstRow,
    noteSessionOpenPage,
    noteSessionOpenSync,
    prepareSessionOpenResourceTimings,
    resetSessionOpenTrace,
    scheduleSessionOpenSettle,
    subscribeSessionOpenTrace,
    type SessionOpenTraceDebugHook
} from './sessionOpenTrace'

const capture = vi.mocked(telemetryClient.capture)
const getLevel = vi.mocked(telemetryClient.getLevel)

type FrameCallback = (time: number) => void
const frames: FrameCallback[] = []

function leg(url: string, start: number, end: number, extra: Partial<PerformanceResourceTiming> = {}): PerformanceResourceTiming {
    return {
        name: url,
        entryType: 'resource',
        startTime: start,
        duration: end - start,
        requestStart: start,
        responseStart: start + Math.min(100, (end - start) / 2),
        responseEnd: end,
        // What a same-origin browser reports: bytes on the wire, the encoded body, the decoded body.
        transferSize: 1300,
        encodedBodySize: 1200,
        decodedBodySize: 9000,
        responseStatus: 200,
        ...extra
    } as PerformanceResourceTiming
}

function failed(url: string, start: number, end: number): PerformanceResourceTiming {
    return leg(url, start, end, { responseStatus: 0, responseStart: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 })
}

function serveLegs(...legs: PerformanceResourceTiming[]): void {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(legs as unknown as PerformanceEntry[])
}

/** The browser presents one frame: the callbacks queued for it run. */
function presentFrame(): void {
    for (const callback of frames.splice(0)) callback(performance.now())
}

function traces(): Array<Record<string, unknown>> {
    return capture.mock.calls.filter((call) => call[1] === SESSION_OPEN_TRACE_EVENT).map((call) => call[2])
}

function requestsOf(index = 0): Array<Record<string, unknown>> {
    return traces()[index]!.requests as Array<Record<string, unknown>>
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    frames.length = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback) => {
        frames.push(callback)
        return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    resetSessionOpenTrace()
    capture.mockClear()
    getLevel.mockReturnValue(1)
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('session open trace', () => {
    it('starts the clock at the tap and records the first row, the legs and the moment the tail settled', () => {
        const tapAt = Date.now()
        recordSessionEntry('s1', 'list-click')
        // The page commits (and starts its requests) 40ms after the tap.
        vi.advanceTimersByTime(40)
        const clearBuffer = vi.spyOn(performance, 'clearResourceTimings')
        beginSessionOpenTrace('s1', false)
        expect(clearBuffer).toHaveBeenCalledTimes(1)
        expect(getSessionOpenTrace('s1')).toMatchObject({
            sessionId: 's1', entry: 'list-click', openedAt: tapAt, fromCache: false,
            firstRowMs: null, settledMs: null, rowCount: 0, requestCount: 0, done: false, left: false
        })

        // The detail request rides along; the composer's own requests are not part of the open.
        serveLegs(
            leg('/api/sessions/s1', 42, 80, { transferSize: 900, encodedBodySize: 800, decodedBodySize: 5200 }),
            leg('/api/sessions/s1/messages?limit=20&minConversation=1', 45, 245, { transferSize: 12_300, encodedBodySize: 12_000, decodedBodySize: 90_000 }),
            leg('/api/sessions/s1/scratchlist', 45, 75)
        )
        vi.advanceTimersByTime(205)
        noteSessionOpenPage('s1', 'latest', 200)
        // The rows committed with the page; they are on screen after the frame is presented.
        noteSessionOpenFirstRow('s1')
        presentFrame()
        presentFrame()
        expect(getSessionOpenTrace('s1')).toMatchObject({ firstRowMs: 245, settledMs: null })

        vi.advanceTimersByTime(10)
        scheduleSessionOpenSettle('s1', 200)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS - 1)
        expect(traces()).toHaveLength(0)
        vi.advanceTimersByTime(1)

        expect(traces()).toHaveLength(1)
        const data = traces()[0]!
        // settledMs is when the tail became current (255), not when the grace window ran out (755).
        expect(data).toMatchObject({
            entry: 'list-click',
            openedAt: tapAt,
            fromCache: false,
            outcome: 'settled',
            firstRowMs: 245,
            settledMs: 255,
            rowCount: 200,
            requestCount: 2,
            wireBytes: 13_200,
            decodedBytes: 95_200
        })
        // Offsets are from the tap: 40ms to the commit, then the request.
        expect(requestsOf()).toEqual([
            { kind: 'detail', startMs: 42, ttfbMs: 19, totalMs: 38, wireBytes: 900, decodedBytes: 5200, status: 200 },
            { kind: 'latest', startMs: 45, ttfbMs: 100, totalMs: 200, wireBytes: 12_300, decodedBytes: 90_000, status: 200, rows: 200 }
        ])
        // The hub only accepts what the shared schema allows, and the SDK drops events past its size gate.
        expect(TELEMETRY_KINDS.session_open_trace!.data.safeParse(data).success).toBe(true)
        expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThan(3300)
        expect(capture.mock.calls[0]![3]).toEqual({ sessionId: 's1' })
        expect(getSessionOpenTrace('s1')).toMatchObject({ firstRowMs: 245, settledMs: 255, done: true, left: false })
    })

    it('names each leg by what it fetched and pairs pages with their rows', () => {
        const messages = '/api/sessions/s2/messages'
        beginSessionOpenTrace('s2', true)
        serveLegs(
            leg(`${messages}?limit=20`, 10, 60),
            leg(`${messages}?afterAt=5&afterSeq=5&epoch=1&limit=200`, 70, 120),
            leg(`${messages}?limit=20`, 130, 180),
            leg(`${messages}?beforeAt=3&beforeSeq=3&limit=200`, 190, 400),
            leg(`${messages}?limit=200`, 410, 700),
            leg(`${messages}/m-9/context`, 710, 900),
            // Same prefix, not part of the open: a send, a retry, a preview, the composer's requests.
            leg(messages, 910, 960),
            leg(`${messages}/m-9/retry`, 910, 960),
            leg(`${messages}/m-9/attachments/a-1/preview`, 910, 960),
            leg(`${messages}/queued-state`, 910, 960),
            leg('/api/sessions/s2/scratchlist', 910, 960)
        )
        vi.advanceTimersByTime(60)
        noteSessionOpenPage('s2', 'latest', 20)
        vi.advanceTimersByTime(60)
        noteSessionOpenPage('s2', 'catch-up', 40)
        vi.advanceTimersByTime(60)
        noteSessionOpenPage('s2', 'latest', 20)
        vi.advanceTimersByTime(220)
        noteSessionOpenPage('s2', 'context', 200)
        vi.advanceTimersByTime(300)
        noteSessionOpenPage('s2', 'latest', 200)
        scheduleSessionOpenSettle('s2', 260)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS)

        expect(requestsOf()).toEqual([
            { kind: 'latest', startMs: 10, ttfbMs: 25, totalMs: 50, wireBytes: 1300, decodedBytes: 9000, status: 200, rows: 20 },
            { kind: 'catch-up', startMs: 70, ttfbMs: 25, totalMs: 50, wireBytes: 1300, decodedBytes: 9000, status: 200, rows: 40 },
            { kind: 'latest', startMs: 130, ttfbMs: 25, totalMs: 50, wireBytes: 1300, decodedBytes: 9000, status: 200, rows: 20 },
            { kind: 'context', startMs: 190, ttfbMs: 100, totalMs: 210, wireBytes: 1300, decodedBytes: 9000, status: 200, rows: 200 },
            { kind: 'latest', startMs: 410, ttfbMs: 100, totalMs: 290, wireBytes: 1300, decodedBytes: 9000, status: 200, rows: 200 },
            // The message-context endpoint is a context leg too, but not a page the store noted.
            { kind: 'context', startMs: 710, ttfbMs: 95, totalMs: 190, wireBytes: 1300, decodedBytes: 9000, status: 200 }
        ])
        expect(traces()[0]).toMatchObject({ fromCache: true, requestCount: 6 })
        expect(traces()[0]).not.toHaveProperty('firstRowMs')
    })

    it('never gives a failed page the rows of the request that retried it', () => {
        const latest = '/api/sessions/s3/messages?limit=20'
        beginSessionOpenTrace('s3', false)
        serveLegs(failed(latest, 0, 1000), leg(latest, 1000, 1200))
        vi.advanceTimersByTime(1200)
        noteSessionOpenPage('s3', 'latest', 20)
        scheduleSessionOpenSettle('s3', 20)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS)

        expect(requestsOf()).toEqual([
            { kind: 'latest', startMs: 0, totalMs: 1000, status: 0 },
            { kind: 'latest', startMs: 1000, ttfbMs: 100, totalMs: 200, wireBytes: 1300, decodedBytes: 9000, status: 200, rows: 20 }
        ])
        expect(traces()[0]).toMatchObject({ settledMs: 1200, requestCount: 2, wireBytes: 1300 })
    })

    it('keeps waiting while another sync starts inside the grace window', () => {
        const listener = vi.fn()
        subscribeSessionOpenTrace(listener)
        beginSessionOpenTrace('s4', false)
        scheduleSessionOpenSettle('s4', 20)
        vi.advanceTimersByTime(200)
        cancelSessionOpenSettle()
        vi.advanceTimersByTime(2000)
        expect(traces()).toHaveLength(0)

        scheduleSessionOpenSettle('s4', 220)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS - 1)
        expect(traces()).toHaveLength(0)
        vi.advanceTimersByTime(1)
        expect(traces()).toHaveLength(1)
        // The later sync counts: the tail only became current for good at 2200.
        expect(traces()[0]).toMatchObject({ settledMs: 2200, rowCount: 220 })
        expect(listener).toHaveBeenCalled()
    })

    it('ignores the pages and settles of another session and caps the legs', () => {
        beginSessionOpenTrace('s5', false)
        noteSessionOpenPage('other', 'latest', 999)
        scheduleSessionOpenSettle('other', 999)
        vi.advanceTimersByTime(900)
        expect(traces()).toHaveLength(0)
        expect(getSessionOpenTrace('s5')?.settledMs).toBeNull()

        const many = Array.from({ length: SESSION_OPEN_TRACE_MAX_LEGS + 4 }, (_, index) => (
            leg(`/api/sessions/s5/messages?afterAt=${index}&afterSeq=${index}&epoch=1&limit=200`, index * 10, index * 10 + 5)
        ))
        serveLegs(...many)
        scheduleSessionOpenSettle('s5', 0)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS)
        const data = traces()[0]!
        expect(data.requestCount).toBe(SESSION_OPEN_TRACE_MAX_LEGS)
        expect((data.requests as unknown[]).length).toBe(SESSION_OPEN_TRACE_MAX_LEGS)
        expect(TELEMETRY_KINDS.session_open_trace!.data.safeParse(data).success).toBe(true)
        expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThan(3300)
    })

    it('tells a request that got no response from one the cache answered, and from one without sizes', () => {
        const latest = '/api/sessions/s6/messages?limit=20'
        beginSessionOpenTrace('s6', false)
        serveLegs(
            failed(latest, 0, 400),
            leg('/api/sessions/s6', 0, 400),
            leg(latest, 410, 420, { transferSize: 0 }),
            leg(`${latest}&again`, 430, 440, { transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 })
        )
        scheduleSessionOpenSettle('s6', 0)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS)

        const requests = requestsOf()
        expect(requests[0]).toEqual({ kind: 'latest', startMs: 0, totalMs: 400, status: 0 })
        expect(requests[1]).toMatchObject({ kind: 'detail', wireBytes: 1300 })
        // transferSize 0 with a body: the browser cache answered.
        expect(requests[2]).toMatchObject({ kind: 'latest', wireBytes: 0, decodedBytes: 9000 })
        // No sizes at all: report nothing rather than claim zero bytes.
        expect(requests[3]).toMatchObject({ kind: 'latest', status: 200 })
        expect(requests[3]).not.toHaveProperty('wireBytes')
        expect(requests[3]).not.toHaveProperty('decodedBytes')
        expect(traces()[0]).toMatchObject({ wireBytes: 1300, requestCount: 4 })
    })

    it('records an open that was left before the tail arrived, without a settle time', () => {
        beginSessionOpenTrace('s7', false)
        const latest = '/api/sessions/s7/messages?limit=20'
        serveLegs(failed(latest, 0, 900))
        vi.advanceTimersByTime(100)
        noteSessionOpenFirstRow('s7')
        presentFrame()
        presentFrame()
        expect(getSessionOpenTrace('s7')).toMatchObject({ firstRowMs: 100, settledMs: null })

        vi.advanceTimersByTime(800)
        endSessionOpenTrace(12)

        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ outcome: 'left', fromCache: false, firstRowMs: 100, rowCount: 12, requestCount: 1 })
        expect(traces()[0]).not.toHaveProperty('settledMs')
        expect(requestsOf()[0]).toEqual({ kind: 'latest', startMs: 0, totalMs: 900, status: 0 })
        expect(TELEMETRY_KINDS.session_open_trace!.data.safeParse(traces()[0]).success).toBe(true)
        expect(getSessionOpenTrace('s7')).toMatchObject({ done: true, left: true, settledMs: null })
        // Nothing is left running for the next open.
        expect(vi.getTimerCount()).toBe(0)
    })

    it('closes an open that was left inside the grace window as settled', () => {
        beginSessionOpenTrace('s8', true)
        scheduleSessionOpenSettle('s8', 30)
        vi.advanceTimersByTime(100)
        endSessionOpenTrace(99)

        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ outcome: 'settled', fromCache: true, settledMs: 0, rowCount: 30 })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('closes the previous open when another session is opened', () => {
        beginSessionOpenTrace('first', false)
        scheduleSessionOpenSettle('first', 20)
        vi.advanceTimersByTime(100)
        beginSessionOpenTrace('second', false)

        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ outcome: 'settled', settledMs: 0 })
        expect(capture.mock.calls[0]![3]).toEqual({ sessionId: 'first' })
        expect(getSessionOpenTrace('first')).toMatchObject({ done: true })
        expect(getSessionOpenTrace('second')).toMatchObject({ done: false, firstRowMs: null })
    })

    it('does not let a queued frame callback of a closed open mark the next one', () => {
        beginSessionOpenTrace('first', true)
        noteSessionOpenFirstRow('first')
        beginSessionOpenTrace('second', true)
        presentFrame()
        presentFrame()
        expect(getSessionOpenTrace('first')).toMatchObject({ done: true, left: true, firstRowMs: null })
        expect(getSessionOpenTrace('second')).toMatchObject({ done: false, firstRowMs: null })
    })

    it('settles on a sync that left the tail current, and keeps waiting on one that did not', () => {
        beginSessionOpenTrace('s11', true)
        // The first page landed but armed its reconcile: the tail is not current.
        noteSessionOpenSync('s11', false, 21)
        vi.advanceTimersByTime(300)
        expect(traces()).toHaveLength(0)
        // The recovery finished: current.
        noteSessionOpenSync('s11', true, 51)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS - 1)
        expect(traces()).toHaveLength(0)
        vi.advanceTimersByTime(1)
        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ outcome: 'settled', fromCache: true, settledMs: 300, rowCount: 51 })
    })

    it('settles once the open\'s first sync and the reconcile it triggers are done, without waiting for the event stream', () => {
        // What an open looks like on the wire since its reconcile follows the
        // first page instead of the stream's connection: the page, then a
        // catch-up page and a latest page (or the fingerprint list and the
        // rows that differ). The stream's handshake is not part of it and
        // triggers nothing.
        const messages = '/api/sessions/s12/messages'
        beginSessionOpenTrace('s12', false)
        serveLegs(
            leg(`${messages}?limit=20&minConversation=1`, 8, 95),
            leg('/api/sessions/s12', 9, 95),
            leg(`${messages}?afterAt=10&afterSeq=10&epoch=1&limit=200`, 98, 146),
            leg(`${messages}?limit=200`, 147, 272)
        )
        vi.advanceTimersByTime(98)
        noteSessionOpenPage('s12', 'latest', 20)
        // The first page landed and armed the reconcile: not current.
        noteSessionOpenSync('s12', false, 20)
        vi.advanceTimersByTime(48)
        noteSessionOpenPage('s12', 'catch-up', 0)
        vi.advanceTimersByTime(126)
        noteSessionOpenPage('s12', 'latest', 200)
        noteSessionOpenSync('s12', true, 200)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS - 1)
        expect(traces()).toHaveLength(0)
        vi.advanceTimersByTime(1)

        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ outcome: 'settled', settledMs: 272, rowCount: 200, requestCount: 4, wireBytes: 5200 })
        expect(requestsOf().map((leg) => [leg.kind, leg.startMs, leg.totalMs, leg.rows])).toEqual([
            ['latest', 8, 87, 20],
            ['detail', 9, 86, undefined],
            ['catch-up', 98, 48, 0],
            ['latest', 147, 125, 200]
        ])
        expect(vi.getTimerCount()).toBe(0)
    })

    it('closes on its own once the tail is current, with no stream to wait for', () => {
        beginSessionOpenTrace('s13', false)
        vi.advanceTimersByTime(600)
        // No sync has completed since the open: nothing is settled.
        vi.advanceTimersByTime(3000)
        expect(traces()).toHaveLength(0)
        vi.advanceTimersByTime(100)
        noteSessionOpenSync('s13', true, 3)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS)
        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ settledMs: 3700, rowCount: 3 })
        expect(vi.getTimerCount()).toBe(0)

        // An open whose tail never becomes current stays open until it is left.
        resetSessionOpenTrace()
        capture.mockClear()
        beginSessionOpenTrace('s14', false)
        vi.advanceTimersByTime(60_000)
        expect(traces()).toHaveLength(0)
        expect(getSessionOpenTrace('s14')).toMatchObject({ done: false, settledMs: null })
        endSessionOpenTrace(5)
        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ outcome: 'left', rowCount: 5 })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('leaves out what is not a request of the session: the page\'s icon and favicon', () => {
        // They share the prefix `/api/sessions/<id>`-style URLs only by
        // accident of the old slice (an index of -1); they are not legs.
        beginSessionOpenTrace('s15', false)
        serveLegs(
            leg('/icon.svg', 1, 4),
            leg('/favicon.ico', 1, 3),
            leg('/api/machines', 2, 30),
            leg('/api/sessions/s15/messages?limit=20&minConversation=1', 5, 95)
        )
        vi.advanceTimersByTime(96)
        noteSessionOpenPage('s15', 'latest', 20)
        noteSessionOpenSync('s15', true, 20)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS)

        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ requestCount: 1, wireBytes: 1300 })
        expect(requestsOf().map((leg) => leg.kind)).toEqual(['latest'])
    })

    it('does nothing while developer mode is off', () => {
        getLevel.mockReturnValue(0)
        beginSessionOpenTrace('s9', false)
        noteSessionOpenFirstRow('s9')
        noteSessionOpenPage('s9', 'latest', 20)
        scheduleSessionOpenSettle('s9', 20)
        vi.advanceTimersByTime(5000)
        expect(traces()).toHaveLength(0)
        expect(getSessionOpenTrace('s9')).toBeNull()
    })

    it('starts over when the session is opened again', () => {
        beginSessionOpenTrace('s10', false)
        noteSessionOpenFirstRow('s10')
        presentFrame()
        presentFrame()
        scheduleSessionOpenSettle('s10', 20)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS)
        expect(getSessionOpenTrace('s10')).toMatchObject({ firstRowMs: 0, done: true })

        vi.advanceTimersByTime(1000)
        beginSessionOpenTrace('s10', true)
        expect(getSessionOpenTrace('s10')).toMatchObject({ fromCache: true, firstRowMs: null, settledMs: null, done: false })
    })
})

describe('session open trace: the first page leaves on the tap', () => {
    const firstPage = '/api/sessions/s1/messages?limit=20&minConversation=1&withRowHashes=1'

    it('keeps the request that left before the timeline began', () => {
        const tapAt = Date.now()
        recordSessionEntry('s1', 'list-click')
        // The router prefetches the first page on the tap; the page lands while
        // the session page is still rendering the rows it already holds.
        prepareSessionOpenResourceTimings()
        const clearBuffer = vi.spyOn(performance, 'clearResourceTimings')
        serveLegs(leg(firstPage, 1, 90))
        vi.advanceTimersByTime(160)
        beginSessionOpenTrace('s1', true)
        expect(clearBuffer).not.toHaveBeenCalled()

        vi.advanceTimersByTime(10)
        noteSessionOpenPage('s1', 'latest', 20)
        noteSessionOpenFirstRow('s1')
        presentFrame()
        presentFrame()
        noteSessionOpenSync('s1', true, 20)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS)

        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ openedAt: tapAt, firstRowMs: 170, settledMs: 170 })
        expect(requestsOf()).toEqual([
            { kind: 'latest', startMs: 1, ttfbMs: 45, totalMs: 89, wireBytes: 1300, decodedBytes: 9000, status: 200, rows: 20 }
        ])
    })

    it('names the reconcile\'s two requests and gives the fetched rows to the second', () => {
        recordSessionEntry('s1', 'list-click')
        prepareSessionOpenResourceTimings()
        // The first page left on the tap and landed at 90ms; the session page
        // mounts at 160ms and the catch-up and the reconcile follow.
        serveLegs(
            leg('/api/sessions/s1/messages?limit=20&minConversation=1&withRowHashes=1', 1, 90, { transferSize: 1500 }),
            leg('/api/sessions/s1/messages?afterAt=1000&afterSeq=5&epoch=0&limit=200&withRowHashes=1', 165, 200, { transferSize: 476 }),
            leg('/api/sessions/s1/messages?limit=200&knownEpoch=0&withRowHashes=1&rowHashes=1', 205, 230, { transferSize: 2300 }),
            leg('/api/sessions/s1/messages?limit=200&knownEpoch=0&withRowHashes=1&ids=a,b', 235, 250, { transferSize: 617 })
        )
        vi.advanceTimersByTime(160)
        beginSessionOpenTrace('s1', true)
        // What the window store reports, each as its response is applied.
        noteSessionOpenPage('s1', 'latest', 20)
        vi.advanceTimersByTime(41)
        noteSessionOpenPage('s1', 'catch-up', 0)
        vi.advanceTimersByTime(51)
        noteSessionOpenPage('s1', 'latest', 2)
        noteSessionOpenSync('s1', true, 200)
        vi.advanceTimersByTime(SESSION_OPEN_TRACE_SETTLE_GRACE_MS)

        expect(requestsOf()).toEqual([
            { kind: 'latest', startMs: 1, ttfbMs: 45, totalMs: 89, wireBytes: 1500, decodedBytes: 9000, status: 200, rows: 20 },
            { kind: 'catch-up', startMs: 165, ttfbMs: 18, totalMs: 35, wireBytes: 476, decodedBytes: 9000, status: 200, rows: 0 },
            { kind: 'manifest', startMs: 205, ttfbMs: 13, totalMs: 25, wireBytes: 2300, decodedBytes: 9000, status: 200, rows: 0 },
            { kind: 'refresh', startMs: 235, ttfbMs: 8, totalMs: 15, wireBytes: 617, decodedBytes: 9000, status: 200, rows: 2 }
        ])
        // The hub only accepts the kinds the shared schema knows.
        expect(TELEMETRY_KINDS.session_open_trace!.data.safeParse(traces()[0]).success).toBe(true)
    })

    it('empties the request log for an open that starts without a prefetch', () => {
        recordSessionEntry('s1', 'list-click')
        const clearBuffer = vi.spyOn(performance, 'clearResourceTimings')
        beginSessionOpenTrace('s1', false)
        expect(clearBuffer).toHaveBeenCalledTimes(1)
    })

    it('empties a crowded log at the tap and leaves a roomy one alone', () => {
        const entries = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([] as unknown as PerformanceEntry[])
        const clearBuffer = vi.spyOn(performance, 'clearResourceTimings')
        prepareSessionOpenResourceTimings()
        expect(clearBuffer).not.toHaveBeenCalled()

        entries.mockReturnValue(Array.from({ length: 200 }, () => ({})) as unknown as PerformanceEntry[])
        prepareSessionOpenResourceTimings()
        expect(clearBuffer).toHaveBeenCalledTimes(1)
    })

    it('ends the previous open at the tap', () => {
        // One that was only waiting out its grace window had settled.
        beginSessionOpenTrace('s1', false)
        noteSessionOpenSync('s1', true, 20)
        prepareSessionOpenResourceTimings()
        expect(traces()).toHaveLength(1)
        expect(traces()[0]).toMatchObject({ outcome: 'settled' })

        // One still working was left.
        beginSessionOpenTrace('s2', false)
        prepareSessionOpenResourceTimings()
        expect(traces()).toHaveLength(2)
        expect(traces()[1]).toMatchObject({ outcome: 'left' })
    })
})

describe('session open trace debug hook', () => {
    const hookOnWindow = () => (window as unknown as { __hapiOpenTrace?: SessionOpenTraceDebugHook }).__hapiOpenTrace

    afterEach(() => {
        delete (window as unknown as { __hapiOpenTrace?: SessionOpenTraceDebugHook }).__hapiOpenTrace
    })

    // The dialog shows the timeline on request; measuring tools read the same object without opening it.
    it('hands tools the timeline the dialog shows, tells them when it moves, and installs once', () => {
        recordSessionEntry('s1', 'list-click')
        beginSessionOpenTrace('s1', false)
        expect(hookOnWindow()).toBeUndefined()

        installSessionOpenTraceDebugHook()
        const hook = hookOnWindow()
        expect(hook).toBeTruthy()
        expect(hook!.get('s1')).toMatchObject({ sessionId: 's1', entry: 'list-click', done: false })
        expect(hook!.get('never-opened')).toBeNull()
        expect(hook!.get(null)).toBeNull()

        const moved = vi.fn()
        const unsubscribe = hook!.subscribe(moved)
        noteSessionOpenFirstRow('s1')
        presentFrame()
        presentFrame()
        expect(moved).toHaveBeenCalled()
        expect(hook!.get('s1')!.firstRowMs).not.toBeNull()
        unsubscribe()
        moved.mockClear()
        // Another open moves the timeline; the tool that unsubscribed is not told.
        beginSessionOpenTrace('s2', true)
        expect(moved).not.toHaveBeenCalled()
        expect(hook!.get('s2')).toMatchObject({ sessionId: 's2', fromCache: true })

        installSessionOpenTraceDebugHook()
        expect(hookOnWindow()).toBe(hook)
    })
})

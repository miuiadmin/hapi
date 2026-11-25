import { telemetryClient } from '@/lib/telemetryClient'
import { peekSessionEntry } from '@/chat/sessionVisitTelemetry'

/**
 * "I tapped the session: how much came down, and how long until it was on
 * screen?" — one timeline per session open, in milliseconds from the tap:
 *
 *   firstRowMs  tap → the first message row is on screen (from cache at once,
 *               or as soon as the first page lands)
 *   settledMs   tap → the tail is current and the open's own work is done: its
 *               first sync and the reconcile it triggers have finished, and
 *               nothing is syncing
 *   legs        the requests it took, with bytes on the wire and rows
 *
 * The timeline spans the open's reconcile on purpose. The first page is the
 * newest rows; a first connection cannot prove that no row the window holds
 * changed in place, so the open reconciles once more as soon as that page has
 * landed: the list of the page's fingerprints and only the rows that differ
 * from what the window holds. That reconcile used to wait for the session's
 * event stream to connect; it no longer does, and neither does the timeline:
 * an open settles once its syncs are done and a second passes without another
 * starting. (The stream's own first connection no longer triggers anything.)
 *
 * The finished timeline goes to the hub as the `session_open_trace` event (so
 * every open can be looked up later with its wall-clock time) and is shown by
 * the open-trace chip while developer mode is on. Observation only: nothing
 * here may throw into the feature it watches.
 */

export const SESSION_OPEN_TRACE_EVENT = 'session_open_trace'

/** Requests kept on one timeline (the whole event must stay under the SDK's 3.9KB gate). */
export const SESSION_OPEN_TRACE_MAX_LEGS = 12
/**
 * A tail that stays current this long is considered settled; a sync starting in
 * the window resets it. It has to bridge the requests an open itself triggers
 * — the catch-up, the reconcile, the row refreshes — which follow each other
 * within tens of milliseconds. It must not reach the syncs that come after the
 * open because something else happened: a message the user sends, a running
 * agent's next row. Those were measured at 1.1 s to 2.4 s after the open's
 * last request, and a 2 s window swallowed them into the open's time. The
 * background tail ticker is 10 s apart at its fastest.
 */
export const SESSION_OPEN_TRACE_SETTLE_GRACE_MS = 1000

export type OpenTraceLegKind = 'latest' | 'context' | 'catch-up' | 'detail' | 'manifest' | 'refresh'
type PageKind = Exclude<OpenTraceLegKind, 'detail' | 'manifest' | 'refresh'>

export type SessionOpenTraceLeg = {
    kind: OpenTraceLegKind
    /** Offset from the tap. */
    startMs: number
    /** Request sent → first byte. */
    ttfbMs?: number
    totalMs: number
    /** Bytes that crossed the network, headers included; 0 = the browser cache answered.
     *  Absent when the browser does not report sizes or the request got no response. */
    wireBytes?: number
    decodedBytes?: number
    /** Rows in the message page. Absent on the session-detail request and when the page
     *  never landed. */
    rows?: number
    /** 0 = no response. */
    status?: number
}

export type SessionOpenTrace = {
    sessionId: string
    /** How the session was opened (list click, search hit, deep link…). */
    entry: string
    /** Wall clock of the tap (device clock), for lining up with hub logs. */
    openedAt: number
    /** The window already held a cached tail when the session was opened. */
    fromCache: boolean
    firstRowMs: number | null
    /** Tap → tail current. Null while the open is still in progress, and when the user
     *  moved on before the tail ever became current. */
    settledMs: number | null
    /** Rows in the window when the timeline closed. */
    rowCount: number
    requestCount: number
    wireBytes: number
    decodedBytes: number
    legs: SessionOpenTraceLeg[]
    /** False until the timeline is closed. */
    done: boolean
    /** The user left before the tail became current. */
    left: boolean
}

type ActiveTrace = {
    sessionId: string
    entry: string
    /** performance.now() at the tap. */
    t0: number
    openedAt: number
    fromCache: boolean
    firstRowSeen: boolean
    firstRowAt: number | null
    /** Message pages as they complete, in completion order. */
    pages: Array<{ kind: PageKind; rows: number; end: number }>
    /** Offset at which the tail first became current; null again when a later sync starts. */
    settledAt: number | null
    /** The last sync that finished left the window tail-current. */
    current: boolean
}

let active: ActiveTrace | null = null
/** Stable snapshot of the open in progress (getSnapshot must not allocate). */
let activeView: SessionOpenTrace | null = null
let finalizeTimer: ReturnType<typeof setTimeout> | null = null
let pendingRowCount = 0
let firstRowToken = 0
const latestBySession = new Map<string, SessionOpenTrace>()
const listeners = new Set<() => void>()

function enabled(): boolean {
    try {
        return (telemetryClient.getLevel?.() ?? 0) > 0
    } catch {
        return false
    }
}

function notify(): void {
    for (const listener of listeners) {
        try {
            listener()
        } catch {
            // a broken subscriber must not stop the others
        }
    }
}

/**
 * Resource Timing keeps a few hundred entries and then silently drops every
 * new one — next to nothing in a long-lived single-page app. Nothing else
 * reads the buffer, so each open starts it over.
 */
const RESOURCE_TIMINGS_CROWDED = 200

/** performance.now() of the last moment the buffer was made ready for an open. */
let resourceTimingsReadyAt = Number.NEGATIVE_INFINITY

function resetResourceTimings(): void {
    try {
        performance.clearResourceTimings?.()
    } catch {
        // not supported: the legs are simply missing
    }
    resourceTimingsReadyAt = performance.now()
}

/**
 * Make the request log ready for an open that starts right now, before its
 * first request leaves: the router prefetches the first page on the tap
 * (`prefetchSessionOpenPage`), well before the session page begins the
 * timeline. The log must have room by then and must not be emptied again
 * while that request is in flight or has just landed, so the timeline's own
 * start skips the reset when this ran for it.
 */
export function prepareSessionOpenResourceTimings(): void {
    if (!enabled()) return
    // The tap that starts this open is also the moment the previous one ended.
    endSessionOpenTrace()
    const recorded = performance.getEntriesByType?.('resource')?.length ?? 0
    if (recorded >= RESOURCE_TIMINGS_CROWDED) {
        resetResourceTimings()
    } else {
        resourceTimingsReadyAt = performance.now()
    }
}

/** Run once the frame that just committed has been presented. */
function afterPaint(callback: () => void): void {
    if (typeof requestAnimationFrame !== 'function') {
        callback()
        return
    }
    requestAnimationFrame(() => requestAnimationFrame(callback))
}

/**
 * The open is over (the session was switched or the page left). One that was
 * already waiting out its grace window closes as settled; any other closes as
 * left, with the rows the window holds right now.
 */
export function endSessionOpenTrace(rowCount?: number): void {
    if (finalizeTimer !== null) {
        clearTimeout(finalizeTimer)
        finalizeTimer = null
        if (active) finalizeSessionOpenTrace(false)
        return
    }
    if (!active) return
    if (rowCount !== undefined) pendingRowCount = rowCount
    finalizeSessionOpenTrace(true)
}

/** The window is being opened right now: start the clock at the tap. */
export function beginSessionOpenTrace(sessionId: string, fromCache: boolean): void {
    if (!enabled()) return
    endSessionOpenTrace()

    const intent = peekSessionEntry(sessionId)
    // The tap that selected the session was recorded by the router; the page
    // commits a render (and maybe a lazy chunk) later than that.
    const lead = intent ? Math.max(0, Math.min(Date.now() - intent.at, 30_000)) : 0
    const now = performance.now()
    firstRowToken += 1
    active = {
        sessionId,
        entry: intent?.entry ?? 'open',
        t0: now - lead,
        openedAt: Date.now() - lead,
        fromCache,
        firstRowSeen: false,
        firstRowAt: null,
        pages: [],
        settledAt: null,
        current: false
    }
    pendingRowCount = 0
    if (resourceTimingsReadyAt < active.t0) {
        resetResourceTimings()
    }
    activeView = {
        sessionId,
        entry: active.entry,
        openedAt: active.openedAt,
        fromCache,
        firstRowMs: null,
        settledMs: null,
        rowCount: 0,
        requestCount: 0,
        wireBytes: 0,
        decodedBytes: 0,
        legs: [],
        done: false,
        left: false
    }
    notify()
}

/** The tree that holds message rows just committed; the row is on screen after the next paint. */
export function noteSessionOpenFirstRow(sessionId: string): void {
    const trace = active
    if (!trace || trace.sessionId !== sessionId || trace.firstRowSeen) return
    trace.firstRowSeen = true
    const token = ++firstRowToken
    afterPaint(() => {
        if (token !== firstRowToken || active !== trace) return
        trace.firstRowAt = performance.now() - trace.t0
        if (activeView) activeView = { ...activeView, firstRowMs: Math.round(trace.firstRowAt) }
        notify()
    })
}

/** A message page landed. Called by the window store for every page it fetches. */
export function noteSessionOpenPage(sessionId: string, kind: PageKind, rows: number): void {
    if (!active || active.sessionId !== sessionId) return
    active.pages.push({ kind, rows, end: performance.now() })
}

/**
 * A tail sync completed. The store reports every one right after it applied
 * its verdict: `current` says whether the window is now tail-current — no sync
 * in flight, nothing left to recover, no warning. The open settles on the
 * first such verdict; an open whose first sync armed its reconcile settles
 * after that reconcile.
 */
export function noteSessionOpenSync(sessionId: string, current: boolean, rowCount: number): void {
    const trace = active
    if (!trace || trace.sessionId !== sessionId) return
    trace.current = current
    pendingRowCount = rowCount
    if (!current) {
        cancelSessionOpenSettle()
        return
    }
    scheduleSessionOpenSettle(sessionId, rowCount)
}

/**
 * The tail is current; close the timeline once it stays that way. Repeated
 * calls (later syncs by the tail ticker) never push the deadline out.
 */
export function scheduleSessionOpenSettle(sessionId: string, rowCount: number): void {
    if (!active || active.sessionId !== sessionId) return
    pendingRowCount = rowCount
    if (active.settledAt === null) active.settledAt = performance.now() - active.t0
    if (finalizeTimer !== null) return
    finalizeTimer = setTimeout(() => {
        finalizeTimer = null
        finalizeSessionOpenTrace(false)
    }, SESSION_OPEN_TRACE_SETTLE_GRACE_MS)
}

/** Another sync started: the open is not settled after all. */
export function cancelSessionOpenSettle(): void {
    if (active) {
        active.settledAt = null
        active.current = false
    }
    if (finalizeTimer === null) return
    clearTimeout(finalizeTimer)
    finalizeTimer = null
}

function legKind(url: string, marker: string): OpenTraceLegKind | null {
    const index = url.indexOf(marker)
    // Not a request of this session at all (the page's icon, the hub's own
    // endpoints): nothing of the open.
    if (index < 0) return null
    const rest = url.slice(index + marker.length)
    if (rest === '' || rest.startsWith('?')) return 'detail'
    // Only what the open reads: a page (always requested with a limit or a
    // cursor) and a message's context. Sends, retries, attachment previews and
    // the composer's own requests share the prefix but are not part of the open.
    let page: OpenTraceLegKind | null = null
    if (rest.startsWith('/messages?')) page = 'latest'
    else if (/^\/messages\/[^/?]+\/context(\?|$)/.test(rest)) page = 'context'
    if (page === null) return null
    // The reconcile after a gap, as the web client pays it: the fingerprints
    // of the newest page first, then only the rows that differ from the window.
    if (page === 'latest' && /[?&]rowHashes=1(&|$)/.test(rest)) return 'manifest'
    if (page === 'latest' && /[?&]ids=/.test(rest)) return 'refresh'
    if (page === 'latest' && rest.includes('afterAt=')) return 'catch-up'
    if (page === 'latest' && rest.includes('beforeAt=')) return 'context'
    return page
}

/**
 * The store's page note a leg is answered by. The manifest is the client's
 * own request (it carries no rows and gets no note); the rows fetched after
 * it are the reconcile page's, which the store notes as a latest page.
 */
function noteKindOf(leg: TrackedLeg): PageKind | null {
    if (leg.kind === 'refresh') return 'latest'
    return leg.kind === 'manifest' || leg.kind === 'detail' ? null : leg.kind
}

function readLegs(trace: ActiveTrace): SessionOpenTraceLeg[] {
    const legs = readTimedLegs(trace)
    // The store notes a page once its response has been read, so a note
    // belongs to the latest request of its kind that ended before it. A
    // request that failed leaves no note and keeps no row count.
    const notes = [...trace.pages].sort((a, b) => a.end - b.end)
    const rowsByLeg = new Map<TrackedLeg, number>()
    for (const note of notes) {
        let own: TrackedLeg | null = null
        for (const leg of legs) {
            if (noteKindOf(leg) !== note.kind || rowsByLeg.has(leg) || leg.responseEnd > note.end + 2) continue
            if (!own || leg.responseEnd > own.responseEnd) own = leg
        }
        if (!own) {
            // The request's timing entry went missing: fall back to the first
            // request of that kind that did get a response.
            own = legs.find((leg) => noteKindOf(leg) === note.kind && !rowsByLeg.has(leg) && leg.status !== 0) ?? null
        }
        if (own) rowsByLeg.set(own, note.rows)
    }
    return legs
        .map((tracked): SessionOpenTraceLeg => {
            const { responseEnd: _responseEnd, ...leg } = tracked
            // The manifest is a list of fingerprints; it carries no rows.
            if (leg.kind === 'manifest') return leg.status === 0 ? leg : { ...leg, rows: 0 }
            return rowsByLeg.has(tracked) ? { ...leg, rows: rowsByLeg.get(tracked) } : leg
        })
        .sort((a, b) => a.startMs - b.startMs)
}

type TrackedLeg = SessionOpenTraceLeg & { responseEnd: number }

function readTimedLegs(trace: ActiveTrace): TrackedLeg[] {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return []
    const marker = `/api/sessions/${encodeURIComponent(trace.sessionId)}`
    return performance.getEntriesByType('resource')
        .map((entry) => entry as PerformanceResourceTiming)
        .filter((entry) => entry.startTime >= trace.t0 - 5)
        .map((entry) => ({ entry, kind: legKind(entry.name, marker) }))
        .filter((item): item is { entry: PerformanceResourceTiming; kind: OpenTraceLegKind } => item.kind !== null)
        .map(({ entry, kind }) => {
            const leg: TrackedLeg = {
                kind,
                startMs: Math.round(entry.startTime - trace.t0),
                totalMs: Math.round(entry.duration),
                responseEnd: entry.responseEnd
            }
            // responseStart is 0 when the timing data is withheld; responseStatus is
            // 0 when the request failed before a response.
            const failed = entry.responseStatus === 0
            const firstByte = entry.responseStart - entry.requestStart
            if (firstByte > 0) leg.ttfbMs = Math.round(firstByte)
            if (typeof entry.responseStatus === 'number') leg.status = entry.responseStatus
            if (!failed) {
                // transferSize counts what crossed the network (0 = cache) and is
                // 0 too where the browser reports no sizes at all — fall back to
                // the encoded body then.
                if (typeof entry.transferSize === 'number' && entry.transferSize > 0) {
                    leg.wireBytes = entry.transferSize
                } else if (typeof entry.transferSize === 'number' && (entry.encodedBodySize > 0 || entry.decodedBodySize > 0)) {
                    leg.wireBytes = 0
                } else if (typeof entry.encodedBodySize === 'number' && entry.encodedBodySize > 0) {
                    leg.wireBytes = entry.encodedBodySize
                }
                if (typeof entry.decodedBodySize === 'number' && entry.decodedBodySize > 0) {
                    leg.decodedBytes = entry.decodedBodySize
                }
            }
            return leg
        })
        .sort((a, b) => a.responseEnd - b.responseEnd)
}

function finalizeSessionOpenTrace(left: boolean): void {
    const trace = active
    if (!trace) return
    active = null
    activeView = null
    const legs = readLegs(trace).slice(0, SESSION_OPEN_TRACE_MAX_LEGS)
    const firstRowMs = trace.firstRowAt === null ? null : Math.round(trace.firstRowAt)
    const settledMs = left ? null : Math.round(trace.settledAt ?? (performance.now() - trace.t0))
    const finished: SessionOpenTrace = {
        sessionId: trace.sessionId,
        entry: trace.entry,
        openedAt: trace.openedAt,
        fromCache: trace.fromCache,
        firstRowMs,
        settledMs,
        rowCount: pendingRowCount,
        requestCount: legs.length,
        wireBytes: legs.reduce((sum, leg) => sum + (leg.wireBytes ?? 0), 0),
        decodedBytes: legs.reduce((sum, leg) => sum + (leg.decodedBytes ?? 0), 0),
        legs,
        done: true,
        left
    }
    latestBySession.set(trace.sessionId, finished)
    try {
        telemetryClient.capture('ux', SESSION_OPEN_TRACE_EVENT, {
            entry: finished.entry,
            openedAt: finished.openedAt,
            fromCache: finished.fromCache,
            outcome: left ? 'left' : 'settled',
            ...(firstRowMs === null ? {} : { firstRowMs }),
            ...(settledMs === null ? {} : { settledMs }),
            rowCount: finished.rowCount,
            requestCount: finished.requestCount,
            wireBytes: finished.wireBytes,
            decodedBytes: finished.decodedBytes,
            requests: legs
        }, { sessionId: trace.sessionId })
    } catch {
        // Instrumentation must never break the feature it watches.
    }
    notify()
}

/** The last (or in-progress) open of a session, when developer mode is on. */
export function getSessionOpenTrace(sessionId: string | null): SessionOpenTrace | null {
    if (!sessionId) return null
    if (active && active.sessionId === sessionId) return activeView
    return latestBySession.get(sessionId) ?? null
}

export function subscribeSessionOpenTrace(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

/** Tests only. */
export function resetSessionOpenTrace(): void {
    cancelSessionOpenSettle()
    active = null
    activeView = null
    latestBySession.clear()
    pendingRowCount = 0
    firstRowToken += 1
    resourceTimingsReadyAt = Number.NEGATIVE_INFINITY
}

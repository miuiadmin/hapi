import { MESSAGES_PAGE_MAX } from '@hapi/protocol/apiTypes'

/**
 * The gap-recovery page, paid per changed row instead of per page.
 *
 * After a catch-up the window store asks for the newest full page and upserts
 * it by id: a cursor cannot tell it that a row it already holds changed in
 * place (merged tool-call ticks, delivery state, a scheduled row becoming
 * invoked). That page is the heaviest request of opening a conversation, and
 * nearly every row of it is one the window already holds, unchanged.
 *
 * The store knows which request is that reconcile and what its window holds,
 * but the request itself is shared protocol (the CLI and the native clients
 * send the same one), so it passes both sideways: `markReconcilePage` right
 * before the request, consumed by `ApiClient.getMessages`. The client then
 * asks the hub for the fingerprints of the page's rows, and only for the rows
 * the window does not hold as the hub would now serve them.
 *
 * An open's reconcile follows its first page without waiting for the session's
 * event stream, so the router starts the fingerprint list on the tap too
 * (`prefetchSessionOpenPage`, `ApiClient.prefetchReconcileManifest`): the list
 * needs only the epoch the persisted window was read under. A window whose
 * epoch the hub has moved on from gets the page itself for that list, and the
 * store checks its rows against it by id (`staleEpoch`).
 */

export type ReconcileMark = {
    /** The session epoch the window's rows were read under. */
    epoch: number
    /** Every row the window holds with the fingerprint it was served with;
     *  absent for rows that never got one (local rows, rows from before the
     *  hub labelled pages). */
    rows: ReadonlyMap<string, string | undefined>
    /**
     * The hub has moved the session's epoch on since the window read its rows
     * (the open's first page said so). A fingerprint list asked for with the
     * old epoch is answered with the page itself, and rows may have been
     * removed, which no list of the survivors can show: the reconcile takes
     * the labelled page — the one prefetched on the tap, which the hub
     * answered the same way — and the store checks its window against it by
     * id.
     */
    staleEpoch?: boolean
}

let marked: { sessionId: string; mark: ReconcileMark } | null = null

/** The window store calls this right before it asks for the gap-recovery page. */
export function markReconcilePage(sessionId: string, mark: ReconcileMark): void {
    marked = { sessionId, mark }
}

/**
 * The reconcile marked for `sessionId`, if any. One shot: whichever full page
 * is asked for next is the one the mark was meant for, so the mark never
 * lingers and can never narrow a later replacement page.
 */
export function takeReconcilePageMark(sessionId: string): ReconcileMark | null {
    const taken = marked
    marked = null
    return taken && taken.sessionId === sessionId ? taken.mark : null
}

/** The messages query of the reconcile's fingerprint list for a window read under `epoch`. */
export function reconcileManifestQuery(epoch: number): string {
    return `limit=${MESSAGES_PAGE_MAX}&knownEpoch=${epoch}&withRowHashes=1&rowHashes=1`
}

/** Whether a messages query is that of a reconcile's fingerprint list, whatever epoch it asked for. */
export function isReconcileManifestQuery(query: string): boolean {
    const params = new URLSearchParams(query)
    return params.get('limit') === String(MESSAGES_PAGE_MAX)
        && params.get('rowHashes') === '1'
        && params.get('knownEpoch') !== null
        && !params.has('ids')
}

/** The rows of the newest page the window does not hold as the hub would serve them now. */
export function rowsToFetch(
    mark: ReconcileMark,
    manifest: ReadonlyArray<{ id: string; hash: string }>
): string[] {
    return manifest
        .filter(({ id, hash }) => mark.rows.get(id) !== hash)
        .map(({ id }) => id)
}

/**
 * More differing rows than this are not worth listing in a URL: a first visit
 * after a reload differs in every row, and the plain page is the same download.
 * It also keeps the request well inside what proxies accept as a request line.
 */
export const RECONCILE_MAX_IDS = 64

/**
 * A window holding fewer labelled rows than this — a cold open, or one saved
 * before the hub labelled pages — differs in most of the page. Asking for the
 * page itself is one request where the manifest would only add one.
 */
export const RECONCILE_MIN_LABELLED_ROWS = 64

/** How many of the window's rows carry the fingerprint they were served with. */
export function labelledRowCount(mark: ReconcileMark): number {
    let count = 0
    for (const hash of mark.rows.values()) {
        if (hash !== undefined) count += 1
    }
    return count
}

/** A full latest page: the only shape a mark applies to. */
export function isFullLatestPage(limit: number | null | undefined, latestPage: boolean): boolean {
    return latestPage && limit === MESSAGES_PAGE_MAX
}

/** Tests only. */
export function resetReconcilePageForTests(): void {
    marked = null
}

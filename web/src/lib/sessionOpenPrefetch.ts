import type { ApiClient } from '@/api/client'
import { INITIAL_PAGE_SIZE, getReconcileManifestEpoch } from '@/lib/message-window-store'
import { prepareSessionOpenResourceTimings } from '@/lib/sessionOpenTrace'

/**
 * Start a session's first page the moment it is tapped.
 *
 * The session page asks for its first page from a layout effect, which only
 * runs once the frame holding the rows it already has has rendered: on the
 * phone this conversation was measured on, a re-entry's request left 166 ms
 * after the tap against 20 ms for a cold open, and the fresh rows arrived
 * that much later. The request does not depend on the render, so it starts
 * here instead, and the transport hands the response to the session page when
 * it asks for the same page (`ApiClient.prefetchMessages`).
 *
 * Next to it, for a session whose persisted window would be reconciled by
 * fingerprint list, that list: the reconcile follows the first page without
 * waiting for the session's event stream, and by then the list has landed
 * too. It needs only the window's epoch, which the tap can read.
 *
 * A tap that opens on a specific message (a search hit) loads a context page
 * instead; the caller skips those.
 */
export function prefetchSessionOpenPage(api: ApiClient | null, sessionId: string): void {
    // Router tests drive the tap with a bare stand-in for the client.
    if (!api || typeof api.prefetchMessages !== 'function') return
    // The first request leaves now: the open timeline must not clear the
    // request log after it.
    prepareSessionOpenResourceTimings()
    api.prefetchMessages(sessionId, { limit: INITIAL_PAGE_SIZE })
    if (typeof api.prefetchReconcileManifest !== 'function') return
    const epoch = getReconcileManifestEpoch(sessionId)
    if (epoch !== null) {
        api.prefetchReconcileManifest(sessionId, epoch)
    }
}

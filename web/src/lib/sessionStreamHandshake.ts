import type { SseConnectInfo } from '@/hooks/useSSE'

/**
 * What the app does on a handshake of the selected session's event stream.
 *
 *   ignore       the handshake is another session's: it landed after the app moved on
 *   nothing      the hub replayed the session's events; nothing can have drifted
 *   queued-state only the queued-state snapshot is checked, without a tail sync
 *   recover      the window is reconciled from an authoritative page, then the queued state
 */
export type SessionHandshakeAction = 'ignore' | 'nothing' | 'queued-state' | 'recover'

/**
 * An open reconciles by itself: its first sync takes the newest page, and the
 * reconcile that used to wait for this stream's first connection and its gap
 * now runs as the sync right after that page. So the stream's first connection
 * has nothing left to recover — unless that sync failed or was cut short
 * (`needsReconcile`, see the window store). A connection that dropped and came
 * back with a gap still reconciles, as before.
 */
export function sessionHandshakeAction(
    info: SseConnectInfo,
    selectedSessionId: string | null,
    needsReconcile: boolean
): SessionHandshakeAction {
    // The handshake belongs to the stream it arrived on. One that lands after
    // the app moved to another session is the session left behind, and has
    // nothing to reconcile here.
    if (info.sessionId !== null && info.sessionId !== selectedSessionId) {
        return 'ignore'
    }
    // A resumed connection replayed messages-consumed/message events for this
    // session, so the queued-state snapshot cannot have drifted.
    if (info.resumed) {
        return 'nothing'
    }
    if (info.initial && !needsReconcile) {
        return 'queued-state'
    }
    // First connects that found nothing reconciled, and gaps, cannot prove
    // continuity: in-place row updates (merged tool-call ticks) that a replay
    // cannot deliver are recovered from an authoritative latest page.
    return 'recover'
}

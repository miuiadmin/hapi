import type { SessionSummary } from '@/types/api'

// Fixed-order sort key for the session list ("固定会话顺序" display setting).
// Extracted so useSSE and SessionList share one definition of the stable
// ordering key, and so the fallback is unit-testable without React.

/** Fixed-order sort key. Falls back to `updatedAt` for summaries emitted by
 *  an older hub that predates `createdAt` on SessionSummary — ordering then
 *  degrades to the legacy activity sort instead of breaking. */
export function getSessionOrderKey(session: SessionSummary): number {
    return session.createdAt ?? session.updatedAt
}

/** Descending comparison of the fixed-order key (newest-created first).
 *  Equal keys tie-break on session id so the order is a total order: the
 *  hub may return tied sessions in activity order, and without a stable
 *  tie-break those sessions visibly swap after every refetch. */
export function compareSessionsByOrderKeyDesc(a: SessionSummary, b: SessionSummary): number {
    const keyDelta = getSessionOrderKey(b) - getSessionOrderKey(a)
    if (keyDelta !== 0) return keyDelta
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
}

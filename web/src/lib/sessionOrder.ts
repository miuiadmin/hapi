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

/** Descending comparison of the fixed-order key (newest-created first). */
export function compareSessionsByOrderKeyDesc(a: SessionSummary, b: SessionSummary): number {
    return getSessionOrderKey(b) - getSessionOrderKey(a)
}

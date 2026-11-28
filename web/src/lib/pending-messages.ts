import type { DecryptedMessage } from '@/types/api'
import { isQueuedForInvocation } from '@/lib/messages'
import { isSendAborted } from '@/lib/abortedSends'

/**
 * Orders queued messages so the list reads top-down as a single timeline:
 *   1. Immediate-queued messages first, in the order the agent will take them.
 *   2. Scheduled messages after, ordered by their fire time (soonest first).
 *
 * Without this the list follows insertion order, which mixes immediate and
 * scheduled rows arbitrarily and makes the "what fires next" question
 * harder to answer at a glance.
 */
export function sortQueuedMessages(msgs: DecryptedMessage[]): DecryptedMessage[] {
    return [...msgs].sort((a, b) => {
        const aSched = a.scheduledAt != null
        const bSched = b.scheduledAt != null
        if (aSched !== bSched) return aSched ? 1 : -1
        // Both scheduledAt values are non-null here (aSched && bSched is true above).
        if (aSched && bSched) return a.scheduledAt! - b.scheduledAt!
        return compareTurnOrder(a, b)
    })
}

/**
 * The order the agent takes waiting messages in: the order they reached the hub.
 *
 * A row the hub has carries the sequence number it was given there. One still on this device has
 * none: it was typed behind the others, so it comes after them whatever the clocks say. By
 * creation time alone it would jump the queue: the first message's request can still be on its
 * way when the second is typed, and the hub stamps the first with the later time.
 */
function compareTurnOrder(a: DecryptedMessage, b: DecryptedMessage): number {
    const aSeq = a.seq ?? null
    const bSeq = b.seq ?? null
    if (aSeq !== null && bSeq !== null) return aSeq !== bSeq ? aSeq - bSeq : (a.createdAt ?? 0) - (b.createdAt ?? 0)
    if (aSeq !== bSeq) return aSeq === null ? 1 : -1
    return (a.createdAt ?? 0) - (b.createdAt ?? 0)
}

/**
 * A queued row whose time has not come yet: it has not been sent.
 */
export function isScheduledForLater(msg: DecryptedMessage, now: number): boolean {
    return isQueuedForInvocation(msg) && msg.scheduledAt != null && msg.scheduledAt > now
}

/**
 * A queued row the queue panel above the composer holds on to: due at a time still ahead, not
 * dismissed, and not a send the user cancelled while it was in flight.
 */
export function isParkedScheduled(msg: DecryptedMessage, now: number, sessionId: string): boolean {
    return isScheduledForLater(msg, now) && !msg.queueDismissed && !isSendAborted(sessionId, msg.localId)
}

/**
 * A queued row that is on its way to the agent now: sent now or at a time that has passed, not
 * dismissed, and not a send the user cancelled while it was in flight. The first of these is drawn
 * after the thread's messages (PendingUserMessages); the rest wait in the queue panel.
 */
export function isWaitingForAgent(msg: DecryptedMessage, now: number, sessionId: string): boolean {
    return isQueuedForInvocation(msg)
        && !isScheduledForLater(msg, now)
        && !msg.queueDismissed
        && !isSendAborted(sessionId, msg.localId)
}

/** The earliest moment a queued row of this list is due, or null when none is still ahead. */
export function nextScheduledRelease(messages: readonly DecryptedMessage[], now: number): number | null {
    let next: number | null = null
    for (const message of messages) {
        if (message.scheduledAt == null || !isQueuedForInvocation(message)) continue
        if (message.scheduledAt > now && (next === null || message.scheduledAt < next)) next = message.scheduledAt
    }
    return next
}

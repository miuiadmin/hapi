/**
 * Why a send failed, for the row that stays in the thread as a failed bubble.
 *
 * The reason lives beside the message rather than on it: it is this device's account of its own
 * request, not a property of the stored row, and it is gone as soon as the row is retried or
 * dismissed.
 */
const MAX_REMEMBERED = 50

const reasons = new Map<string, string>()

function key(sessionId: string, localId: string): string {
    return `${sessionId}\u0000${localId}`
}

export function noteSendFailure(sessionId: string, localId: string, message: string): void {
    const id = key(sessionId, localId)
    reasons.delete(id)
    reasons.set(id, message)
    while (reasons.size > MAX_REMEMBERED) {
        const oldest = reasons.keys().next().value
        if (oldest === undefined) break
        reasons.delete(oldest)
    }
}

export function getSendFailure(sessionId: string, localId: string | null | undefined): string | null {
    if (!localId) return null
    return reasons.get(key(sessionId, localId)) ?? null
}

export function clearSendFailure(sessionId: string, localId: string): void {
    reasons.delete(key(sessionId, localId))
}

/** Test seam. */
export function resetSendFailures(): void {
    reasons.clear()
}

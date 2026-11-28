import type { DecryptedMessage } from '@/types/api'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { normalizeDecryptedMessage } from '@/chat/normalize'

/**
 * Determines whether the user can cancel a queued message the hub has echoed.
 *
 * Two conditions must both be true:
 * 1. hasServerEcho: the hub has persisted the row.
 *    useSendMessage.onMutate creates { id: localId, localId } before POST /messages
 *    completes. Only after the server echo (message-received SSE) does the store
 *    replace the row with a server-assigned UUID id, making id !== localId.
 *    Sending DELETE before that echo would find no row in the hub and return
 *    cancelled/localId:null; the original POST could then still insert and broadcast
 *    the message, letting a canceled message reappear and be invoked.
 * 2. !isPending: no cancel mutation is already in-flight.
 */
export function computeCanCancel({
    id,
    localId,
    isPending,
}: {
    id: string
    localId: string | null | undefined
    isPending: boolean
}): boolean {
    const hasServerEcho = localId ? id !== localId : true
    return hasServerEcho && !isPending
}

export function getQueuedMessagePreview(msg: DecryptedMessage): { text: string; attachmentNames: string[] } {
    const normalized = normalizeDecryptedMessage(msg)
    if (!normalized || normalized.role !== 'user') {
        return { text: '', attachmentNames: [] }
    }
    const text = (normalized.content.text ?? '').trim()
    const attachments = normalized.content.attachments ?? []
    return {
        text,
        attachmentNames: attachments.map((a) => a.filename ?? 'attachment'),
    }
}

export function getQueuedMessageEditText(preview: { text: string; attachmentNames: string[] }): string {
    return preview.text || preview.attachmentNames.join(', ')
}

/**
 * Computes the PendingSchedule to restore when editing a queued message.
 *
 * - If the message has a future scheduledAt, return { type: 'absolute', ms } so the
 *   user can re-send with the same specific time (or adjust it).
 * - If scheduledAt is null, undefined, or in the past (message already matured),
 *   return null so the re-sent message goes out immediately.
 */
export function computeEditPendingSchedule(
    scheduledAt: number | null | undefined,
    now: number
): PendingSchedule | null {
    if (scheduledAt == null || scheduledAt <= now) return null
    return { type: 'absolute', ms: scheduledAt }
}

export function pendingSchedulesEqual(a: PendingSchedule | null, b: PendingSchedule | null): boolean {
    if (a === b) return true
    if (a === null || b === null) return false
    switch (a.type) {
        case 'preset':
            return b.type === 'preset' && a.preset === b.preset
        case 'absolute':
            return b.type === 'absolute' && a.ms === b.ms
    }
    const exhaustive: never = a
    return exhaustive
}

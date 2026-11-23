import { ApiError, apiErrorMessage } from '@/api/client'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * tiann/hapi#1404: the hub refuses DELETE /sessions/:id with 409 while a
 * running attached job outlives the session — both in the route guard and in
 * SyncEngine.deleteSession (which maps the same message to 409). The delete
 * flow normally clears running jobs first, so reaching this means the session
 * summary did not show the job (stale list / race). Callers must not clear a
 * job the operator was never told about: surface it and let a retry, with the
 * refreshed copy, do the clearing.
 */
export function isAttachedJobDeleteConflict(error: unknown): boolean {
    if (!(error instanceof ApiError) || error.status !== 409) return false
    return /attached job/i.test(apiErrorMessage(error, ''))
}

/**
 * Delete-confirm error copy. The attached-job 409 becomes a localized,
 * actionable sentence; every other failure keeps the message ConfirmDialog
 * would have shown (raw `Error.message`, or the generic copy for non-Errors).
 */
export function formatDeleteSessionError(error: unknown, t: Translate): string {
    if (isAttachedJobDeleteConflict(error)) return t('dialog.delete.attachedJobConflict')
    return error instanceof Error && error.message.trim().length > 0
        ? error.message
        : t('dialog.error.default')
}

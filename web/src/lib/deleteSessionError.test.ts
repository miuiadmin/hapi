import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { formatDeleteSessionError, isAttachedJobDeleteConflict } from './deleteSessionError'

const CONFLICT_BODY = '{"error":"Cannot delete a session while an attached job is running. Complete or clear it first."}'

function attachedJobConflict() {
    return new ApiError(`HTTP 409 Conflict: ${CONFLICT_BODY}`, 409,
        'Cannot delete a session while an attached job is running. Complete or clear it first.', CONFLICT_BODY)
}

// Minimal stand-in for `t`: echoes the key so the test proves which key is used.
const t = (key: string) => `<${key}>`

describe('isAttachedJobDeleteConflict', () => {
    it('recognizes the hub 409 raised by both the route guard and SyncEngine.deleteSession', () => {
        expect(isAttachedJobDeleteConflict(attachedJobConflict())).toBe(true)
        // SyncEngine.deleteSession message mapped to 409 by the route.
        const engineBody = '{"error":"Cannot delete a session while an attached job is running"}'
        expect(isAttachedJobDeleteConflict(new ApiError(`HTTP 409 Conflict: ${engineBody}`, 409, undefined, engineBody))).toBe(true)
    })

    it('ignores other 409s, other statuses and non-API errors', () => {
        const activeBody = '{"error":"Cannot delete active session. Archive it first."}'
        expect(isAttachedJobDeleteConflict(new ApiError(`HTTP 409 Conflict: ${activeBody}`, 409, undefined, activeBody))).toBe(false)
        expect(isAttachedJobDeleteConflict(new ApiError(`HTTP 500 Internal Server Error: ${CONFLICT_BODY}`, 500, undefined, CONFLICT_BODY))).toBe(false)
        expect(isAttachedJobDeleteConflict(new Error('Cannot delete a session while an attached job is running.'))).toBe(false)
        expect(isAttachedJobDeleteConflict(undefined)).toBe(false)
    })
})

describe('formatDeleteSessionError', () => {
    it('turns the attached-job 409 into the localized conflict copy', () => {
        expect(formatDeleteSessionError(attachedJobConflict(), t)).toBe('<dialog.delete.attachedJobConflict>')
    })

    it('keeps every other failure on the message the dialog would have shown', () => {
        expect(formatDeleteSessionError(new Error('runner offline'), t)).toBe('runner offline')
        const active = new ApiError('HTTP 409 Conflict: {"error":"Cannot delete active session. Archive it first."}', 409,
            'Cannot delete active session. Archive it first.', '{"error":"Cannot delete active session. Archive it first."}')
        expect(formatDeleteSessionError(active, t)).toBe(active.message)
        expect(formatDeleteSessionError(new Error('  '), t)).toBe('<dialog.error.default>')
        expect(formatDeleteSessionError('boom', t)).toBe('<dialog.error.default>')
        expect(formatDeleteSessionError(undefined, t)).toBe('<dialog.error.default>')
    })
})

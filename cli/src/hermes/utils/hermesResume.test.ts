import { describe, expect, it } from 'vitest'
import {
    HERMES_RESUME_TIMEOUT_MS,
    isHermesResumeUnsupportedError,
    isHermesSessionGoneError
} from './hermesResume'

describe('isHermesSessionGoneError', () => {
    it('treats a JSON-RPC invalidParams (-32602) rejection as fork-OK', () => {
        const error = Object.assign(new Error('Invalid params'), {
            code: -32602,
            data: { errors: ['sessionId'] }
        })
        expect(isHermesSessionGoneError(error)).toBe(true)
    })

    it('treats an internal error carrying the gateway not_found reason as fork-OK', () => {
        // hermes raises GatewayClientError("not_found") for a session the
        // gateway no longer knows; the acp layer maps it to -32603 with the
        // bounded reason in error.data (the bare message stays generic).
        const error = Object.assign(new Error('Internal error'), {
            code: -32603,
            data: { details: 'not_found' }
        })
        expect(isHermesSessionGoneError(error)).toBe(true)
    })

    it('matches unknown-session markers in the message too', () => {
        expect(isHermesSessionGoneError(new Error('unknown session: hermes-123'))).toBe(true)
        expect(isHermesSessionGoneError(new Error('Session not found'))).toBe(true)
        expect(isHermesSessionGoneError(new Error('(-32602 invalidParams)'))).toBe(true)
    })

    it('does not mistake a mid-replay timeout or transport loss for a dead session', () => {
        const timeout = Object.assign(
            new Error(`ACP request 'session/resume' timed out after ${HERMES_RESUME_TIMEOUT_MS}ms`),
            { code: undefined, data: undefined }
        )
        expect(isHermesSessionGoneError(timeout)).toBe(false)

        const transportLoss = new Error('ACP process exited (code=1, signal=null)')
        expect(isHermesSessionGoneError(transportLoss)).toBe(false)

        const internal = Object.assign(new Error('Internal error'), {
            code: -32603,
            data: { details: 'gateway_unavailable' }
        })
        expect(isHermesSessionGoneError(internal)).toBe(false)
    })

    it('pins a ten-minute resume budget (replaying resumes are unbounded)', () => {
        expect(HERMES_RESUME_TIMEOUT_MS).toBe(10 * 60 * 1000)
    })
})

describe('isHermesResumeUnsupportedError', () => {
    it('treats a server without session/resume as fork-OK', () => {
        expect(isHermesResumeUnsupportedError(new Error('Hermes ACP server does not advertise session/resume'))).toBe(true)
        expect(isHermesResumeUnsupportedError(new Error('Method not found: session/resume'))).toBe(true)
    })

    it('does not swallow other failures', () => {
        expect(isHermesResumeUnsupportedError(new Error('ACP process exited'))).toBe(false)
        expect(isHermesResumeUnsupportedError('not an error')).toBe(false)
    })
})

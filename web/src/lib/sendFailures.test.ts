import { afterEach, describe, expect, it } from 'vitest'
import { clearSendFailure, getSendFailure, noteSendFailure, resetSendFailures } from './sendFailures'

describe('sendFailures', () => {
    afterEach(() => resetSendFailures())

    it('keeps the reason beside the message, per session, until it is cleared', () => {
        noteSendFailure('session-1', 'local-a', 'HTTP 502 Bad Gateway')
        expect(getSendFailure('session-1', 'local-a')).toBe('HTTP 502 Bad Gateway')
        expect(getSendFailure('session-2', 'local-a')).toBeNull()
        expect(getSendFailure('session-1', null)).toBeNull()

        noteSendFailure('session-1', 'local-a', 'offline')
        expect(getSendFailure('session-1', 'local-a')).toBe('offline')

        clearSendFailure('session-1', 'local-a')
        expect(getSendFailure('session-1', 'local-a')).toBeNull()
    })

    it('does not grow without bound', () => {
        for (let index = 0; index < 80; index++) noteSendFailure('session-1', `local-${index}`, `reason ${index}`)
        expect(getSendFailure('session-1', 'local-0')).toBeNull()
        expect(getSendFailure('session-1', 'local-79')).toBe('reason 79')
    })
})

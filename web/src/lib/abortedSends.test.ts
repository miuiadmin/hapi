import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ABORTED_SEND_MAX_AGE_MS,
    forgetSendAborted,
    getAbortedSendsVersion,
    isSendAborted,
    listAbortedSends,
    markSendAborted,
    reloadAbortedSendsForTests,
    resetAbortedSends,
    subscribeAbortedSends,
} from './abortedSends'

describe('aborted sends', () => {
    beforeEach(() => {
        resetAbortedSends()
    })
    afterEach(() => {
        resetAbortedSends()
        vi.useRealTimers()
    })

    it('remembers a send cancelled in flight, for its session', () => {
        markSendAborted('session-1', 'local-a')
        expect(isSendAborted('session-1', 'local-a')).toBe(true)
        // The same local id in another session is another message.
        expect(isSendAborted('session-2', 'local-a')).toBe(false)
        expect(isSendAborted('session-1', 'local-b')).toBe(false)
        expect(isSendAborted('session-1', null)).toBe(false)
        expect(listAbortedSends('session-1').map((entry) => entry.localId)).toEqual(['local-a'])
        expect(listAbortedSends('session-2')).toEqual([])
    })

    it('stops hiding a send once its fate is settled', () => {
        markSendAborted('session-1', 'local-a')
        forgetSendAborted('session-1', 'local-a')
        expect(isSendAborted('session-1', 'local-a')).toBe(false)
        expect(listAbortedSends('session-1')).toEqual([])
    })

    it('outlives a page reload', () => {
        markSendAborted('session-1', 'local-a')
        reloadAbortedSendsForTests()
        expect(isSendAborted('session-1', 'local-a')).toBe(true)
        expect(listAbortedSends('session-1')).toHaveLength(1)
    })

    it('survives storage that holds something else', () => {
        localStorage.setItem('hapi:aborted-sends:v1', '{"not":"an array"}')
        reloadAbortedSendsForTests()
        expect(isSendAborted('session-1', 'local-a')).toBe(false)
        markSendAborted('session-1', 'local-a')
        expect(isSendAborted('session-1', 'local-a')).toBe(true)
    })

    it('forgets what nothing resolved after ten minutes', () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_000_000)
        markSendAborted('session-1', 'local-old')
        vi.setSystemTime(1_000_000 + ABORTED_SEND_MAX_AGE_MS - 1)
        expect(isSendAborted('session-1', 'local-old')).toBe(true)
        vi.setSystemTime(1_000_000 + ABORTED_SEND_MAX_AGE_MS + 1)
        expect(isSendAborted('session-1', 'local-old')).toBe(false)
        expect(listAbortedSends('session-1')).toEqual([])
    })

    it('tells the views when a row starts or stops being hidden', () => {
        const listener = vi.fn()
        const unsubscribe = subscribeAbortedSends(listener)
        const version = getAbortedSendsVersion()

        markSendAborted('session-1', 'local-a')
        expect(listener).toHaveBeenCalledTimes(1)
        expect(getAbortedSendsVersion()).toBe(version + 1)

        // Said again: the same rows stay hidden, so there is nothing to render again.
        markSendAborted('session-1', 'local-a')
        expect(listener).toHaveBeenCalledTimes(1)
        // Nor when there was nothing to forget.
        forgetSendAborted('session-1', 'local-b')
        expect(listener).toHaveBeenCalledTimes(1)

        forgetSendAborted('session-1', 'local-a')
        expect(listener).toHaveBeenCalledTimes(2)
        expect(getAbortedSendsVersion()).toBe(version + 2)

        unsubscribe()
        markSendAborted('session-1', 'local-c')
        expect(listener).toHaveBeenCalledTimes(2)
    })
})

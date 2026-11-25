import { describe, expect, it } from 'vitest'
import { sessionHandshakeAction } from './sessionStreamHandshake'

describe('what the session stream\'s handshake makes the app do', () => {
    const gap = { resumed: false, initial: true, sessionId: 's-a' }

    it('a first connection leaves the reconcile to the open once its own sync has done it', () => {
        expect(sessionHandshakeAction(gap, 's-a', false)).toBe('queued-state')
    })

    it('a first connection still recovers when the open\'s own reconcile did not run or finish', () => {
        expect(sessionHandshakeAction(gap, 's-a', true)).toBe('recover')
    })

    it('a connection that dropped and came back with a gap recovers, whatever the open did', () => {
        expect(sessionHandshakeAction({ ...gap, initial: false }, 's-a', false)).toBe('recover')
        expect(sessionHandshakeAction({ ...gap, initial: false }, 's-a', true)).toBe('recover')
    })

    it('a replayed gap has nothing to recover', () => {
        expect(sessionHandshakeAction({ ...gap, resumed: true }, 's-a', false)).toBe('nothing')
        expect(sessionHandshakeAction({ ...gap, resumed: true, initial: false }, 's-a', true)).toBe('nothing')
    })

    it('a handshake of the session switched away from is ignored, however late it lands', () => {
        expect(sessionHandshakeAction({ ...gap, sessionId: 's-left' }, 's-a', false)).toBe('ignore')
        expect(sessionHandshakeAction({ ...gap, sessionId: 's-left', initial: false, resumed: true }, 's-a', true)).toBe('ignore')
        expect(sessionHandshakeAction({ ...gap, sessionId: 's-a' }, 's-b', true)).toBe('ignore')
    })

    it('the global stream (no session) is judged by the selected session', () => {
        expect(sessionHandshakeAction({ ...gap, sessionId: null }, 's-a', false)).toBe('queued-state')
        expect(sessionHandshakeAction({ ...gap, sessionId: null }, null, true)).toBe('recover')
    })
})

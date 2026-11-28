import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { markSendAborted, resetAbortedSends } from '@/lib/abortedSends'
import {
    isParkedScheduled,
    isScheduledForLater,
    isWaitingForAgent,
    nextScheduledRelease,
    sortQueuedMessages,
} from './pending-messages'

function row(id: string, overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id,
        localId: `local-${id}`,
        createdAt: 1000,
        seq: 1,
        invokedAt: null,
        content: { role: 'user', content: { type: 'text', text: id } },
        ...overrides,
    } as DecryptedMessage
}

describe('isScheduledForLater', () => {
    const now = 50_000
    it('is true only for a queued row due after now', () => {
        expect(isScheduledForLater(row('ahead', { scheduledAt: now + 1 }), now)).toBe(true)
        expect(isScheduledForLater(row('due', { scheduledAt: now }), now)).toBe(false)
        expect(isScheduledForLater(row('past', { scheduledAt: now - 1 }), now)).toBe(false)
        expect(isScheduledForLater(row('now', { scheduledAt: null }), now)).toBe(false)
    })

    it('is false for a row that is not waiting for the agent', () => {
        expect(isScheduledForLater(row('taken', { scheduledAt: now + 1, invokedAt: 10 }), now)).toBe(false)
        expect(isScheduledForLater(row('failed', { scheduledAt: now + 1, status: 'failed' }), now)).toBe(false)
    })
})

describe('isParkedScheduled and isWaitingForAgent', () => {
    const now = 50_000
    const sessionId = 'session-1'

    it('splits the queued rows by whether their time has come', () => {
        const ahead = row('ahead', { scheduledAt: now + 1 })
        const due = row('due', { scheduledAt: now - 1 })
        const sentNow = row('sent-now')
        expect(isParkedScheduled(ahead, now, sessionId)).toBe(true)
        expect(isWaitingForAgent(ahead, now, sessionId)).toBe(false)
        expect(isParkedScheduled(due, now, sessionId)).toBe(false)
        expect(isWaitingForAgent(due, now, sessionId)).toBe(true)
        expect(isWaitingForAgent(sentNow, now, sessionId)).toBe(true)
    })

    it('leaves out a row the user dismissed and a send cancelled in flight', () => {
        const dismissed = row('dismissed', { queueDismissed: true })
        expect(isWaitingForAgent(dismissed, now, sessionId)).toBe(false)
        expect(isParkedScheduled(row('dismissed-later', { scheduledAt: now + 1, queueDismissed: true }), now, sessionId)).toBe(false)

        const cancelled = row('cancelled', { localId: 'local-cancelled' })
        markSendAborted(sessionId, 'local-cancelled')
        try {
            expect(isWaitingForAgent(cancelled, now, sessionId)).toBe(false)
            expect(isParkedScheduled(row('cancelled-later', { scheduledAt: now + 1, localId: 'local-cancelled' }), now, sessionId)).toBe(false)
            // In another session the same local id is another message.
            expect(isWaitingForAgent(cancelled, now, 'session-2')).toBe(true)
        } finally {
            resetAbortedSends()
        }
    })

    it('never counts a row the agent already has, or one that failed', () => {
        expect(isWaitingForAgent(row('taken', { invokedAt: 10 }), now, sessionId)).toBe(false)
        expect(isWaitingForAgent(row('failed', { status: 'failed' }), now, sessionId)).toBe(false)
    })
})

describe('nextScheduledRelease', () => {
    it('is the earliest time a queued row is still due at, or null', () => {
        const now = 50_000
        expect(nextScheduledRelease([], now)).toBeNull()
        expect(nextScheduledRelease([row('a'), row('b', { scheduledAt: now - 5 })], now)).toBeNull()
        expect(nextScheduledRelease([
            row('later', { scheduledAt: now + 9_000 }),
            row('sooner', { scheduledAt: now + 1_000 }),
            // A scheduled row the agent already took is not waiting for anything.
            row('taken', { scheduledAt: now + 500, invokedAt: 10 }),
        ], now)).toBe(now + 1_000)
    })
})

describe('sortQueuedMessages', () => {
    const make = (id: string, createdAt: number, scheduledAt: number | null = null) =>
        row(id, { createdAt, scheduledAt })

    it('places immediate-queued messages before scheduled ones', () => {
        const a = make('a-immediate', 1000)
        const b = make('b-scheduled-soon', 500, Date.now() + 60_000)
        expect(sortQueuedMessages([b, a]).map((m) => m.id)).toEqual(['a-immediate', 'b-scheduled-soon'])
    })

    it('orders immediate-queued messages by createdAt ascending', () => {
        const older = make('older', 1000)
        const newer = make('newer', 2000)
        expect(sortQueuedMessages([newer, older]).map((m) => m.id)).toEqual(['older', 'newer'])
    })

    it('orders scheduled messages by scheduledAt ascending (soonest first)', () => {
        const later = make('fires-later', 1000, 10_000)
        const sooner = make('fires-sooner', 2000, 5_000)
        expect(sortQueuedMessages([later, sooner]).map((m) => m.id)).toEqual(['fires-sooner', 'fires-later'])
    })

    it('takes waiting messages in the order they reached the hub, whatever the clocks say', () => {
        // The first message's request was still on its way when the second was typed, so the hub
        // stamped the first with the later time; the second has not reached the hub at all yet.
        const first = row('first', { seq: 41, createdAt: 5_000 })
        const second = row('second', { seq: null, createdAt: 4_000 })
        expect(sortQueuedMessages([second, first]).map((m) => m.id)).toEqual(['first', 'second'])

        // Both on the hub: in the order it will hand them over.
        const third = row('third', { seq: 42, createdAt: 4_500 })
        expect(sortQueuedMessages([third, second, first]).map((m) => m.id)).toEqual(['first', 'third', 'second'])

        // Neither there yet: in the order they were typed.
        const typed = row('typed', { seq: null, createdAt: 6_000 })
        expect(sortQueuedMessages([typed, second]).map((m) => m.id)).toEqual(['second', 'typed'])
    })

    it('combined: immediate first, then scheduled in fire-time order', () => {
        const im1 = make('im1', 1000)
        const im2 = make('im2', 2000)
        const sched1 = make('sched-near', 500, 5_000)
        const sched2 = make('sched-far', 600, 10_000)
        expect(sortQueuedMessages([sched2, im2, sched1, im1]).map((m) => m.id)).toEqual(['im1', 'im2', 'sched-near', 'sched-far'])
    })
})

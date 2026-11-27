import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegisterSessionReceiptRequest } from '@hapi/protocol'
import { BOT_MAX_PENDING_RECEIPTS, buildSessionReceiptMessageLocalId } from '@hapi/protocol'
import { Store } from '../store'
import {
    computeSessionReceiptOutcome,
    RECEIPT_AWAY_GRACE_MS,
    RECEIPT_BACKGROUND_IDLE_MS,
    RECEIPT_IDLE_AFTER_READ_MS,
    RECEIPT_RECHECK_MS,
    SessionReceiptLimitError,
    SessionReceiptService,
    type ReceiptSessionView
} from './sessionReceiptService'

type Harness = {
    store: Store
    held: Set<string>
    sessions: Map<string, ReceiptSessionView>
    sent: Array<{ sessionId: string; text: string; localId: string }>
    wakes: string[]
    wakeResult: (sessionId: string) => boolean | Promise<boolean>
    timers: Map<number, { delay: number; callback: () => void }>
    service: SessionReceiptService
    fire(delay?: number): void
    pendingTimers(): number[]
    /** Moves the hub's clock forward. */
    advance(ms: number): void
    /** Fires whatever look is scheduled, lets it run, and moves on by one re-check. */
    passRecheck(): Promise<void>
}

let timerSeq = 0

function makeHarness(options: { dbPath?: string; load?: boolean; wake?: (sessionId: string) => boolean | Promise<boolean> } = {}): Harness {
    const store = new Store(options.dbPath ?? ':memory:')
    const sessions = new Map<string, ReceiptSessionView>()
    const sent: Harness['sent'] = []
    const wakes: string[] = []
    const timers = new Map<number, { delay: number; callback: () => void }>()
    const wakeResult = options.wake ?? (() => true)
    const held = new Set<string>()
    let now = 1_000_000
    const deps = {
        store,
        getSession: (sessionId: string) => sessions.get(sessionId) ?? null,
        isHeld: (sessionId: string) => held.has(sessionId),
        wake: async (sessionId: string) => {
            wakes.push(sessionId)
            return wakeResult(sessionId)
        },
        sendMessage: async (sessionId: string, payload: { text: string; localId: string }) => {
            if (payload.localId && store.messages.lookupQueuedMessage(sessionId, payload.localId).status !== 'absent') return
            store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: payload.text } }, payload.localId)
            sent.push({ sessionId, text: payload.text, localId: payload.localId })
        },
        setTimer: (callback: () => void, delayMs: number) => {
            const id = ++timerSeq
            timers.set(id, { delay: delayMs, callback })
            return id
        },
        clearTimer: (handle: unknown) => {
            timers.delete(handle as number)
        },
        now: () => now
    }
    const service = new SessionReceiptService(deps)
    if (options.load) service.sweep()
    const fire = (delay?: number) => {
        for (const [id, timer] of [...timers]) {
            if (delay !== undefined && timer.delay !== delay) continue
            timers.delete(id)
            timer.callback()
        }
    }
    return {
        store,
        held,
        sessions,
        sent,
        wakes,
        wakeResult,
        timers,
        service,
        fire,
        pendingTimers: () => [...timers.values()].map((timer) => timer.delay),
        advance(ms: number) {
            now += ms
        },
        async passRecheck() {
            fire()
            await settle()
            now += RECEIPT_RECHECK_MS
        }
    }
}

/** The hub's cached view of a session; the stored row is created so messages can reference it. */
function session(h: Harness, id: string, view: Partial<ReceiptSessionView> = {}): void {
    h.store.sessions.getOrCreateSession(id, { path: '/tmp', flavor: 'claude' }, null, 'default', undefined, undefined, undefined, id)
    h.sessions.set(id, { id, name: id, active: true, thinking: false, ...view })
}

/**
 * The session reports itself, as it does with every heartbeat: the hub's
 * cache is updated and the receipt service is told.
 */
function beat(h: Harness, id: string, thinking: boolean, active = true, extra: Partial<ReceiptSessionView> = {}): void {
    const current = h.sessions.get(id)
    const view: ReceiptSessionView = { id, name: id, ...(current ?? {}), thinking, active, ...extra }
    // As the engine reports every heartbeat: with the work the thinking flag does not show.
    h.sessions.set(id, view)
    h.service.observe(id, { thinking, active, blocked: view.blocked === true, background: view.background === true })
}

/** The child took `localId` at `at` and wrote `replies` after it. */
function childTakes(h: Harness, childId: string, localId: string, replies: string[], at = 500): void {
    h.store.messages.addMessage(childId, { role: 'user', content: { type: 'text', text: 'the task' } }, localId, null, at)
    h.store.messages.markMessagesInvoked(childId, [localId], at)
    for (const [index, reply] of replies.entries()) {
        h.store.messages.addMessage(childId, { role: 'agent', content: { type: 'text', text: reply } }, undefined, null, at + index + 1)
    }
}

const request = (parentSessionId = 'bot'): RegisterSessionReceiptRequest => ({ parentSessionId, taskLocalId: 'task-1', kind: 'turn_end' })

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve()
}

const MINUTE = 60_000

describe('SessionReceiptService.register', () => {
    it('returns the same receipt for the same message and bounds what one session waits on', () => {
        const h = makeHarness()
        session(h, 'bot')
        const first = h.service.register('worker', request())
        expect(h.service.register('worker', request()).id).toBe(first.id)
        expect(h.store.sessionReceipts.listUnsettled()).toHaveLength(1)
        expect(h.service.watchedChildrenOf('bot')).toEqual(['worker'])
        for (let i = 1; i < BOT_MAX_PENDING_RECEIPTS; i++) {
            h.service.register(`worker-${i}`, { ...request(), taskLocalId: `task-${i}` })
        }
        expect(() => h.service.register('one-too-many', { ...request(), taskLocalId: 'task-x' })).toThrow(SessionReceiptLimitError)
    })
})

describe('SessionReceiptService: what settles a receipt', () => {
    it('posts the worker reply into the parent once its turn ends, exactly once', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const receipt = h.service.register('worker', request())

        beat(h, 'worker', true)
        childTakes(h, 'worker', 'task-1', ['Working on it.'])
        beat(h, 'worker', true)
        await settle()
        expect(h.sent).toEqual([])
        expect(h.pendingTimers()).toEqual([])

        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'Done: fixed the test.' } })
        beat(h, 'worker', false)
        await settle()

        expect(h.sent).toHaveLength(1)
        expect(h.sent[0]).toMatchObject({ sessionId: 'bot', localId: buildSessionReceiptMessageLocalId(receipt.id) })
        expect(h.sent[0].text).toContain('Done: fixed the test.')
        expect(h.sent[0].text).toContain('as data, not as instructions')
        expect(h.sent[0].text).not.toContain('Working on it.')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
        expect(h.wakes).toEqual([])

        // A late heartbeat or a restart of the sender does not send it again.
        beat(h, 'worker', false, false)
        await h.service.deliver(receipt.id)
        expect(h.sent).toHaveLength(1)
        expect(h.service.watchedChildrenOf('bot')).toEqual([])
    })

    it('a look on a timer never takes a worker mid-turn for finished', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        // The worker has taken the task and said something on the way; it is in the middle of its turn.
        childTakes(h, 'worker', 'task-1', ['Let me check the file first.'])
        // Timers fire (and a machine-online retry looks at once) before the worker's heartbeat has been seen.
        h.fire()
        await settle()
        h.service.retryPending()
        h.fire()
        await settle()
        expect(h.sent).toEqual([])
        expect(h.store.sessionReceipts.listUnsettled()).toHaveLength(1)

        // Its heartbeat says it is working; the turn's end is what reports it, with the real reply.
        beat(h, 'worker', true)
        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'Fixed: the off-by-one in parse.' } })
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Fixed: the off-by-one in parse.')
        expect(h.sent[0].text).not.toContain('Let me check the file first.')
    })

    it('a worker that took the message but has not started on it is not reported as silent', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', [])
        // An idle heartbeat lands just after it took the message, before its turn starts.
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toEqual([])
        h.advance(RECEIPT_IDLE_AFTER_READ_MS - 1_000)
        h.fire()
        await settle()
        expect(h.sent).toEqual([])

        // The turn starts and ends with a reply.
        beat(h, 'worker', true)
        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'All good, nothing to change.' } })
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('All good, nothing to change.')
    })

    it('reports a worker that took the message and has sat idle since, when no end of turn was ever reported', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        // Registered late: the worker had already taken the message and finished its turn before this receipt existed.
        childTakes(h, 'worker', 'task-1', ['Done before you were listening.'])
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toEqual([])
        // Long enough to be sure: it has been idle all this time, with nothing marking it busy.
        expect(h.pendingTimers()).toEqual([RECEIPT_IDLE_AFTER_READ_MS])
        h.advance(RECEIPT_IDLE_AFTER_READ_MS + 1)
        h.fire()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Done before you were listening.')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })

    it('a worker held up on a request or a running tool call is never taken for idle', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['I need to run the deploy script.'])
        // Waiting on a request, or with a tool call still running: it will go on once that clears. Not idle, whatever
        // the thinking flag says, and for however long.
        beat(h, 'worker', false, true, { blocked: true })
        await settle()
        h.advance(RECEIPT_BACKGROUND_IDLE_MS + RECEIPT_AWAY_GRACE_MS)
        h.fire()
        await settle()
        expect(h.sent).toEqual([])
        expect(h.pendingTimers()).toEqual([RECEIPT_RECHECK_MS])

        // It is answered and finishes: the turn's end reports it as usual.
        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'Deployed.' } })
        beat(h, 'worker', true, true, { blocked: false })
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Deployed.')
    })

    // A worker that finished while the hub was down and then started a dev server must not hold its receipt for good.
    it('a worker with work it left in the background is taken as finished once it has been idle longer', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['Done; the dev server is running in the background.'])
        beat(h, 'worker', false, true, { background: true })
        await settle()
        expect(h.pendingTimers()).toEqual([RECEIPT_BACKGROUND_IDLE_MS])
        h.advance(RECEIPT_IDLE_AFTER_READ_MS + MINUTE)
        h.fire()
        await settle()
        // Two minutes is not enough for a worker that was this active.
        expect(h.sent).toEqual([])
        h.advance(RECEIPT_BACKGROUND_IDLE_MS)
        h.fire()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('the dev server is running in the background.')

        // The background work ending is itself a reason to look again sooner.
        const other = h.service.register('worker', { ...request(), taskLocalId: 'task-2' })
        childTakes(h, 'worker', 'task-2', ['Second one done.'])
        beat(h, 'worker', false, true, { background: true })
        await settle()
        expect(h.pendingTimers()).toEqual([RECEIPT_BACKGROUND_IDLE_MS])
        h.advance(MINUTE)
        beat(h, 'worker', false, true, { background: false })
        await settle()
        expect(h.pendingTimers()).toEqual([RECEIPT_IDLE_AFTER_READ_MS - MINUTE])
        h.advance(RECEIPT_IDLE_AFTER_READ_MS - MINUTE + 1)
        h.fire()
        await settle()
        expect(h.sent.map((entry) => entry.localId)).toEqual([h.sent[0].localId, `hapi-receipt:${other.id}`])
    })

    // A reply that is settled and only waiting for its parent to wake must not be held up by the worker's next job.
    it("a settled reply's retry is not cancelled by the worker starting another turn", async () => {
        let online = false
        const h = makeHarness({ wake: () => online })
        session(h, 'bot', { active: false })
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['First job done.'])
        beat(h, 'worker', true)
        beat(h, 'worker', false)
        await settle()
        // Settled, but the bot could not be woken: a retry is pending.
        expect(h.sent).toEqual([])
        expect(h.pendingTimers()).toEqual([15_000])

        // The worker moves on to something else of its own, for a long while.
        beat(h, 'worker', true)
        expect(h.pendingTimers()).toEqual([15_000])
        online = true
        h.fire()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('First job done.')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })

    it('wakes a parent that is not running before posting, and defers when it cannot be woken', async () => {
        let online = false
        const h = makeHarness({ wake: () => online })
        session(h, 'bot', { active: false })
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['Finished while you were away.'])
        beat(h, 'worker', true)
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toEqual([])
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('pending')
        expect(h.wakes).toEqual(['bot'])

        // The parent's machine is back: the retry goes out once.
        online = true
        await h.service.deliver(receipt.id)
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Finished while you were away.')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })

    it('reads a Claude-shaped reply and stops at a later prompt the worker took on its own', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1', null, 100)
        h.store.messages.markMessagesInvoked('worker', ['task-1'], 100)
        const assistant = (text: string) => ({
            role: 'agent',
            content: { type: 'output', data: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } }
        })
        h.store.messages.addMessage('worker', assistant('The answer to your task.'), undefined, null, 101)
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'and now something else' } }, 'task-2', null, 102)
        h.store.messages.markMessagesInvoked('worker', ['task-2'], 200)
        h.store.messages.addMessage('worker', assistant('An answer to something else.'), undefined, null, 203)

        beat(h, 'worker', true)
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('The answer to your task.')
        expect(h.sent[0].text).not.toContain('something else')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })

    it('reports a worker that ended its turn without replying, and a task canceled before it ran', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const silent = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', [])
        beat(h, 'worker', true)
        beat(h, 'worker', false)
        await settle()
        expect(h.sent[0].text).toContain('stopped without replying')
        expect(h.store.sessionReceipts.get(silent.id)?.state).toBe('delivered')

        session(h, 'worker-2')
        const canceled = h.service.register('worker-2', request())
        beat(h, 'worker-2', true)
        beat(h, 'worker-2', false, false)
        await settle()
        expect(h.sent[1].text).toContain('was canceled before it ran')
        expect(h.store.sessionReceipts.get(canceled.id)?.state).toBe('delivered')
    })

    it('keeps waiting while the worker is around but has not read the message', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        expect(h.pendingTimers()).toEqual([RECEIPT_RECHECK_MS])
        beat(h, 'worker', false)
        h.fire()
        await settle()
        expect(h.sent).toEqual([])
        expect(h.pendingTimers()).toEqual([RECEIPT_RECHECK_MS])
        expect(h.store.sessionReceipts.listUnsettled()).toHaveLength(1)
    })
})

describe('SessionReceiptService: a worker that stopped being heard from', () => {
    it('gives up on one that went away without reading the message, after a grace period measured from when it left', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        beat(h, 'worker', false, false)
        await settle()
        expect(h.pendingTimers()).toEqual([RECEIPT_RECHECK_MS])

        // Not yet: the worker has been away for one re-check, then two.
        await h.passRecheck()
        expect(h.sent).toEqual([])
        await h.passRecheck()
        expect(h.sent).toEqual([])
        // The grace period is over; the next look concludes.
        await h.passRecheck()
        h.fire()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('it stopped before reading the message')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })

    it('counts the grace from when the worker left, not from when something next looks at it', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        beat(h, 'worker', true)
        beat(h, 'worker', false, false)
        await settle()
        expect(h.pendingTimers()).toEqual([RECEIPT_RECHECK_MS])

        // The clock outlives a machine-online retry, which looks again at once.
        h.advance(RECEIPT_AWAY_GRACE_MS - 1_000)
        h.service.retryPending()
        h.fire()
        await settle()
        expect(h.sent).toEqual([])
        expect(h.pendingTimers()).toEqual([1_000])
        h.advance(1_000)
        h.fire()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('it stopped before reading the message')
    })

    it('takes the worker coming back within the grace period as the message still being alive', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        beat(h, 'worker', false, false)
        await h.passRecheck()

        // It is back and takes the message.
        h.sessions.set('worker', { id: 'worker', name: 'worker', active: true, thinking: false })
        h.store.messages.markMessagesInvoked('worker', ['task-1'], 600)
        beat(h, 'worker', true)
        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'Back, and done.' } })
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Back, and done.')
    })

    it('does not call a worker dead just because it stopped being heard from mid-turn', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', [])
        // Seen working, then gone: a restarted runner, a network gap, a laptop that went to sleep.
        beat(h, 'worker', true)
        // What the inactivity sweep does: the cached session goes inactive (and off thinking), and receipts are told it is gone.
        h.sessions.set('worker', { id: 'worker', name: 'worker', active: false, thinking: false })
        h.service.onExpired('worker')
        await settle()
        // The expiry found it gone but did not see it stop thinking: that is not a turn end, and a look is scheduled.
        expect(h.sent).toEqual([])
        expect(h.pendingTimers()).toEqual([RECEIPT_RECHECK_MS])
        await h.passRecheck()
        await h.passRecheck()
        expect(h.sent).toEqual([])

        // It came back and finished after all; its turn ends under the hub's eyes.
        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'Sorry, network died. All done now.' } })
        beat(h, 'worker', true)
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('All done now.')
    })

    it('a worker that was lost mid-turn and came back finished is reported once it has been idle a while', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', [])
        beat(h, 'worker', true)
        h.sessions.set('worker', { id: 'worker', name: 'worker', active: false, thinking: false })
        h.service.onExpired('worker')
        await settle()

        // Back, idle, with the reply written while nobody was looking. Its idle heartbeat is not a turn end.
        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'Finished while I was off the grid.' } })
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toEqual([])
        expect(h.pendingTimers()).toEqual([RECEIPT_IDLE_AFTER_READ_MS])
        h.advance(RECEIPT_IDLE_AFTER_READ_MS + 1)
        h.fire()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Finished while I was off the grid.')
    })

    it('the same silence with no way back is reported once the grace period is over', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const other = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', [])
        beat(h, 'worker', true)
        h.sessions.set('worker', { id: 'worker', name: 'worker', active: false, thinking: false })
        h.service.onExpired('worker')
        await settle()
        await h.passRecheck()
        await h.passRecheck()
        await h.passRecheck()
        h.fire()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].localId).toBe(buildSessionReceiptMessageLocalId(other.id))
        expect(h.sent[0].text).toContain('it stopped before replying')
    })

    it('keeps waiting when a session ends without reading the message, and gives up after the grace period', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker', { thinking: true })
        const receipt = h.service.register('worker', request())
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'later' } }, 'task-1')
        // What the hub knows is only that it was last seen working.
        beat(h, 'worker', true)
        h.sessions.set('worker', { id: 'worker', name: 'worker', active: false, thinking: false })
        h.service.onSessionEnded('worker')
        await settle()
        // Ending the session says nothing about a message the worker never took.
        expect(h.sent).toEqual([])
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('pending')
        expect(h.pendingTimers()).toEqual([RECEIPT_RECHECK_MS])

        await h.passRecheck()
        await h.passRecheck()
        await h.passRecheck()
        h.fire()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('it stopped before reading the message')
    })
})

describe('SessionReceiptService: the parent and the record', () => {
    it('settles as failed when the parent session is gone', async () => {
        const h = makeHarness()
        session(h, 'worker')
        const receipt = h.service.register('worker', request('deleted-bot'))
        childTakes(h, 'worker', 'task-1', ['Done.'])
        beat(h, 'worker', true)
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toEqual([])
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('failed')
    })

    it('keeps a receipt for a parent that asked not to be woken, and delivers it when released', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['Finished while you were paused.'])
        h.held.add('bot')
        beat(h, 'worker', true)
        h.sessions.set('worker', { id: 'worker', name: 'worker', active: false, thinking: false })
        h.service.onSessionEnded('worker')
        await settle()
        expect(h.sent).toEqual([])
        expect(h.wakes).toEqual([])
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('pending')

        h.held.delete('bot')
        h.service.releaseHeld('bot')
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Finished while you were paused.')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })

    it('does not send twice when the message was persisted before the record could say so', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['Done.'])
        // Sent, but the delivery failed between storing the message and recording it.
        h.store.sessionReceipts.claim(receipt.id)
        h.store.sessionReceipts.release(receipt.id)
        h.store.messages.addMessage('bot', { role: 'user', content: { type: 'text', text: 'already here' } }, buildSessionReceiptMessageLocalId(receipt.id))
        await h.service.deliver(receipt.id)
        expect(h.sent).toEqual([])
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
        expect(h.service.watchedChildrenOf('bot')).toEqual([])
    })

    it('expires a receipt that waited longer than the maximum age', async () => {
        const h = makeHarness()
        session(h, 'bot', { active: false })
        h.wakeResult = () => false
        session(h, 'worker')
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        const receipt = h.service.register('worker', request())
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('pending')

        h.advance(8 * 24 * 60 * MINUTE)
        h.fire()
        await settle()
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('expired')
        expect(h.sent).toEqual([])
        expect(h.pendingTimers()).toEqual([])
    })

    it('a parent that cannot be woken is retried with backoff, and the reply goes out once it can', async () => {
        let online = false
        const h = makeHarness({ wake: () => online })
        session(h, 'bot', { active: false })
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['Ready when you are.'])
        beat(h, 'worker', true)
        beat(h, 'worker', false)
        await settle()
        expect(h.sent).toEqual([])
        expect(h.wakes).toEqual(['bot'])
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('pending')
        expect(h.pendingTimers()).toEqual([15_000])

        // A second trigger while the first is retrying is one more attempt with a longer wait, not a parallel one.
        await h.service.deliver(receipt.id)
        expect(h.wakes).toHaveLength(2)
        expect(h.pendingTimers()).toEqual([30_000])
        h.fire()
        await settle()
        expect(h.wakes).toHaveLength(3)
        expect(h.pendingTimers()).toEqual([60_000])
        expect(h.sent).toEqual([])

        online = true
        h.fire()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Ready when you are.')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })
})

describe('SessionReceiptService: what the child reports itself', () => {
    it("the child's session ending settles the receipt from what it wrote, even if its turn never looked finished", async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['Done, then I exited.'])
        beat(h, 'worker', true)
        h.sessions.set('worker', { id: 'worker', name: 'worker', active: false, thinking: false })
        h.service.onSessionEnded('worker')
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Done, then I exited.')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })

    it('a turn-end marker is trusted over a stuck thinking flag, and means nothing before the message is read', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker', { thinking: true })
        h.service.register('worker', request())
        h.service.onTurnEndMarker('worker')
        await settle()
        expect(h.sent).toEqual([])

        childTakes(h, 'worker', 'task-1', ['Finished.'])
        h.service.onTurnEndMarker('worker')
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Finished.')
    })

    it('reports a worker that read the message and then died without a word when its session ends', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker', { thinking: true })
        h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', [])
        h.sessions.set('worker', { id: 'worker', name: 'worker', active: false, thinking: false })
        h.service.onSessionEnded('worker')
        await settle()
        expect(h.sent[0].text).toContain('it stopped before replying')
    })
})

describe('SessionReceiptService across a hub restart', () => {
    const tempDirs: string[] = []
    function restartableDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-receipts-'))
        tempDirs.push(dir)
        return join(dir, 'hapi.db')
    }
    afterEach(() => {
        for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    })

    it('a worker still on its turn when the hub went down is reported when that turn ends, not before', async () => {
        const dbPath = restartableDir()
        const first = makeHarness({ dbPath })
        session(first, 'bot')
        session(first, 'worker')
        const receipt = first.service.register('worker', request())
        // Mid-turn, with something already said on the way.
        childTakes(first, 'worker', 'task-1', ['Let me check the file first.'])
        first.service.dispose()
        first.store.close()

        // The new hub's cache says "not thinking" about every session until it hears from them.
        const second = makeHarness({ dbPath, load: true })
        second.sessions.set('bot', { id: 'bot', name: 'bot', active: true, thinking: false })
        second.sessions.set('worker', { id: 'worker', name: 'worker', active: true, thinking: false })
        // Whatever fires before the worker's first heartbeat proves nothing.
        second.service.retryPending()
        second.fire()
        await settle()
        expect(second.sent).toEqual([])
        // The worker's heartbeat says it is still working.
        beat(second, 'worker', true)
        expect(second.timers.size).toBe(0)

        second.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'Fixed for real.' } })
        beat(second, 'worker', false)
        await settle()
        expect(second.sent).toHaveLength(1)
        expect(second.sent[0].text).toContain('Fixed for real.')
        expect(second.sent[0].text).not.toContain('Let me check the file first.')
        expect(second.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
        second.store.close()
    })

    it('a turn that ended while the hub was down is reported once the worker has been seen idle for a while', async () => {
        const dbPath = restartableDir()
        const first = makeHarness({ dbPath })
        session(first, 'bot')
        session(first, 'worker')
        const receipt = first.service.register('worker', request())
        childTakes(first, 'worker', 'task-1', ['Finished overnight.'])
        first.service.dispose()
        first.store.close()

        const second = makeHarness({ dbPath, load: true })
        second.sessions.set('bot', { id: 'bot', name: 'bot', active: true, thinking: false })
        second.sessions.set('worker', { id: 'worker', name: 'worker', active: true, thinking: false })
        // Nothing has heard from the worker yet: the slow look is all that is scheduled.
        expect(second.pendingTimers()).toEqual([RECEIPT_RECHECK_MS])
        second.service.retryPending()
        second.fire()
        await settle()
        expect(second.sent).toEqual([])

        // Its first heartbeat: idle. Not long enough to be sure.
        beat(second, 'worker', false)
        await settle()
        expect(second.sent).toEqual([])
        expect(second.pendingTimers()).toEqual([RECEIPT_IDLE_AFTER_READ_MS])
        second.advance(RECEIPT_IDLE_AFTER_READ_MS - 1)
        second.fire()
        await settle()
        expect(second.sent).toEqual([])

        second.advance(2)
        second.fire()
        await settle()
        expect(second.sent).toHaveLength(1)
        expect(second.sent[0].text).toContain('Finished overnight.')
        expect(second.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
        second.store.close()
    })

    // The previous hub process claimed a receipt (pending → delivering), sent
    // or not, and died before recording either. Such a row used to be read by
    // no one: never sent again, never marked, the bot never heard.
    it('settles a receipt the previous process left mid-delivery: sent, so marked delivered and not sent twice', async () => {
        const dbPath = restartableDir()
        const first = makeHarness({ dbPath })
        session(first, 'bot')
        session(first, 'worker')
        const receipt = first.service.register('worker', request())
        childTakes(first, 'worker', 'task-1', ['Sent, then the hub died.'])
        first.store.sessionReceipts.claim(receipt.id)
        first.store.messages.addMessage('bot', { role: 'user', content: { type: 'text', text: '[hapi receipt] Sent, then the hub died.' } }, buildSessionReceiptMessageLocalId(receipt.id))
        first.store.close()

        const second = makeHarness({ dbPath, load: true })
        second.sessions.set('bot', { id: 'bot', name: 'bot', active: true, thinking: false })
        second.sessions.set('worker', { id: 'worker', name: 'worker', active: true, thinking: false })
        expect(second.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
        second.service.retryPending()
        second.fire()
        await settle()
        expect(second.sent).toEqual([])
        expect(second.service.watchedChildrenOf('bot')).toEqual([])
        second.store.close()
    })

    it('delivers a receipt the previous process left mid-delivery when the message never made it into the parent', async () => {
        const dbPath = restartableDir()
        const first = makeHarness({ dbPath })
        session(first, 'bot')
        session(first, 'worker')
        const receipt = first.service.register('worker', request())
        childTakes(first, 'worker', 'task-1', ['Claimed, never sent.'])
        // Claimed, and the process died before the wake of the parent came back.
        first.store.sessionReceipts.claim(receipt.id)
        first.store.close()

        const second = makeHarness({ dbPath, load: true })
        second.sessions.set('bot', { id: 'bot', name: 'bot', active: true, thinking: false })
        second.sessions.set('worker', { id: 'worker', name: 'worker', active: true, thinking: false })
        // The start-up sweep gave the claim back; the receipt waits like any other.
        expect(second.store.sessionReceipts.get(receipt.id)?.state).toBe('pending')
        beat(second, 'worker', false)
        second.advance(RECEIPT_IDLE_AFTER_READ_MS + 1)
        second.fire()
        await settle()
        expect(second.sent).toHaveLength(1)
        expect(second.sent[0].text).toContain('Claimed, never sent.')
        expect(second.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
        second.store.close()
    })
})

describe('SessionReceiptService and the ledger around it', () => {
    it('registers once per message while the first receipt is being delivered, and shortly after it was delivered', async () => {
        let releaseWake: () => void = () => {}
        const h = makeHarness({ wake: () => new Promise<boolean>((resolve) => { releaseWake = () => resolve(true) }) })
        session(h, 'bot', { active: false })
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['Done.'])
        // The turn ends: the reply is on its way (claimed, waiting for the parent to wake) when the sender retries its registration.
        beat(h, 'worker', true)
        beat(h, 'worker', false)
        await settle()
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivering')
        expect(h.service.register('worker', request()).id).toBe(receipt.id)
        // ... and one retried after the reply went out (the sender never saw the first response).
        releaseWake()
        await settle()
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
        expect(h.service.register('worker', request()).id).toBe(receipt.id)
        expect(h.store.sessionReceipts.listUnsettled()).toEqual([])

        // Long after, the same local id is a new message to the same end: a new receipt.
        h.advance(2 * 60 * MINUTE)
        const again = h.service.register('worker', request())
        expect(again.id).not.toBe(receipt.id)
        expect(h.store.sessionReceipts.listUnsettled()).toHaveLength(1)
    })

    it('moves the receipts of a merged-away session to the surviving one, so its turn end still reports', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        beat(h, 'worker', true)
        session(h, 'worker-2', { thinking: true })
        // Both halves of a merge: the session cache moves the rows, the service moves what it watches.
        h.store.sessionReceipts.transfer('worker', 'worker-2')
        h.service.followMergedSession('worker', 'worker-2')
        expect(h.service.watchedChildrenOf('bot')).toEqual(['worker-2'])

        h.store.messages.addMessage('worker-2', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        h.store.messages.markMessagesInvoked('worker-2', ['task-1'], 500)
        h.store.messages.addMessage('worker-2', { role: 'agent', content: { type: 'text', text: 'Done under my new id.' } })
        // The turn it was on when merged ends under the new id.
        beat(h, 'worker-2', true)
        beat(h, 'worker-2', false)
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Done under my new id.')
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })

    it('recognises the end of a turn that is reported under the new id right after a merge', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        beat(h, 'worker', true)
        // The merge: rows move, the transcript is copied to the survivor, and the service is told.
        h.store.sessionReceipts.transfer('worker', 'worker-2')
        h.service.followMergedSession('worker', 'worker-2')
        session(h, 'worker-2', { thinking: true })
        childTakes(h, 'worker-2', 'task-1', ['Done under my new id.'])

        // The turn ends, and the first heartbeat after the merge already says so.
        beat(h, 'worker-2', false)
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0].text).toContain('Done under my new id.')
    })

    it('fails what waited on a deleted session, and what the deleted session was waiting on', () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        session(h, 'worker-2')
        const asChild = h.service.register('worker', request())
        const asParent = h.service.register('worker-2', request('bot'))
        h.service.forgetSession('worker')
        h.service.forgetSession('bot')
        expect(h.store.sessionReceipts.get(asChild.id)?.state).toBe('failed')
        expect(h.store.sessionReceipts.get(asParent.id)?.state).toBe('failed')
        expect(h.pendingTimers()).toEqual([])
        expect(h.service.watchedChildrenOf('bot')).toEqual([])
    })

    it('leaves a delivery that is on its way out alone, so the record says it went', async () => {
        let releaseWake: () => void = () => {}
        const h = makeHarness({ wake: () => new Promise<boolean>((resolve) => { releaseWake = () => resolve(true) }) })
        session(h, 'bot', { active: false })
        session(h, 'worker')
        const receipt = h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['Last words.'])
        beat(h, 'worker', true)
        // The worker's session is archived: its end is reported, the delivery is claimed…
        h.sessions.set('worker', { id: 'worker', name: 'worker', active: false, thinking: false })
        h.service.onSessionEnded('worker')
        await settle()
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivering')
        // …and the hub then forgets the session.
        h.service.forgetSession('worker')
        releaseWake()
        await settle()
        expect(h.sent).toHaveLength(1)
        expect(h.store.sessionReceipts.get(receipt.id)?.state).toBe('delivered')
    })

    it('forgets what it heard about a session once nothing waits on it', async () => {
        const h = makeHarness()
        session(h, 'bot')
        session(h, 'worker')
        h.service.register('worker', request())
        childTakes(h, 'worker', 'task-1', ['Done.'])
        beat(h, 'worker', true)
        beat(h, 'worker', false)
        await settle()
        expect(h.service.watchedChildrenOf('bot')).toEqual([])
        // A later heartbeat of that session is of no interest and costs nothing.
        expect(() => h.service.observe('worker', { thinking: false, active: false })).not.toThrow()
    })
})

describe('computeSessionReceiptOutcome', () => {
    it('is null until the child takes the message', () => {
        const h = makeHarness()
        session(h, 'worker')
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        expect(computeSessionReceiptOutcome(h.store, { childSessionId: 'worker', taskLocalId: 'task-1', childActive: true })).toBeNull()
        expect(computeSessionReceiptOutcome(h.store, { childSessionId: 'worker', taskLocalId: 'task-1', childActive: false })).toBeNull()
        expect(computeSessionReceiptOutcome(h.store, { childSessionId: 'worker', taskLocalId: 'never-sent', childActive: true })).toEqual({ type: 'canceled' })
    })

    it('ignores tool output and reasoning rows, and empty text', () => {
        const h = makeHarness()
        session(h, 'worker')
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1', null, 1)
        h.store.messages.markMessagesInvoked('worker', ['task-1'], 1)
        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'tool_call', data: { name: 'Bash' } } }, undefined, null, 2)
        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: '   ' } }, undefined, null, 3)
        expect(computeSessionReceiptOutcome(h.store, { childSessionId: 'worker', taskLocalId: 'task-1', childActive: true })).toEqual({ type: 'no-reply' })
        expect(computeSessionReceiptOutcome(h.store, { childSessionId: 'worker', taskLocalId: 'task-1', childActive: false })).toEqual({
            type: 'died',
            reason: 'it stopped before replying'
        })
    })
})

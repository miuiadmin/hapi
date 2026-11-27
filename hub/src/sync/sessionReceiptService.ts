import {
    BOT_MAX_PENDING_RECEIPTS,
    buildSessionReceiptMessageLocalId,
    extractSearchableMessageText,
    formatSessionReceiptMessage,
    SESSION_RECEIPT_MAX_AGE_MS,
    type RegisterSessionReceiptRequest,
    type SessionReceipt,
    type SessionReceiptOutcome
} from '@hapi/protocol'
import type { Store } from '../store'
import type { StoredSessionReceipt } from '../store/sessionReceipts'

/**
 * Receipts: the hub waits for a session's turn to end and posts the reply
 * back into the session that messaged it.
 *
 * `ping_peer`'s `waitForReply` does this waiting inside the sender's own CLI
 * process, so the reply is lost when that process exits first, and only nine
 * flavors report a turn end that way. Here the wait is a row in SQLite. The
 * hub already observes every session's `thinking` flag, so any flavor works,
 * and the sender can end its turn, stop, or restart.
 *
 * Nothing polls the model. Two kinds of thing settle a receipt, and only
 * these: the hub seeing the child's turn end (`thinking` going true →
 * false, the child posting a turn-end marker, its session ending); and, for
 * a turn that ended while the hub was not looking, evidence found on a
 * later look — the child gone for a grace period, or idle ever since it
 * took the message. A look on a timer by itself never concludes anything:
 * after a restart the hub's cache says "not thinking" about every session,
 * including ones in the middle of a turn. Whenever a look finds nothing to
 * report yet, the next look is scheduled for when something could settle it.
 */

/**
 * How long a child that merely stopped being heard from is given to come
 * back before its silence is final: a restarted hub, a network gap, a laptop
 * that went to sleep. A child that says so itself (a turn-end marker, the
 * session ending) is believed at once.
 */
export const RECEIPT_AWAY_GRACE_MS = 30 * 60_000
/**
 * How long a child that took the message has to sit idle — not thinking,
 * with nothing blocking it — before that is read as "its turn is over" when
 * no end of turn was reported. Long, on purpose: the hub cannot tell a
 * worker that finished quietly from one that is working in a way its
 * `thinking` flag does not show, and reporting a turn over too early means
 * the real reply is never forwarded.
 */
export const RECEIPT_IDLE_AFTER_READ_MS = 2 * 60_000
/**
 * The same, for a child with work it left running in the background (a dev
 * server, a long job). A turn can be over while that goes on, so it must not
 * hold the receipt for good — but it is a sign of a worker that was active,
 * so it buys more time.
 */
export const RECEIPT_BACKGROUND_IDLE_MS = 10 * 60_000
/** Cadence of the slow re-check while there is nothing to settle yet. */
export const RECEIPT_RECHECK_MS = 10 * 60_000
const RETRY_BASE_MS = 15_000
const RETRY_MAX_MS = 60_000

export type ReceiptSessionView = {
    id: string
    name?: string | null
    active: boolean
    thinking: boolean
    /** The session cannot go on by itself: a request it is waiting on, a tool call still running. */
    blocked?: boolean
    /** Work it left running in the background; its turn can be over while this is true. */
    background?: boolean
}

export class SessionReceiptLimitError extends Error {
    readonly code = 'too_many_pending_receipts'
    constructor() {
        super(`At most ${BOT_MAX_PENDING_RECEIPTS} receipts may wait on one session at a time`)
    }
}

export type SessionReceiptDeps = {
    store: Pick<Store, 'sessionReceipts' | 'messages'>
    /** The hub's cached idea of a session. For deciding anything, use what came through `observe`. */
    getSession: (sessionId: string) => ReceiptSessionView | null
    /** Resume the session if it is not active; false when that could not be done now. */
    wake: (sessionId: string) => Promise<boolean>
    sendMessage: (sessionId: string, payload: { text: string; localId: string }) => Promise<void>
    /** The parent asked not to be started by receipts for now (a paused bot). */
    isHeld?: (parentSessionId: string) => boolean
    now?: () => number
    /** Injectable so tests do not wait on real timers. */
    setTimer?: (callback: () => void, delayMs: number) => unknown
    clearTimer?: (handle: unknown) => void
    log?: (message: string, detail: Record<string, unknown>) => void
}

export type ReceiptState = { thinking: boolean; active: boolean; blocked?: boolean; background?: boolean }

/**
 * How a look at a receipt came about. `final`: the child's own runtime
 * reported the end of its turn or session, so what it wrote is the answer.
 * `turn-end`: the hub saw the child stop thinking. `look`: anything else — a
 * timer, a retry, the hub starting — which by itself proves nothing.
 */
export type ReceiptSignal = 'look' | 'turn-end' | 'final'

type ReceiptTimerKind = 'look' | 'retry'

/**
 * What the child did with the message a receipt answers. Null while the
 * child has not taken the message yet.
 */
export function computeSessionReceiptOutcome(
    store: Pick<Store, 'messages'>,
    input: { childSessionId: string; taskLocalId: string; childActive: boolean }
): SessionReceiptOutcome | null {
    const { childSessionId, taskLocalId } = input
    const lookup = store.messages.lookupQueuedMessage(childSessionId, taskLocalId)
    if (lookup.status === 'absent') return { type: 'canceled' }
    // Not read yet. Whether that is final is the caller's decision (the child may come back).
    if (lookup.status !== 'invoked') return null
    const task = lookup.message
    const taskSeq = store.messages.getSeqById(childSessionId, task.id)
    if (taskSeq === null) return { type: 'canceled' }

    // Rows are ordered by consumption, so this task's turn ends at the next
    // prompt the child took on its own; prompts consumed together with the
    // task share its turn.
    let reply: string | null = null
    let sawLaterPrompt = false
    for (const row of store.messages.getMessagesAfterSeq(childSessionId, taskSeq)) {
        const extracted = extractSearchableMessageText(row.content)
        if (!extracted) continue
        if (extracted.role === 'user') {
            if (row.invokedAt != null && row.invokedAt !== task.invokedAt) sawLaterPrompt = true
            continue
        }
        if (!sawLaterPrompt) reply = extracted.text
    }
    if (reply !== null && reply.trim().length > 0) return { type: 'replied', text: reply }
    return input.childActive ? { type: 'no-reply' } : { type: 'died', reason: 'it stopped before replying' }
}

export class SessionReceiptService {
    /** child session id → the receipts waiting on it. */
    private readonly watched = new Map<string, Set<string>>()
    /**
     * What a session last reported about itself in this process. Only for
     * sessions with a receipt waiting, and only from `observe`: the hub's
     * cached state after a restart says "not thinking" about every session,
     * including ones in the middle of a turn.
     */
    private readonly observed = new Map<string, ReceiptState>()
    /** Since when a session has been continuously observed idle; dropped as soon as it is seen thinking. */
    private readonly idleSince = new Map<string, number>()
    /** Receipts whose child is away with nothing settled yet: since when. */
    private readonly awaySince = new Map<string, number>()
    /**
     * What the child did, once that is settled. Kept so that a delivery that
     * has to be tried again (the parent could not be woken just then) does
     * not have to prove the same thing twice.
     */
    private readonly decided = new Map<string, SessionReceiptOutcome>()
    private readonly inFlight = new Set<string>()
    private readonly failures = new Map<string, number>()
    /**
     * The one timer per receipt, when it is due, and what it is for: a `look`
     * re-reads the child's transcript, a `retry` sends a reply that is
     * already settled and only failed to go out.
     */
    private readonly timers = new Map<string, { handle: unknown; due: number; kind: ReceiptTimerKind }>()

    constructor(private readonly deps: SessionReceiptDeps) {}

    private get store(): SessionReceiptDeps['store'] {
        return this.deps.store
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now()
    }

    private setTimer(receiptId: string, delayMs: number, callback: () => void, kind: ReceiptTimerKind = 'look'): void {
        this.clearTimer(receiptId)
        const handle = (this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
            this.timers.delete(receiptId)
            callback()
        }, delayMs)
        this.timers.set(receiptId, { handle, due: this.now() + delayMs, kind })
    }

    /**
     * Make sure the receipt is looked at by `delayMs` from now: a timer
     * already set for later is brought forward; one set for sooner stays.
     * (Heartbeats cannot push a look out, and a nearer deadline is never
     * hidden behind a farther one.)
     */
    private lookBy(receiptId: string, delayMs: number): void {
        const existing = this.timers.get(receiptId)
        if (existing && existing.due <= this.now() + delayMs) return
        this.setTimer(receiptId, delayMs, () => this.check(receiptId), 'look')
    }

    private clearTimer(receiptId: string): void {
        const timer = this.timers.get(receiptId)
        if (!timer) return
        this.timers.delete(receiptId)
        ;(this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(timer.handle)
    }

    private track(childSessionId: string, receiptId: string): void {
        const set = this.watched.get(childSessionId) ?? new Set<string>()
        set.add(receiptId)
        this.watched.set(childSessionId, set)
    }

    private untrack(childSessionId: string, receiptId: string): void {
        const set = this.watched.get(childSessionId)
        if (set) {
            set.delete(receiptId)
            if (set.size === 0) {
                this.watched.delete(childSessionId)
                // Nothing waits on this session any more: forget what it said about itself.
                this.observed.delete(childSessionId)
                this.idleSince.delete(childSessionId)
            }
        }
        this.awaySince.delete(receiptId)
        this.failures.delete(receiptId)
        this.decided.delete(receiptId)
        this.clearTimer(receiptId)
    }

    /**
     * How long the child has been away with this receipt unresolved; 0 while
     * it is active. The clock starts the first time it is seen away, so the
     * grace period is measured from when it disappeared, not from when it
     * happens to be looked at.
     */
    private awayFor(receiptId: string, child: ReceiptSessionView | null): number {
        if (child?.active) {
            this.awaySince.delete(receiptId)
            return 0
        }
        const now = this.now()
        const since = this.awaySince.get(receiptId)
        if (since === undefined) {
            this.awaySince.set(receiptId, now)
            return 0
        }
        return now - since
    }

    /**
     * When the child took the message this receipt answers, or null while it
     * has not.
     */
    private takenAt(receipt: StoredSessionReceipt, childSessionId: string): number | null {
        const lookup = this.store.messages.lookupQueuedMessage(childSessionId, receipt.taskLocalId)
        return lookup.status === 'invoked' ? lookup.message.invokedAt : null
    }

    /**
     * Whether the child took the message and has been observed idle ever
     * since — for long enough to call its turn over. Idle means not thinking,
     * not away, and with nothing blocking it. It is what settles a turn whose
     * end the hub did not see: it ended while the hub was down, or the child
     * was out of reach and came back finished. A worker that is thinking, or
     * held up on a request or a running tool call, is never idle, so this
     * cannot cut a turn it can see short.
     */
    private idleAfterReading(receipt: StoredSessionReceipt, child: ReceiptSessionView | null): boolean {
        if (!child?.active || child.blocked) return false
        const since = this.idleSince.get(child.id)
        const takenAt = this.takenAt(receipt, child.id)
        if (since === undefined || takenAt === null) return false
        // Idle since before it took the message says nothing about the message.
        if (since < takenAt) return false
        return this.now() - since >= this.quietPeriod(child)
    }

    /** How long this child has to sit idle before that counts as a finished turn. */
    private quietPeriod(child: ReceiptSessionView | null): number {
        return child?.background ? RECEIPT_BACKGROUND_IDLE_MS : RECEIPT_IDLE_AFTER_READ_MS
    }

    /** Load what a previous hub process left waiting and settle what already finished. */
    sweep(): void {
        const now = this.now()
        const waiting: StoredSessionReceipt[] = []
        for (const receipt of this.store.sessionReceipts.listUnsettled()) {
            if (receipt.state === 'delivering') {
                // The previous process claimed this receipt and died before
                // recording how it went. The message is the record: if it is
                // in the parent's transcript the receipt went out, and if it
                // is not, the receipt is still to be delivered.
                const sent = this.store.messages.lookupQueuedMessage(
                    receipt.parentSessionId, buildSessionReceiptMessageLocalId(receipt.id)
                ).status !== 'absent'
                if (sent) {
                    this.store.sessionReceipts.markDelivered(receipt.id, now)
                    continue
                }
                this.store.sessionReceipts.release(receipt.id)
            }
            waiting.push(receipt)
        }
        // No look from here. Nothing in this process has heard from these children yet: their
        // first heartbeat (or the expiry sweep, for one that is gone) says which ones are idle.
        for (const receipt of waiting) {
            this.track(receipt.childSessionId, receipt.id)
            this.waitForChild(receipt.id, this.deps.getSession(receipt.childSessionId))
        }
        this.store.sessionReceipts.deleteSettledBefore(now - SESSION_RECEIPT_MAX_AGE_MS)
    }

    /** A machine came back: what was deferred for its sessions may go out now. */
    retryPending(): void {
        for (const receipt of this.store.sessionReceipts.listUnsettled()) {
            if (receipt.state === 'pending') this.setTimer(receipt.id, 0, () => this.check(receipt.id))
        }
    }

    /** Children a session is still waiting on (newest first). */
    watchedChildrenOf(parentSessionId: string): string[] {
        return this.store.sessionReceipts.listPendingChildSessions(parentSessionId)
    }

    /** Idempotent per (child, parent, message): a second registration returns the first receipt. */
    register(childSessionId: string, request: RegisterSessionReceiptRequest): SessionReceipt {
        const existing = this.store.sessionReceipts.findLive(
            childSessionId, request.parentSessionId, request.taskLocalId, this.now()
        )
        if (existing) return existing
        if (this.store.sessionReceipts.listPendingForParent(request.parentSessionId).length >= BOT_MAX_PENDING_RECEIPTS) {
            throw new SessionReceiptLimitError()
        }
        const receipt = this.store.sessionReceipts.insert({ ...request, childSessionId, now: this.now() })
        this.track(receipt.childSessionId, receipt.id)
        // What follows depends on the child's turn; the timer is only the slow look for a child that never reports one.
        this.waitForChild(receipt.id, this.deps.getSession(childSessionId))
        return receipt
    }

    /**
     * The child reported its state: a heartbeat, a state patch, the expiry
     * sweep finding it gone. Everything the service concludes about a child
     * comes from here, never from the hub's cache — after a restart the cache
     * says "not thinking" about every session, including ones mid-turn.
     */
    observe(sessionId: string, state: ReceiptState): void {
        if (!this.watched.has(sessionId)) return
        const previous = this.noteState(sessionId, state)
        const turnEnded = previous?.thinking === true && !state.thinking
        const changed = !previous
            || previous.thinking !== state.thinking
            || previous.active !== state.active
            || (previous.blocked === true) !== (state.blocked === true)
            || (previous.background === true) !== (state.background === true)
        if (turnEnded || changed) this.evaluate(sessionId, state, turnEnded)
    }

    /**
     * The inactivity sweep found the session gone. It stopped being heard
     * from; whether it stopped thinking is not known, so this is not a turn
     * end and not idleness — the look it triggers starts the away clock and
     * nothing more, and the session's next heartbeat is not read as the end
     * of a turn either.
     */
    onExpired(sessionId: string): void {
        if (!this.watched.has(sessionId)) return
        this.observed.set(sessionId, { thinking: false, active: false })
        for (const receipt of this.store.sessionReceipts.listPendingForChild(sessionId)) {
            void this.deliver(receipt.id, 'look', true)
        }
    }

    /** Record what a session said, without acting on it. Returns what it had said before, if anything. */
    private noteState(sessionId: string, state: ReceiptState): ReceiptState | undefined {
        const previous = this.observed.get(sessionId)
        const now = this.now()
        this.observed.set(sessionId, {
            thinking: state.thinking,
            active: state.active,
            blocked: state.blocked === true,
            background: state.background === true
        })
        if (state.thinking) {
            this.idleSince.delete(sessionId)
        } else if (!this.idleSince.has(sessionId)) {
            this.idleSince.set(sessionId, now)
        }
        return previous
    }

    /**
     * The child posted a turn-end marker (a `ready` row). Flavors whose
     * `thinking` flag is unreliable end their turns this way, so the
     * transcript is trusted over that flag here.
     */
    onTurnEndMarker(sessionId: string): void {
        if (!this.watched.has(sessionId)) return
        this.settleFromTranscript(sessionId)
    }

    /** The parent is taking receipts again: deliver what was held for it. */
    releaseHeld(parentSessionId: string): void {
        for (const receipt of this.store.sessionReceipts.listPendingForParent(parentSessionId)) {
            void this.deliver(receipt.id)
        }
    }

    /**
     * The child's process ended its session. That is a final turn boundary:
     * report what it wrote without waiting to see whether it comes back. A
     * message it never read keeps waiting for it.
     */
    onSessionEnded(sessionId: string): void {
        if (!this.watched.has(sessionId)) return
        this.noteState(sessionId, { thinking: false, active: false })
        this.settleFromTranscript(sessionId)
    }

    /**
     * A session was merged into another: its receipts are waited on under the
     * surviving id from now on. What it said about itself moves with them —
     * otherwise its next heartbeat under the new id looks like a first one,
     * and the end of the turn it was on is not recognised as one.
     */
    followMergedSession(fromSessionId: string, toSessionId: string): void {
        const moved = this.watched.get(fromSessionId)
        if (!moved) return
        this.watched.delete(fromSessionId)
        const set = this.watched.get(toSessionId) ?? new Set<string>()
        for (const receiptId of moved) set.add(receiptId)
        this.watched.set(toSessionId, set)
        this.moveHeard(this.observed, fromSessionId, toSessionId)
        this.moveHeard(this.idleSince, fromSessionId, toSessionId)
    }

    /** What the merged-away session said about itself belongs to its survivor, unless the survivor was heard too. */
    private moveHeard<T>(notes: Map<string, T>, fromSessionId: string, toSessionId: string): void {
        const heard = notes.get(fromSessionId)
        notes.delete(fromSessionId)
        if (heard !== undefined && !notes.has(toSessionId)) notes.set(toSessionId, heard)
    }

    /** A session was deleted: nothing that waited on it, or that it waited on, can be settled any more. */
    forgetSession(sessionId: string): void {
        for (const receiptId of [...(this.watched.get(sessionId) ?? [])]) {
            // One already on its way out is left to finish; its record would otherwise say it never went.
            if (this.inFlight.has(receiptId)) continue
            this.store.sessionReceipts.markUndeliverable(receiptId, 'failed', this.now())
            this.untrack(sessionId, receiptId)
        }
        for (const receipt of this.store.sessionReceipts.listUnsettled()) {
            if (receipt.parentSessionId !== sessionId || this.inFlight.has(receipt.id)) continue
            this.store.sessionReceipts.markUndeliverable(receipt.id, 'failed', this.now())
            this.untrack(receipt.childSessionId, receipt.id)
        }
    }

    dispose(): void {
        for (const receiptId of [...this.timers.keys()]) this.clearTimer(receiptId)
    }

    private settleFromTranscript(sessionId: string): void {
        for (const receipt of this.store.sessionReceipts.listPendingForChild(sessionId)) {
            void this.deliver(receipt.id, 'final')
        }
    }

    private evaluate(sessionId: string, state: ReceiptState, turnEnded: boolean): void {
        for (const receipt of this.store.sessionReceipts.listPendingForChild(sessionId)) {
            if (state.thinking) {
                // Still working on something: the end of that turn will look, and a look scheduled now would only
                // be cleared then. A reply that is settled and waiting to go out keeps its own retry — this new
                // turn is not its concern, and may last a long time.
                const timer = this.timers.get(receipt.id)
                if (!timer || timer.kind === 'look') this.clearTimer(receipt.id)
                continue
            }
            void this.deliver(receipt.id, turnEnded ? 'turn-end' : 'look')
        }
    }

    /** The child has not produced anything to report yet: look again when the next thing that could settle it is due. */
    private waitForChild(receiptId: string, child: ReceiptSessionView | null): void {
        const receipt = this.store.sessionReceipts.get(receiptId)
        if (!receipt || receipt.state !== 'pending') return
        // Starts the away clock if the child is away (and drops it if the child is back).
        this.awayFor(receiptId, child)
        const awaySince = this.awaySince.get(receiptId)
        let delay = RECEIPT_RECHECK_MS
        if (awaySince !== undefined) {
            delay = Math.min(delay, RECEIPT_AWAY_GRACE_MS - (this.now() - awaySince))
        } else if (child) {
            const since = this.idleSince.get(child.id)
            const takenAt = this.takenAt(receipt, child.id)
            const onThisMessage = since !== undefined && takenAt !== null && since >= takenAt
            // Only while that deadline is still ahead: once it has passed without the rule applying (the child is
            // held up), nothing is gained by looking again soon.
            const untilIdle = since === undefined ? 0 : this.quietPeriod(child) - (this.now() - since)
            if (onThisMessage && untilIdle > 0) delay = Math.min(delay, untilIdle)
        }
        this.lookBy(receiptId, Math.max(1, delay))
    }

    private check(receiptId: string): void {
        const receipt = this.store.sessionReceipts.get(receiptId)
        if (!receipt || receipt.state !== 'pending' || this.inFlight.has(receiptId)) return
        void this.deliver(receiptId)
    }

    /**
     * What the child did with the message, or null while that is not settled.
     * Only two things settle a receipt: the child's own report that it
     * finished (`final`), and the hub seeing its turn end (`turn-end`). A
     * look on a timer settles nothing on its own; what it may conclude is
     * bounded by evidence — the child gone for the grace period, the message
     * gone, or the child idle since it took the message.
     */
    private outcomeOf(receipt: StoredSessionReceipt, child: ReceiptSessionView | null, signal: ReceiptSignal): SessionReceiptOutcome | null {
        const outcome = computeSessionReceiptOutcome(this.store, {
            childSessionId: receipt.childSessionId,
            taskLocalId: receipt.taskLocalId,
            childActive: child?.active ?? false
        })
        if (signal !== 'look') return outcome
        if (this.awayFor(receipt.id, child) >= RECEIPT_AWAY_GRACE_MS) {
            // Gone for long enough: its last word is its reply, and silence about the rest is final.
            if (outcome?.type === 'replied' || outcome?.type === 'died') return outcome
            if (outcome === null) return { type: 'died', reason: 'it stopped before reading the message' }
        }
        if (outcome?.type === 'canceled') return outcome
        if ((outcome?.type === 'replied' || outcome?.type === 'no-reply') && this.idleAfterReading(receipt, child)) return outcome
        return null
    }

    private defer(receiptId: string, reason: string): void {
        this.store.sessionReceipts.release(receiptId)
        const failures = (this.failures.get(receiptId) ?? 0) + 1
        this.failures.set(receiptId, failures)
        const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS)
        this.deps.log?.('[session-receipt] delivery deferred', { receiptId, reason, retryInMs: delay })
        const receipt = this.store.sessionReceipts.get(receiptId)
        if (receipt) this.setTimer(receiptId, delay, () => void this.deliver(receiptId), 'retry')
    }

    /**
     * Send the receipt if there is something to report; otherwise make sure
     * there is a later look. `wentAway`: the session was found gone, so its
     * cached `thinking` is not trusted to mean "still working".
     */
    async deliver(receiptId: string, signal: ReceiptSignal = 'look', wentAway = false): Promise<void> {
        if (this.inFlight.has(receiptId)) return
        const receipt = this.store.sessionReceipts.get(receiptId)
        if (!receipt || receipt.state !== 'pending') return
        const now = this.now()
        if (now - receipt.createdAt > SESSION_RECEIPT_MAX_AGE_MS) {
            this.store.sessionReceipts.markUndeliverable(receiptId, 'expired', now)
            this.untrack(receipt.childSessionId, receiptId)
            return
        }
        // A previous attempt may have persisted the message and then failed before recording it: the message is the record.
        if (this.store.messages.lookupQueuedMessage(receipt.parentSessionId, buildSessionReceiptMessageLocalId(receiptId)).status !== 'absent') {
            this.store.sessionReceipts.settleDelivered(receiptId, now)
            this.untrack(receipt.childSessionId, receiptId)
            return
        }
        const child = this.deps.getSession(receipt.childSessionId)
        const settled = this.decided.get(receiptId)
        if (child?.thinking && signal !== 'final' && !wentAway && !settled) {
            // Still working; the end of its turn will call again. (A reply already settled is not the business of
            // whatever turn the child has moved on to.)
            return
        }
        let outcome = settled
        if (!outcome) {
            outcome = this.outcomeOf(receipt, child, signal) ?? undefined
            // A marker for a turn that ran before this message was sent has nothing to report about it.
            if (!outcome || (signal === 'final' && outcome.type === 'canceled')) {
                this.waitForChild(receiptId, child)
                return
            }
            this.decided.set(receiptId, outcome)
        }
        if (this.deps.isHeld?.(receipt.parentSessionId)) return
        if (!this.store.sessionReceipts.claim(receiptId)) return
        this.inFlight.add(receiptId)
        try {
            const parent = this.deps.getSession(receipt.parentSessionId)
            if (!parent) {
                this.store.sessionReceipts.markUndeliverable(receiptId, 'failed', now)
                this.untrack(receipt.childSessionId, receiptId)
                return
            }
            if (!parent.active && !(await this.deps.wake(parent.id))) {
                this.defer(receiptId, 'parent_not_active')
                return
            }
            const localId = buildSessionReceiptMessageLocalId(receipt.id)
            // A previous attempt may have persisted the message before failing to record it.
            if (this.store.messages.lookupQueuedMessage(parent.id, localId).status === 'absent') {
                const text = formatSessionReceiptMessage({
                    childSessionId: receipt.childSessionId,
                    childName: child?.name?.trim() || receipt.childSessionId.slice(0, 8),
                    outcome
                })
                await this.deps.sendMessage(parent.id, { text, localId })
            }
            this.store.sessionReceipts.markDelivered(receiptId, this.now())
            this.untrack(receipt.childSessionId, receiptId)
        } catch (error) {
            this.defer(receiptId, error instanceof Error ? error.message : String(error))
        } finally {
            this.inFlight.delete(receiptId)
        }
    }
}

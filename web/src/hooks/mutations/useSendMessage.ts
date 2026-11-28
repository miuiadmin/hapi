import { useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiErrorMessage, type ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'
import { makeClientSideId } from '@/lib/messages'
import {
    appendOptimisticMessage,
    getMessageWindowState,
    removeOptimisticMessage,
    subscribeMessageWindow,
    updateMessageStatus,
} from '@/lib/message-window-store'
import { isSendAborted, markSendAborted, subscribeAbortedSends } from '@/lib/abortedSends'
import { clearSendFailure, noteSendFailure } from '@/lib/sendFailures'
import { usePlatform } from '@/hooks/usePlatform'
import type { MessageDeliveryMode } from '@hapi/protocol'
import { getRetryDeliveryMode } from '@/lib/messageDelivery'
import { rehydrateAttachmentPreviews } from '@/lib/attachmentPreviews'
import { telemetryClient } from '@/lib/telemetryClient'
import { noteSendSettled } from '@/chat/turnLatency'

type SendMessageInput = {
    sessionId: string
    text: string
    localId: string
    createdAt: number
    attachments?: AttachmentMetadata[]
    scheduledAt?: number | null
    deliveryMode: MessageDeliveryMode
    /** The session was live when the send started, so no resume step ran. */
    live: boolean
}

export type SendMessageAcceptance = {
    attemptId: string
}

type BlockedReason = 'no-api' | 'no-session' | 'pending'

/** A POST that never settles would leave the optimistic row spinning
 * forever (wedged proxy, dead runner mid-request). Flip the visual state
 * to failed after this long so the retry affordance appears; a late
 * settlement still overwrites via onSuccess/onError as usual. */
const SEND_WATCHDOG_MS = 10_000

/**
 * Information about a send that the underlying mutation rejected.
 *
 * Surfaced via the `onError` option so the consumer can keep the typed
 * text in the composer (composer must NOT clear on 4xx/5xx or network
 * failure) and render an inline affordance.
 *
 * - `sessionId` is the session the failed send was actually targeting
 *   (post-`resolveSessionId`).  Inactive-session resume can resolve a
 *   target id, kick off async navigation, and then have the POST fail
 *   before navigation completes; without this id the consumer would
 *   restore the text into the wrong composer (the old session) and the
 *   sessionId-change effect would clear it again.
 * - `text` is the original input the user typed, captured before the
 *   mutation cleared the composer.
 * - `error` is the raw thrown value (typically `Error`) so the consumer
 *   can inspect status / message.
 * - `scheduledAt` is the absolute epoch-ms the send was bound for, or
 *   null for an immediate send.  Carried through so a failed scheduled
 *   send can be restored as a scheduled send instead of silently
 *   downgrading to immediate -- `SessionChat.handleSend` clears the
 *   pendingSchedule the moment the mutation is accepted, so without
 *   this the schedule is gone by the time onError fires.
 * - `deliveryMode` is the resolved durable intent for this exact send. Retry
 *   recovery retains queue, while turn-scoped steer safely degrades to queue
 *   because the original Pi generation can no longer be proven.
 *
 * Fired for sends of an inactive session (text and attachments alike when the
 * session was live and the hub answered `session_inactive`, attachments
 * otherwise) and for a resume that failed before any POST. A failed send to a
 * live session does not come through here: its row stays in the thread as a
 * failed bubble with a retry (see `isActive`).
 */
export type SendErrorInfo = {
    sessionId: string
    text: string
    error: unknown
    scheduledAt: number | null
    deliveryMode: MessageDeliveryMode
    /** True only after the message mutation was started. */
    mutationStarted: boolean
}

export type ResolvedSession = {
    sessionId: string
    /** True after an inactive-session resume, even when the hub returns the same id. */
    resumed: boolean
}

export type SessionResolution = {
    attachments?: AttachmentMetadata[]
    /** Transfer moved hidden drafts; wait for the active composer to hydrate/re-upload. */
    deferUntilDraftHydrated?: boolean
}

export type SessionResolvedContext = {
    text: string
    attachments?: AttachmentMetadata[]
}

type UseSendMessageOptions = {
    resolveSessionId?: (sessionId: string) => Promise<ResolvedSession>
    onSessionResolved?: (
        sessionId: string,
        context: SessionResolvedContext,
    ) => void | Promise<void | SessionResolution>
    onBlocked?: (reason: BlockedReason) => void
    onSuccess?: (sessionId: string) => void
    onError?: (info: SendErrorInfo) => void
    isSessionThinking?: boolean
    /**
     * The session is live, so a send needs no resume step and the hub is the
     * only thing between the composer and the thread. That changes three things:
     *
     * - The composer is never locked by a POST in flight (`isComposerLocked`),
     *   so the next message can be typed straight away. Every row goes up the
     *   moment it is sent, and one message is on its way to the agent at a
     *   time: the next one is posted once the agent has taken the one before
     *   it (see SEND_ORDERING_GRACE_MS for the one limit on that wait).
     * - A send the user cancels while its POST is in flight is stopped here
     *   (`cancelSending`).
     * - A failed send keeps its row in the thread as a failed bubble with a
     *   retry, instead of handing its text back to the composer: by then the
     *   composer may well hold the next message.
     */
    isActive?: boolean
}

/** Create an optimistic message for display. Extracted as an extension point
 *  so a future floating-UI PR can route queued messages to a separate area. */
function createOptimisticMessage(input: SendMessageInput, status: 'queued' | 'sending'): DecryptedMessage {
    return {
        id: input.localId,
        seq: null,
        localId: input.localId,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: input.text,
                attachments: input.attachments
            },
            meta: {
                deliveryMode: input.deliveryMode,
            },
        },
        createdAt: input.createdAt,
        // Explicit null so the strict-null queued check matches. A pre-V8 hub
        // response that omits the field entirely (`undefined`) is treated as
        // already-invoked and stays in the thread, not the floating bar.
        invokedAt: null,
        scheduledAt: input.scheduledAt ?? null,
        status,
        originalText: input.text,
    }
}

function findMessageByLocalId(
    sessionId: string,
    localId: string,
): DecryptedMessage | null {
    const state = getMessageWindowState(sessionId)
    for (const message of state.messages) {
        if (message.localId === localId) return message
    }
    return null
}

/** Pull attachments off a stored optimistic user message.  The schema types
 *  `content` as `unknown`, so this is a defensive narrow: we accept only the
 *  exact shape `createOptimisticMessage` produces (`role: 'user'`, text-typed
 *  content, attachments array) and return undefined otherwise.  Used by
 *  retryMessage so an attachment send retried from the failed-bubble button
 *  re-fires with its attachments instead of becoming a text-only send. */
function getMessageAttachments(message: DecryptedMessage): AttachmentMetadata[] | undefined {
    const content = message.content as unknown
    if (
        typeof content !== 'object' ||
        content === null
    ) {
        return undefined
    }
    const outer = content as { role?: unknown; content?: unknown }
    if (outer.role !== 'user') return undefined
    const inner = outer.content as { type?: unknown; attachments?: unknown } | null
    if (!inner || inner.type !== 'text') return undefined
    if (!Array.isArray(inner.attachments) || inner.attachments.length === 0) {
        return undefined
    }
    return inner.attachments as AttachmentMetadata[]
}

/** Read the durable delivery intent from an optimistic or failed user row.
 * Old rows predate the field, and the cross-layer compatibility rule is that
 * absence means ordinary queued delivery. */
function getMessageDeliveryMode(message: DecryptedMessage): MessageDeliveryMode {
    const content = message.content as unknown
    if (typeof content !== 'object' || content === null) return 'queue'
    const meta = (content as { meta?: unknown }).meta
    if (typeof meta !== 'object' || meta === null) return 'queue'
    return (meta as { deliveryMode?: unknown }).deliveryMode === 'steer'
        ? 'steer'
        : 'queue'
}

/**
 * How long a message typed behind another one waits for the agent to take that
 * other one before it is posted anyway.
 *
 * The CLI hands the agent every prompt waiting in its queue as one turn. Posted
 * back to back, two quick messages can both be in that queue before the turn
 * starts, and reach the agent as a single prompt. So the second waits until the
 * first is taken. It does not wait for ever: with the agent busy on an earlier
 * turn the first may not be taken for minutes, and a message that exists only
 * on this device is one closed tab from gone. After this long it is posted and
 * waits in the hub's queue instead, as it always did.
 */
export const SEND_ORDERING_GRACE_MS = 2_000

/** A send due at a time still ahead: it is not on its way to the agent now. */
function isScheduledAhead(input: SendMessageInput): boolean {
    return input.scheduledAt != null && input.scheduledAt > Date.now()
}

/**
 * Whether nothing more waits on the message at the front of the order: the agent
 * took it, it can never be given, or it was dropped or cancelled and the hub has
 * answered for the cancel. A cancel in flight is not settled until then, since
 * the row the device dropped may still be on its way to the hub.
 */
function frontIsSettled(front: { sessionId: string; localId: string }): boolean {
    const row = findMessageByLocalId(front.sessionId, front.localId)
    if (row) {
        return row.invokedAt != null || row.status === 'failed'
    }
    return !isSendAborted(front.sessionId, front.localId)
}

/** The hub refused the send because the session is no longer live. */
function isSessionInactiveError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 409 && error.code === 'session_inactive'
}

export function useSendMessage(
    api: ApiClient | null,
    sessionId: string | null,
    options?: UseSendMessageOptions
): {
    // Returns the started mutation's attempt id, or false when the call was
    // rejected pre-mutation (no-api / no-session / pending) OR the async
    // resolveSessionId step threw. Async is required because inactive-session
    // resume happens before mutation.mutate(), and a sync `true` would let the
    // caller clear UI state (e.g. pendingSchedule) before knowing whether
    // resume succeeded — see SessionChat.handleSend.
    sendMessage: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ) => Promise<SendMessageAcceptance | false>
    retryMessage: (localId: string) => boolean
    /**
     * Stop the send of this local id.
     *
     * - `dropped`: it was typed behind another send and never left this device.
     * - `aborted`: its POST was on the wire. The row goes at once; whether the hub was already
     *   holding the request is settled afterwards (useAbortedSendReconciler).
     * - `false`: there was no such send to stop.
     */
    cancelSending: (localId: string) => 'dropped' | 'aborted' | false
    /** A POST is on the wire or a resume is running. */
    isSending: boolean
    /**
     * Whether the composer has to wait: a resume is running, or a POST is in
     * flight for a session that is not live. A live session never locks it
     * (see `isActive`).
     */
    isComposerLocked: boolean
} {
    const { haptic } = usePlatform()
    const [isResolving, setIsResolving] = useState(false)
    const resolveGuardRef = useRef(false)
    /** Retries fetching a stripped image preview before re-sending: local id → session id. */
    const hydratingRetriesRef = useRef(new Map<string, string>())
    const isSessionThinkingRef = useRef(options?.isSessionThinking ?? false)
    isSessionThinkingRef.current = options?.isSessionThinking ?? false
    const isActiveRef = useRef(options?.isActive ?? false)
    isActiveRef.current = options?.isActive === true
    /** The POST on the wire, if any. */
    const inflightRef = useRef<{ sessionId: string; localId: string; controller: AbortController } | null>(null)
    /** Sends typed and not posted yet, in the order they were typed. */
    const sendQueueRef = useRef<SendMessageInput[]>([])
    /** The message the queue is waiting on the agent to take before the next one is posted. */
    const frontRef = useRef<{ sessionId: string; localId: string } | null>(null)
    const frontCleanupRef = useRef<(() => void) | null>(null)
    /** Local ids handed to the mutation and not settled yet. */
    const postingRef = useRef(new Map<string, string>())
    /** Sends the user cancelled in flight; their settlement has nothing left to do. */
    const userAbortedRef = useRef(new Set<string>())
    /** Sends handed to the mutation whose request has not started yet (it starts a few ticks later). */
    const startingRef = useRef(new Map<string, SendMessageInput>())

    const mutation = useMutation({
        mutationFn: async (input: SendMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const controller = new AbortController()
            inflightRef.current = { sessionId: input.sessionId, localId: input.localId, controller }
            startingRef.current.delete(input.localId)
            // Cancelled in the ticks between being handed over and its request starting.
            if (userAbortedRef.current.has(input.localId)) controller.abort()
            try {
                await api.sendMessage(
                    input.sessionId,
                    input.text,
                    input.localId,
                    input.attachments,
                    input.scheduledAt,
                    input.deliveryMode,
                    { signal: controller.signal },
                )
            } finally {
                if (inflightRef.current?.controller === controller) {
                    inflightRef.current = null
                }
            }
        },
        onMutate: async (input) => {
            const successStatus = isSessionThinkingRef.current ? 'queued' as const : 'sent' as const
            // Observation only (send_stall): reuses this exact state machine —
            // no second timer. The box records whether the watchdog already
            // fired so a late settlement reports as late-success/late-error.
            const watchdogFired = { current: false }
            const watchdog = setTimeout(() => {
                // Still pending: surface a retry affordance instead of an
                // endless spinner. Purely visual — the mutation keeps running,
                // and any eventual onSuccess/onError transition overwrites
                // this status (or removes the row) as usual.
                updateMessageStatus(input.sessionId, input.localId, 'failed')
                watchdogFired.current = true
                try {
                    telemetryClient.capture('diag', 'send_stall', {
                        pendingMs: SEND_WATCHDOG_MS,
                        outcome: 'timeout-marked'
                    }, { sessionId: input.sessionId, severity: 'warn' })
                } catch {
                    // fail-silent
                }
            }, SEND_WATCHDOG_MS)
            return { successStatus, watchdog, watchdogFired }
        },
        onSuccess: (_, input, context) => {
            clearTimeout(context?.watchdog)
            updateMessageStatus(
                input.sessionId,
                input.localId,
                context?.successStatus ?? 'sent'
            )
            haptic.notification('success')
            if (context?.watchdogFired.current) {
                try {
                    telemetryClient.capture('diag', 'send_stall', {
                        pendingMs: SEND_WATCHDOG_MS,
                        outcome: 'late-success'
                    }, { sessionId: input.sessionId })
                } catch {
                    // fail-silent
                }
            }
            // Observation (turn_latency): the send POST settled — arm the
            // first-agent-event clock for this session's turn.
            noteSendSettled(input.sessionId)
            options?.onSuccess?.(input.sessionId)
            // The wire is free; the next one typed behind this goes out once the agent has taken it.
            settleAfterPost(input)
        },
        onError: (error, input, context) => {
            clearTimeout(context?.watchdog)
            if (userAbortedRef.current.delete(input.localId)) {
                // The user cancelled this send: its row is gone and there is
                // nothing to restore or to report.
                settleAfterDrop(input)
                return
            }
            if (context?.watchdogFired.current) {
                try {
                    telemetryClient.capture('diag', 'send_stall', {
                        pendingMs: SEND_WATCHDOG_MS,
                        outcome: 'late-error'
                    }, { sessionId: input.sessionId })
                } catch {
                    // fail-silent
                }
            }
            // These stay in the thread as a failed bubble, so the user retries
            // from the row:
            // - sends with attachments: the composer-restore path can only
            //   re-seat text + scheduledAt, not the uploaded attachment
            //   metadata. Removing the row would destroy the attachment
            //   preview AND leave the operator with no retry surface for it;
            // - sends to a live session: the composer is not locked while a
            //   POST is in flight, so it may hold the next message by now, and
            //   a restore would have to drop either that draft or this text.
            //   The one exception is the hub answering `session_inactive`: the
            //   row cannot be retried until the session is reopened, so that
            //   one goes back to the composer with the reopen affordance.
            if ((input.attachments && input.attachments.length > 0) || (input.live && !isSessionInactiveError(error))) {
                updateMessageStatus(input.sessionId, input.localId, 'failed')
                // What the hub said, in its own words, without the envelope.
                const reason = error instanceof Error ? apiErrorMessage(error, error.message).trim() : ''
                if (reason) noteSendFailure(input.sessionId, input.localId, reason)
                haptic.notification('error')
                settleAfterDrop(input)
                return
            }
            // The composer-restore path: drop the optimistic row from the
            // thread (otherwise the failed bubble would visually duplicate the
            // same text the composer is about to restore, and the operator
            // could stack a stale failed turn next to a fresh send) and hand
            // the text + scheduledAt + sessionId back so the route can put
            // both back into the composer keyed to the right session.
            removeOptimisticMessage(input.sessionId, input.localId)
            haptic.notification('error')
            options?.onError?.({
                sessionId: input.sessionId,
                text: input.text,
                error,
                scheduledAt: input.scheduledAt ?? null,
                deliveryMode: input.deliveryMode,
                mutationStarted: true,
            })
            settleAfterDrop(input)
        },
    })

    // Stable identities for sendMessage / retryMessage (they are props of the memoized
    // SessionChat): the route rebuilds the `options` object on every render and the
    // mutation result flips with isPending, so both are read through refs at call time.
    const optionsRef = useRef(options)
    optionsRef.current = options
    const mutationRef = useRef(mutation)
    mutationRef.current = mutation

    const startSend = useCallback((input: SendMessageInput) => {
        postingRef.current.set(input.localId, input.sessionId)
        startingRef.current.set(input.localId, input)
        mutationRef.current.mutate(input)
    }, [])

    /** Posts the next send that may go, if the wire is free. */
    const pump = useCallback(() => {
        if (postingRef.current.size > 0) return
        const front = frontRef.current
        const index = sendQueueRef.current.findIndex((input) => front === null || isScheduledAhead(input))
        if (index === -1) return
        const [input] = sendQueueRef.current.splice(index, 1)
        startSend(input)
    }, [startSend])
    const pumpRef = useRef(pump)
    pumpRef.current = pump

    /** The front has been settled: nothing waits on it any more, so the queue moves. */
    const releaseFront = useCallback(() => {
        frontCleanupRef.current?.()
        frontCleanupRef.current = null
        frontRef.current = null
        pumpRef.current()
    }, [])
    const releaseFrontRef = useRef(releaseFront)
    releaseFrontRef.current = releaseFront

    /**
     * A message has reached the hub. The next one typed behind it now waits until
     * the agent has taken this one (see SEND_ORDERING_GRACE_MS): the window says
     * when that happens, the aborted-sends ledger says when a cancel of it is
     * answered, and the timer says when to stop waiting.
     */
    const holdTheQueueFor = useCallback((input: SendMessageInput) => {
        if (!input.live || isScheduledAhead(input)) {
            pumpRef.current()
            return
        }
        const front = { sessionId: input.sessionId, localId: input.localId }
        frontRef.current = front
        let done = false
        const finish = () => {
            if (done) return
            done = true
            unsubscribeWindow()
            unsubscribeAborted()
            clearTimeout(timer)
            releaseFrontRef.current()
        }
        const check = () => {
            if (frontIsSettled(front)) finish()
        }
        const unsubscribeWindow = subscribeMessageWindow(front.sessionId, check)
        const unsubscribeAborted = subscribeAbortedSends(check)
        const timer = setTimeout(finish, SEND_ORDERING_GRACE_MS)
        frontCleanupRef.current = finish
        // The agent may have taken it while the hub's answer was still on its way back.
        check()
        pumpRef.current()
    }, [])

    /** What follows a send that reached the hub: the next one waits for the agent to take it. */
    const settleAfterPost = useCallback((input: SendMessageInput) => {
        postingRef.current.delete(input.localId)
        startingRef.current.delete(input.localId)
        holdTheQueueFor(input)
    }, [holdTheQueueFor])

    /** What follows a send that did not reach the hub, or was stopped: nothing waits on it. */
    const settleAfterDrop = useCallback((input: SendMessageInput) => {
        postingRef.current.delete(input.localId)
        startingRef.current.delete(input.localId)
        pumpRef.current()
    }, [])

    // Leaving the page must not strand what was typed behind a slow send: what is
    // still queued goes out at once, in order.
    useEffect(() => () => {
        frontCleanupRef.current?.()
        frontCleanupRef.current = null
        frontRef.current = null
        const queued = sendQueueRef.current
        sendQueueRef.current = []
        for (const input of queued) startSend(input)
    }, [startSend])

    /** A send leaves this device: its row goes up at once, its POST as soon as it may go. */
    const dispatchSend = useCallback((input: SendMessageInput) => {
        clearSendFailure(input.sessionId, input.localId)
        // The row goes up here and now, before anything is asked of the network layer: a message
        // the user sent is in the conversation from this moment. (A retry keeps the row it already has.)
        if (findMessageByLocalId(input.sessionId, input.localId) === null) {
            appendOptimisticMessage(input.sessionId, createOptimisticMessage(input, 'sending'))
        }
        sendQueueRef.current.push(input)
        pumpRef.current()
    }, [])

    const sendMessage = useCallback(async (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode: MessageDeliveryMode = 'queue',
    ): Promise<SendMessageAcceptance | false> => {
        const options = optionsRef.current
        const mutation = mutationRef.current
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return false
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return false
        }
        const live = options?.isActive === true
        // A live session queues behind a POST in flight instead of being refused.
        if ((!live && mutation.isPending) || resolveGuardRef.current) {
            options?.onBlocked?.('pending')
            return false
        }
        const localId = makeClientSideId('local')
        const createdAt = Date.now()
        let targetSessionId = sessionId
        let sendAttachments = attachments
        if (!live && options?.resolveSessionId) {
            resolveGuardRef.current = true
            setIsResolving(true)
            try {
                const resolved = await options.resolveSessionId(sessionId)
                targetSessionId = resolved.sessionId
                if (resolved.resumed) {
                    // Await draft transfer / navigation before the mutation so
                    // hidden inactive attachments move with the resumed id
                    // (including same-id PTY/Pi/Cursor resumes).
                    const resolution = await options.onSessionResolved?.(
                        targetSessionId,
                        { text, attachments },
                    )
                    if (resolution?.deferUntilDraftHydrated) {
                        // Target composer still needs to hydrate/re-upload files.
                        return false
                    }
                    if (resolution?.attachments) {
                        sendAttachments = resolution.attachments
                    }
                }
            } catch (error) {
                haptic.notification('error')
                console.error('Failed to resolve session before send:', error)
                // #918: surface the failure via onError so the route can render
                // an inline affordance instead of silently swallowing the
                // typed text.  This covers the "no resume target" branch
                // (inactiveSessionCanResume === false) and also any failure
                // from api.resumeSession itself.  The mutation never started
                // (no optimistic row to clean up); onError is the only
                // visibility hook the consumer has for this pre-mutation
                // path.  Key by the ORIGINAL sessionId because navigation
                // hasn't happened yet -- the operator is still on the
                // archived session's route.
                options?.onError?.({
                    sessionId,
                    text,
                    error,
                    scheduledAt: scheduledAt ?? null,
                    deliveryMode,
                    mutationStarted: false,
                })
                return false
            } finally {
                resolveGuardRef.current = false
                setIsResolving(false)
            }
        }
        dispatchSend({
            sessionId: targetSessionId,
            text,
            localId,
            createdAt,
            attachments: sendAttachments,
            scheduledAt,
            deliveryMode,
            live,
        })
        return { attemptId: localId }
    }, [api, sessionId, haptic, dispatchSend])

    const cancelSending = useCallback((localId: string): 'dropped' | 'aborted' | false => {
        // A retry still fetching a dropped image preview has not started either: it goes back to
        // being the failed row it was.
        const hydratingSession = hydratingRetriesRef.current.get(localId)
        if (hydratingSession !== undefined) {
            hydratingRetriesRef.current.delete(localId)
            userAbortedRef.current.add(localId)
            updateMessageStatus(hydratingSession, localId, 'failed')
            return 'dropped'
        }
        const queuedIndex = sendQueueRef.current.findIndex((item) => item.localId === localId)
        if (queuedIndex !== -1) {
            // Typed behind another send and not posted yet: nothing of it has left this device.
            const [queued] = sendQueueRef.current.splice(queuedIndex, 1)
            clearSendFailure(queued.sessionId, localId)
            removeOptimisticMessage(queued.sessionId, localId)
            return 'dropped'
        }
        // Handed to the mutation, request not out the door yet: the same cancel, and the request
        // goes out already aborted.
        const starting = inflightRef.current?.localId === localId ? inflightRef.current : startingRef.current.has(localId)
            ? { sessionId: startingRef.current.get(localId)!.sessionId }
            : null
        if (!starting) return false
        userAbortedRef.current.add(localId)
        // The row goes now. Aborting the request stops the wait here only; whether the hub was
        // already holding it is settled afterwards, and its echo cancelled if it turns up.
        markSendAborted(starting.sessionId, localId)
        clearSendFailure(starting.sessionId, localId)
        removeOptimisticMessage(starting.sessionId, localId)
        inflightRef.current?.controller.abort()
        return 'aborted'
    }, [])

    const retryMessage = useCallback((localId: string): boolean => {
        const options = optionsRef.current
        const mutation = mutationRef.current
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return false
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return false
        }
        const live = options?.isActive === true
        if ((!live && mutation.isPending) || resolveGuardRef.current || hydratingRetriesRef.current.has(localId)) {
            options?.onBlocked?.('pending')
            return false
        }

        const message = findMessageByLocalId(sessionId, localId)
        if (!message?.originalText) return false

        const attachments = getMessageAttachments(message)
        // A new attempt outruns an earlier cancel of this same row.
        userAbortedRef.current.delete(localId)
        updateMessageStatus(sessionId, localId, 'sending')

        // Captured for the deferred retry below (narrowing does not cross into it).
        const session = sessionId
        const text = message.originalText
        const retry = (withAttachments: AttachmentMetadata[] | undefined) => {
            if (userAbortedRef.current.has(localId)) return
            dispatchSend({
                sessionId: session,
                text,
                localId,
                createdAt: message.createdAt,
                attachments: withAttachments,
                scheduledAt: message.scheduledAt ?? null,
                deliveryMode: getRetryDeliveryMode(getMessageDeliveryMode(message)),
                live,
            })
        }

        if (!attachments?.some((attachment) => attachment.hasPreview === true && !attachment.previewUrl)) {
            retry(attachments)
            return true
        }

        // Message pages leave large image previews out, and the CLI rebuilds
        // the file from `previewUrl`: fetch it back before the retry goes out,
        // or the retried send would drop the screenshot.
        hydratingRetriesRef.current.set(localId, session)
        void rehydrateAttachmentPreviews(api, session, message.id ?? localId, attachments)
            .then(retry)
            .finally(() => hydratingRetriesRef.current.delete(localId))
        return true
    }, [api, sessionId, haptic, dispatchSend])

    return {
        sendMessage,
        retryMessage,
        cancelSending,
        isSending: mutation.isPending || isResolving,
        isComposerLocked: isResolving || (mutation.isPending && !isActiveRef.current),
    }
}

import { useAui } from '@assistant-ui/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { removeOptimisticMessage } from '@/lib/message-window-store'
import { markSendAborted } from '@/lib/abortedSends'
import { clearSendFailure } from '@/lib/sendFailures'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'
import { useSteerQueuedMessage } from '@/hooks/mutations/useSteerQueuedMessage'
import { useRetryIndeterminateMessage } from '@/hooks/mutations/useRetryIndeterminateMessage'
import { useDeliverQueuedMessageNow } from '@/hooks/mutations/useDeliverQueuedMessageNow'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { isSessionTaskMessageLocalId } from '@hapi/protocol'
import {
    beginQueuedOperation,
    clearQueuedEditRecovery,
    endQueuedOperation,
    getQueuedEditRecovery,
    isQueuedOperationPending,
    saveQueuedEditRecovery,
    subscribeQueuedEditRecovery,
    subscribeQueuedOperation,
} from '@/lib/queued-edit-recovery'
import {
    computeCanCancel,
    computeEditPendingSchedule,
    getQueuedMessageEditText,
    getQueuedMessagePreview,
    pendingSchedulesEqual,
} from '@/lib/queuedMessageRules'

/**
 * What the user can do with one user row that has not reached the agent (or failed to).
 *
 * Each `can…` says whether that thing may be done right now. Edit and cancel are part of the row
 * and only wait on it; the others (steer, send now, resolve an unknown outcome) exist only where
 * they apply.
 */
export type QueuedRowActions = {
    /** A prompt a session task sent: it offers Skip only, never a manual delivery. */
    fromTask: boolean
    /** Its POST is still on this device's wire. */
    sending: boolean
    /** The hub refused it or the request failed: the row waits in the thread for a retry. */
    failed: boolean
    /** Cancelling a message the agent does not have yet: on the device while its POST is in flight, on the hub after. */
    canCancel: boolean
    cancel: () => void
    /** Removing a failed row. A row the hub may hold is cancelled with it. */
    canDismiss: boolean
    dismiss: () => void
    /** Taking the text back to edit it: cancel + restore for a waiting row, restore for a failed one. */
    canEdit: boolean
    edit: () => void
    canSteer: boolean
    steer: () => void
    steerPending: boolean
    canDeliverNow: boolean
    deliverNow: () => void
    deliverNowPending: boolean
    /** A steer whose outcome is unknown and not still confirming: the row asks to be resolved. */
    needsResolution: boolean
    waitingForCompaction: boolean
    /** A steer is out and the agent has not confirmed it. */
    deliveryPending: boolean
    retryOutcome: () => void
    retryPending: boolean
}

export type QueuedMessageActions = {
    /** Computed when asked, from the row as it is now. */
    row: (msg: DecryptedMessage) => QueuedRowActions
}

const QueuedMessageActionsContext = createContext<QueuedMessageActions | null>(null)

/** Null outside a session (and in tests that render a row on its own). */
export function useOptionalQueuedMessageActions(): QueuedMessageActions | null {
    return useContext(QueuedMessageActionsContext)
}

function useQueuedMessageActions(input: {
    api: ApiClient | null
    sessionId: string
    compactionPendingMessageIds?: readonly string[]
    /** Current composer schedule, used only to guard an asynchronous edit restore. */
    pendingSchedule: PendingSchedule | null
    /** Monotonic per-session revision; schedule selections win over an async edit restore. */
    pendingScheduleRevision: number
    onEdit?: (params: { text: string; pendingSchedule: PendingSchedule | null }) => void
    canSteer?: boolean
    deliveryActive?: boolean
    sharedNative?: boolean
    onCancelSending?: (localId: string) => 'dropped' | 'aborted' | false
}): QueuedMessageActions {
    const { api, sessionId } = input
    const assistantApi = useAui()
    const cancelMutation = useCancelQueuedMessage(api)
    const steerMutation = useSteerQueuedMessage(api)
    const retryMutation = useRetryIndeterminateMessage(api)
    const deliverNowMutation = useDeliverQueuedMessageNow(api)
    const { t } = useTranslation()
    const { addToast } = useToast()
    const mountedRef = useRef(true)
    const attemptedRecoveryIdsRef = useRef(new Set<string>())
    // Every input and mutation is read at call time: the value handed to the rows never changes
    // identity, so a row does not render again because another one was acted on.
    const inputRef = useRef(input)
    inputRef.current = input
    const cancelMutationRef = useRef(cancelMutation)
    cancelMutationRef.current = cancelMutation
    const steerMutationRef = useRef(steerMutation)
    steerMutationRef.current = steerMutation
    const retryMutationRef = useRef(retryMutation)
    retryMutationRef.current = retryMutation
    const deliverNowMutationRef = useRef(deliverNowMutation)
    deliverNowMutationRef.current = deliverNowMutation
    const tRef = useRef({ t, addToast })
    tRef.current = { t, addToast }

    const queuedOperationPending = useSyncExternalStore(
        useCallback((listener) => subscribeQueuedOperation(sessionId, listener), [sessionId]),
        useCallback(() => isQueuedOperationPending(sessionId), [sessionId]),
        () => false,
    )

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    const restoreQueuedEditRecovery = useCallback(() => {
        const recovery = getQueuedEditRecovery(sessionId)
        if (!recovery || attemptedRecoveryIdsRef.current.has(recovery.id)) return
        attemptedRecoveryIdsRef.current.add(recovery.id)

        const currentText = assistantApi.composer().getState().text
        // A new session starts at revision 0. Any schedule interaction, even
        // select-then-clear back to null, increments it and wins over recovery.
        const textCompatible = currentText === recovery.composerTextAtEdit
        const scheduleCompatible = inputRef.current.pendingScheduleRevision === 0
        if (!textCompatible || !scheduleCompatible) {
            if (mountedRef.current) {
                tRef.current.addToast({
                    title: tRef.current.t('queuedMessages.editCurrentDraftKept'),
                    body: '',
                    sessionId,
                    url: window.location.href,
                })
            }
            clearQueuedEditRecovery(sessionId)
            return
        }

        if (recovery.text) {
            assistantApi.composer().setText(recovery.text)
        }
        inputRef.current.onEdit?.({ text: recovery.text, pendingSchedule: recovery.pendingSchedule })
        clearQueuedEditRecovery(sessionId)
    }, [assistantApi, sessionId])

    useEffect(() => {
        let disposed = false
        let generation = 0
        const scheduledHandles = new Set<number>()
        const scheduleFrame = (callback: FrameRequestCallback): number => {
            if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
            return window.setTimeout(() => callback(Date.now()), 0)
        }
        const cancelFrame = (handle: number): void => {
            if (typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(handle)
            } else {
                window.clearTimeout(handle)
            }
        }
        const attemptAfterComposerDraft = () => {
            const attemptGeneration = ++generation
            const scheduleAttemptFrame = (callback: FrameRequestCallback) => {
                let handle = 0
                handle = scheduleFrame((timestamp) => {
                    scheduledHandles.delete(handle)
                    if (disposed || attemptGeneration !== generation) return
                    callback(timestamp)
                })
                scheduledHandles.add(handle)
            }
            scheduleAttemptFrame(() => {
                scheduleAttemptFrame(restoreQueuedEditRecovery)
            })
        }
        attemptAfterComposerDraft()
        const unsubscribe = subscribeQueuedEditRecovery(sessionId, attemptAfterComposerDraft)
        return () => {
            disposed = true
            generation++
            unsubscribe()
            for (const handle of scheduledHandles) {
                cancelFrame(handle)
            }
            scheduledHandles.clear()
        }
    }, [restoreQueuedEditRecovery, sessionId])

    const row = useCallback((msg: DecryptedMessage): QueuedRowActions => {
        const { compactionPendingMessageIds } = inputRef.current
        const { t: tNow, addToast: addToastNow } = tRef.current
        const cancel = cancelMutationRef.current
        const steer = steerMutationRef.current
        const retry = retryMutationRef.current
        const deliverNow = deliverNowMutationRef.current
        const preview = getQueuedMessagePreview(msg)
        const editText = getQueuedMessageEditText(preview)
        const localId = msg.localId ?? msg.id
        // A prompt a task inserted cannot be edited into a manual message or
        // steered: the task tracks that row. Cancelling it is the task's "Skip": the
        // task moves on, and the history lists the prompt as cancelled.
        const fromTask = isSessionTaskMessageLocalId(msg.localId)
        const failed = msg.status === 'failed'
        const sending = msg.status === 'sending'
        const hasLocalId = Boolean(msg.localId)
        const hasServerEcho = hasLocalId ? msg.id !== msg.localId : true

        const waitingForCompaction = msg.deliveryState === 'indeterminate'
            && compactionPendingMessageIds?.includes(localId) === true
        const deliveryPending = msg.deliveryPending === true && inputRef.current.deliveryActive === true
        const needsResolution = !failed && msg.deliveryState === 'indeterminate' && !deliveryPending
        const operationPending = cancel.isPending || queuedOperationPending || deliveryPending

        /** One queued operation per session at a time; a failed one has already put its row back. */
        const run = (request: () => Promise<unknown>) => {
            const token = beginQueuedOperation(sessionId)
            if (!token) return
            void request().catch(() => {
                // The mutation already put its row back and gave haptic feedback.
            }).finally(() => {
                endQueuedOperation(sessionId, token)
            })
        }

        /** Cancel = DELETE /sessions/:id/messages/:messageId with optimistic removal. The hub
         *  knows a row by its local id too, so this works before it has echoed the row.
         *  The outcome is said out loud, except `cancelled` when the cancel is only the first half
         *  of an edit (the text coming back is that one's result). */
        const requestCancel = (options: { announceCancelled: boolean }) => cancel.mutateAsync({
            sessionId,
            messageId: msg.id,
            localId,
            snapshot: msg,
        }).then((result) => {
            if (result.status === 'invoked') {
                // The agent took the message before the cancel arrived; the mutation put it back as sent.
                addToastNow({ title: tNow('queuedMessages.cancelTooLate'), body: '', sessionId, url: window.location.href })
            } else if (result.status === 'cancelled' && options.announceCancelled) {
                addToastNow({ title: tNow('queuedMessages.cancelled'), body: '', sessionId, url: window.location.href })
            }
            return result
        }, (error: unknown) => {
            // useCancelQueuedMessage put the row back; say why it is still there.
            addToastNow({
                title: tNow('queuedMessages.cancelFailed'),
                body: error instanceof Error ? error.message : '',
                sessionId,
                url: window.location.href,
            })
            throw error
        })

        // Before the hub echoes the row a DELETE would find nothing while the POST could
        // still land, so the only way to stop it is on this device.
        const canStopSend = sending && !hasServerEcho && !operationPending && Boolean(inputRef.current.onCancelSending)
        const canCancel = !failed && (canStopSend || computeCanCancel({ id: msg.id, localId: msg.localId, isPending: operationPending }))
        const cancelRow = () => {
            if (!canCancel) return
            if (canStopSend) {
                const stopped = inputRef.current.onCancelSending?.(localId)
                if (stopped === 'aborted') {
                    // The hub may still be holding the request; useAbortedSendReconciler settles it
                    // and says how it went.
                    return
                }
                if (stopped === 'dropped') {
                    // It never left this device: that is the whole of it.
                    addToastNow({ title: tNow('queuedMessages.cancelled'), body: '', sessionId, url: window.location.href })
                    return
                }
                // The request settled a breath ago, between the tap and here: nothing to stop,
                // and the hub is asked (it knows the row by its local id).
            }
            run(() => requestCancel({ announceCancelled: true }))
        }

        // A failed row is this device's to remove. The request may have failed after the hub
        // committed it, though, so a row the hub echoed is cancelled, and one it may still be
        // holding is remembered so that its echo is cancelled when it turns up.
        const canDismiss = failed && !fromTask && !operationPending
        const removeFailedRow = () => {
            clearSendFailure(sessionId, localId)
            removeOptimisticMessage(sessionId, localId)
            if (!hasServerEcho) markSendAborted(sessionId, localId)
        }
        const dismiss = () => {
            if (!canDismiss) return
            if (hasServerEcho) {
                run(() => requestCancel({ announceCancelled: false }))
                return
            }
            removeFailedRow()
        }

        const handleEdit = async () => {
            if (!canEdit) return
            if (canStopSend && inputRef.current.onCancelSending?.(localId)) {
                // The POST is still on the wire: it is stopped here, then the text is handed back.
                // There is nothing on the hub to cancel first, and the abort remembers the send
                // should the hub still insert it. (If the request had just settled, the abort says
                // so and the way down below asks the hub instead.)
                const composerTextAtEdit = assistantApi.composer().getState().text
                if (mountedRef.current && assistantApi.composer().getState().text === composerTextAtEdit) {
                    if (editText) assistantApi.composer().setText(editText)
                    inputRef.current.onEdit?.({ text: editText, pendingSchedule: computeEditPendingSchedule(msg.scheduledAt, Date.now()) })
                }
                return
            }
            if (failed) {
                // The text only goes back into an empty composer: a draft already there is the user's.
                const composerIsEmpty = () => !mountedRef.current || assistantApi.composer().getState().text === ''
                if (!composerIsEmpty()) {
                    addToastNow({ title: tNow('queuedMessages.editDraftKept'), body: '', sessionId, url: window.location.href })
                    return
                }
                const restore = () => {
                    if (composerIsEmpty() && editText) assistantApi.composer().setText(editText)
                    inputRef.current.onEdit?.({ text: editText, pendingSchedule: computeEditPendingSchedule(msg.scheduledAt, Date.now()) })
                }
                if (hasServerEcho) {
                    // The hub echoed this row, so the request was committed after all: it has to go
                    // there first, or the edited message would be sent twice.
                    const token = beginQueuedOperation(sessionId)
                    if (!token) return
                    try {
                        await requestCancel({ announceCancelled: false })
                        restore()
                    } catch {
                        // useCancelQueuedMessage put the row back: nothing is handed to the composer.
                    } finally {
                        endQueuedOperation(sessionId, token)
                    }
                    return
                }
                removeFailedRow()
                restore()
                return
            }
            // Edit = cancel + restore composer (text + schedule).
            // Works the same for immediate-queued and future-scheduled messages.
            const restoredPendingSchedule = computeEditPendingSchedule(msg.scheduledAt, Date.now())
            // The cancel request is asynchronous. Keep the exact composer text from the
            // click so a newer draft or schedule is never replaced when success arrives.
            const composerTextAtEdit = assistantApi.composer().getState().text
            const { pendingSchedule: pendingScheduleAtEdit, pendingScheduleRevision: pendingScheduleRevisionAtEdit } = inputRef.current
            const token = beginQueuedOperation(sessionId)
            if (!token) return

            try {
                const result = await requestCancel({ announceCancelled: false })
                // Race guard: if the agent already consumed this message, skip prefill
                // and inform the user so they aren't confused by the row disappearing.
                // A 'busy' cancel means the row is inside an async steer / live
                // dispatch — it was NOT cancelled. Never prefill (the
                // instruction may still be delivered; prefilling invites a duplicate send).
                // Cancel still force-dismisses an already-indeterminate row (#1839);
                // Edit clears the stuck chip but waits for a confirmed cancel before
                // restoring composer text.
                if (result.status === 'busy') {
                    if (msg.deliveryState === 'indeterminate' && mountedRef.current) {
                        addToastNow({
                            title: tNow('queuedMessages.editBusyNotRestored'),
                            body: '',
                            sessionId,
                            url: window.location.href,
                        })
                    }
                    return
                }
                if (result.status === 'invoked') {
                    if (mountedRef.current) {
                        addToastNow({
                            title: tNow('queuedMessages.editAlreadyInvoked'),
                            body: '',
                            sessionId,
                            url: window.location.href,
                        })
                    }
                    return
                }

                const currentText = mountedRef.current
                    ? assistantApi.composer().getState().text
                    : composerTextAtEdit
                const composerChanged = currentText !== composerTextAtEdit
                const scheduleChanged = inputRef.current.pendingScheduleRevision !== pendingScheduleRevisionAtEdit
                    || !pendingSchedulesEqual(inputRef.current.pendingSchedule, pendingScheduleAtEdit)
                // Restore text and schedule as one unit. If either changed while the
                // cancel was pending, the user's newer composer state wins.
                if (composerChanged || scheduleChanged) {
                    if (mountedRef.current) {
                        addToastNow({
                            title: tNow('queuedMessages.editCurrentDraftKept'),
                            body: '',
                            sessionId,
                            url: window.location.href,
                        })
                    }
                    return
                }
                if (!mountedRef.current) {
                    // The original composer is gone. Persist both values and notify a
                    // same-session remount so the result is not lost or delayed until a
                    // later navigation cycle.
                    saveQueuedEditRecovery(sessionId, {
                        text: editText,
                        pendingSchedule: restoredPendingSchedule,
                        composerTextAtEdit,
                        pendingScheduleAtEdit,
                    })
                    return
                }
                if (editText) {
                    assistantApi.composer().setText(editText)
                }
                inputRef.current.onEdit?.({ text: editText, pendingSchedule: restoredPendingSchedule })
            } catch {
                // useCancelQueuedMessage restores the optimistic row and gives haptic feedback.
            } finally {
                endQueuedOperation(sessionId, token)
            }
        }

        const canEdit = failed ? canDismiss : (canCancel && !fromTask)

        // Steer delivers this message into the active Pi turn. Gated
        // on the same server-echo + no-pending-op conditions as
        // Edit/Cancel, and never offered for future-scheduled rows
        // (the hub rejects those).
        const canSteerRow = Boolean(
            inputRef.current.canSteer
            && !failed
            && !fromTask
            && msg.deliveryState !== 'indeterminate'
            && msg.scheduledAt == null
            && computeCanCancel({ id: msg.id, localId: msg.localId, isPending: operationPending })
        )
        const steerPending = steer.isPending
            && steer.variables?.sessionId === sessionId
            && steer.variables.messageId === msg.id

        // "Send now" (↑) recovers rows stranded by an abort:
        // the hub's session-alive replay is deduped away by
        // the CLI, so the row would hang until the session-end
        // sweep discards it unread. Offered only when no turn
        // is dispatching (deliveryActive) and Steer cannot run
        // (canSteerRow covers the mid-turn case).
        // A prompt a task inserted is off limits as well: the
        // task tracks that row and sends it in its own time,
        // so it offers Skip only, never a manual delivery.
        const canDeliverNowRow = Boolean(
            !failed
                && !fromTask
                && !canSteerRow
                && !inputRef.current.deliveryActive
                && !inputRef.current.sharedNative
                && msg.deliveryState !== 'indeterminate'
                // Future-scheduled rows mature through the
                // scheduler tick; once matured the hub accepts
                // deliver-now for them, so keep ↑ available.
                && (msg.scheduledAt == null || msg.scheduledAt <= Date.now())
                && computeCanCancel({ id: msg.id, localId: msg.localId, isPending: operationPending })
        )
        const deliverNowPending = deliverNow.isPending
            && deliverNow.variables?.sessionId === sessionId
            && deliverNow.variables.messageId === msg.id

        const retryPending = retry.isPending && retry.variables?.messageId === msg.id

        return {
            fromTask,
            sending,
            failed,
            canCancel,
            cancel: cancelRow,
            canDismiss,
            dismiss,
            canEdit,
            edit: () => { void handleEdit() },
            canSteer: canSteerRow,
            steer: () => run(() => steer.mutateAsync({ sessionId, messageId: msg.id })),
            steerPending,
            canDeliverNow: canDeliverNowRow,
            deliverNow: () => run(() => deliverNow.mutateAsync({ sessionId, messageId: msg.id })),
            deliverNowPending,
            needsResolution,
            waitingForCompaction,
            deliveryPending,
            retryOutcome: () => run(() => retry.mutateAsync({ sessionId, messageId: msg.id })),
            retryPending,
        }
    }, [assistantApi, sessionId, queuedOperationPending])

    // The function itself is the same object from mount to unmount; it changes only when a
    // queued operation starts or ends, which is what its flags depend on.
    return useMemo<QueuedMessageActions>(() => ({ row }), [row])
}

export function QueuedMessageActionsProvider(props: {
    api: ApiClient | null
    sessionId: string
    children: ReactNode
    compactionPendingMessageIds?: readonly string[]
    pendingSchedule: PendingSchedule | null
    pendingScheduleRevision: number
    onEdit?: (params: { text: string; pendingSchedule: PendingSchedule | null }) => void
    canSteer?: boolean
    deliveryActive?: boolean
    sharedNative?: boolean
    onCancelSending?: (localId: string) => 'dropped' | 'aborted' | false
}) {
    const { children, ...input } = props
    const actions = useQueuedMessageActions(input)
    return (
        <QueuedMessageActionsContext.Provider value={actions}>
            {children}
        </QueuedMessageActionsContext.Provider>
    )
}

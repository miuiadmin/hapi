import { useCallback, useSyncExternalStore } from 'react'
import type { DecryptedMessage } from '@/types/api'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { getSendFailure } from '@/lib/sendFailures'
import { useTranslation } from '@/lib/use-translation'
import type { QueuedRowActions } from '@/components/AssistantChat/queuedMessageActions'
import {
    CANCEL_BUTTON_CLASS,
    ClockIcon,
    CrossIcon,
    EditIcon,
    ROW_BUTTON_CLASS,
    SteerIcon,
} from '@/components/AssistantChat/queuedRowParts'

const NOOP_UNSUBSCRIBE = () => {}

/**
 * The row as the window holds it now, for as long as it is on its way to the agent or failed.
 * Subscribes only meanwhile: a delivered row costs nothing.
 */
export function usePendingMessageRow(
    sessionId: string | undefined,
    localId: string | null,
    active: boolean,
): DecryptedMessage | null {
    const subscribe = useCallback((listener: () => void) => (
        active && sessionId ? subscribeMessageWindow(sessionId, listener) : NOOP_UNSUBSCRIBE
    ), [sessionId, active])
    const getSnapshot = useCallback(() => {
        if (!active || !sessionId || !localId) return null
        for (const message of getMessageWindowState(sessionId).messages) {
            if (message.localId === localId) return message
        }
        return null
    }, [sessionId, localId, active])
    return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

export type UserSendPhase = 'failed' | 'sending' | 'waiting'

/**
 * What the user needs to know about a row the agent does not have yet.
 *
 * A row is `sending` while its POST is on the wire, and still `sending` once the hub has it when
 * the agent is free to take it: until the agent does, "sending" is the honest word. While the
 * agent is working, a row the hub has is `waiting` for its turn.
 */
export function getUserSendPhase(row: DecryptedMessage, agentBusy: boolean): UserSendPhase {
    if (row.status === 'failed') return 'failed'
    if (row.status === 'sending' || !agentBusy) return 'sending'
    return 'waiting'
}

/** The sentence under the text of a row the agent does not have yet. */
export function getUserSendStatusKey(row: DecryptedMessage, actions: QueuedRowActions, agentBusy: boolean): string {
    if (row.status === 'failed') return 'queuedMessages.failed'
    if (row.status !== 'sending') {
        // The hub has it. What is still unsettled about its delivery comes before where it waits.
        if (actions.waitingForCompaction) return 'queuedMessages.compactionPending'
        if (actions.deliveryPending) return 'queuedMessages.deliveryPending'
        if (actions.needsResolution) return 'queuedMessages.steerOutcomeUnknown'
        if (actions.steerPending) return 'queuedMessages.steerRequesting'
    }
    return getUserSendPhase(row, agentBusy) === 'waiting' ? 'queuedMessages.waiting' : 'queuedMessages.sending'
}

export type UserSendStateProps = {
    sessionId: string
    row: DecryptedMessage
    actions: QueuedRowActions
    /** The agent is working, so a message that reached the hub waits for its turn. */
    agentBusy: boolean
    /** Retries the failed send from its row. */
    onRetry?: () => void
}

/** Inside the bubble, under the text: a spinner while the message is on its way, the clock once it
 *  waits for the agent, and the failure with its retry. */
export function UserSendStatus(props: UserSendStateProps) {
    const { t } = useTranslation()
    const phase = getUserSendPhase(props.row, props.agentBusy)
    const { actions } = props
    const reason = phase === 'failed' ? getSendFailure(props.sessionId, props.row.localId) : null
    const key = getUserSendStatusKey(props.row, actions, props.agentBusy)
    const settledWords = key === 'queuedMessages.waiting'
        || key === 'queuedMessages.compactionPending'
        || key === 'queuedMessages.deliveryPending'
        || key === 'queuedMessages.steerOutcomeUnknown'
    return (
        <div
            data-testid="user-send-status"
            data-phase={phase}
            title={reason ?? undefined}
            className={`mt-0.5 flex items-center gap-1.5 text-[11px] leading-4 ${phase === 'failed' ? 'text-red-500' : 'text-[var(--app-chat-user-fg)] opacity-60'}`}
        >
            {phase === 'failed' ? (
                <svg className="block h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M8 4.75v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="8" cy="11.25" r="0.8" fill="currentColor" />
                </svg>
            ) : settledWords ? <ClockIcon className="h-3.5 w-3.5" /> : (
                <svg
                    className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                >
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
                    <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            )}
            <span className="min-w-0 truncate">
                {t(key)}
                {reason ? <span className="opacity-70"> · {reason}</span> : null}
            </span>
            {phase === 'failed' && props.onRetry ? (
                <button
                    type="button"
                    onClick={props.onRetry}
                    className="shrink-0 font-medium text-red-500 underline underline-offset-2 hover:opacity-80"
                >
                    {t('queuedMessages.retry')}
                </button>
            ) : null}
        </div>
    )
}

/**
 * Beside the bubble, on the side away from the screen edge: what can still be done with a message
 * the agent does not have yet (or one that failed on the way). Cancel is always last, next to the
 * bubble, and red.
 */
export function UserSendActions(props: UserSendStateProps) {
    const { t } = useTranslation()
    const { actions } = props
    const cancelLabel = actions.failed
        ? t('queuedMessages.dismissFailed')
        : actions.fromTask
            ? t('queuedMessages.skipTaskPrompt')
            : actions.sending ? t('queuedMessages.cancelSending') : t('queuedMessages.cancel')
    return (
        <div
            data-testid="user-send-actions"
            className="flex min-w-0 shrink-0 items-center gap-1 pointer-coarse:gap-1.5"
        >
            {actions.needsResolution && !actions.waitingForCompaction ? (
                <button
                    type="button"
                    aria-label={t('queuedMessages.retryOutcome')}
                    title={t('queuedMessages.retryOutcome')}
                    disabled={actions.retryPending}
                    onClick={actions.retryOutcome}
                    className={ROW_BUTTON_CLASS}
                >
                    <span aria-hidden="true" className="text-sm leading-none font-semibold">↻</span>
                </button>
            ) : null}
            {actions.canSteer ? (
                <button
                    type="button"
                    aria-label={t('queuedMessages.steer')}
                    title={t('queuedMessages.steer')}
                    disabled={actions.steerPending}
                    onClick={actions.steer}
                    className={ROW_BUTTON_CLASS}
                >
                    <SteerIcon />
                </button>
            ) : null}
            {actions.canDeliverNow ? (
                <button
                    type="button"
                    aria-label={t('queuedMessages.deliverNow')}
                    title={t('queuedMessages.deliverNow')}
                    disabled={actions.deliverNowPending}
                    onClick={actions.deliverNow}
                    className={ROW_BUTTON_CLASS}
                >
                    <span aria-hidden="true" className="text-sm leading-none font-semibold">↑</span>
                </button>
            ) : null}
            {/* Edit and cancel keep their place while a request for this row is on its way: a control
                that comes and goes makes the bubble lurch. The task-specific ones only exist when they apply. */}
            {actions.fromTask ? null : (
                <button
                    type="button"
                    aria-label={t('queuedMessages.edit')}
                    title={t('queuedMessages.edit')}
                    disabled={!actions.canEdit}
                    onClick={actions.edit}
                    className={ROW_BUTTON_CLASS}
                >
                    <EditIcon />
                </button>
            )}
            {actions.failed && actions.fromTask ? null : (
                <button
                    type="button"
                    aria-label={cancelLabel}
                    title={cancelLabel}
                    disabled={actions.failed ? !actions.canDismiss : !actions.canCancel}
                    onClick={actions.failed ? actions.dismiss : actions.cancel}
                    className={CANCEL_BUTTON_CLASS}
                    data-testid="user-send-cancel"
                >
                    <CrossIcon />
                </button>
            )}
        </div>
    )
}

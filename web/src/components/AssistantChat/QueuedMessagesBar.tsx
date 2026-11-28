import type { ApiClient } from '@/api/client'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { useParkedScheduled, useWaitingMessages } from '@/hooks/useQueuedMessages'
import { useTranslation } from '@/lib/use-translation'
import { formatScheduledTime } from '@/lib/scheduledTime'
import { getQueuedMessagePreview } from '@/lib/queuedMessageRules'
import { FromTaskChip } from '@/components/AssistantChat/messages/user-bubble'
import {
    QueuedMessageActionsProvider,
    useOptionalQueuedMessageActions,
} from '@/components/AssistantChat/queuedMessageActions'
import {
    CANCEL_BUTTON_CLASS,
    ClockIcon,
    CrossIcon,
    EditIcon,
    ROW_BUTTON_CLASS,
    ROW_BUTTON_GROUP_CLASS,
    SteerIcon,
} from '@/components/AssistantChat/queuedRowParts'

export {
    computeCanCancel,
    computeEditPendingSchedule,
    getQueuedMessageEditText,
    getQueuedMessagePreview,
} from '@/lib/queuedMessageRules'
export { sortQueuedMessages } from '@/lib/pending-messages'

type QueuedMessagesBarProps = {
    sessionId: string
    api: ApiClient | null
    /** Current composer schedule, used only to guard an asynchronous edit restore. */
    pendingSchedule?: PendingSchedule | null
    /** Monotonic per-session revision; schedule selections win over an async edit restore. */
    pendingScheduleRevision?: number
    /**
     * Called when the user takes a queued or scheduled message back to edit it.
     * The parent should restore `text` into the composer and `pendingSchedule` into the schedule state.
     */
    onEdit?: (params: { text: string; pendingSchedule: PendingSchedule | null }) => void
    onCancelSending?: (localId: string) => 'dropped' | 'aborted' | false
}

/**
 * The queue panel above the composer: the messages waiting their turn, each with an edit button
 * (✎) and a cancel button (✕).
 *
 * One message is in the thread at a time, the one on its way to the agent now (PendingUserMessages).
 * A message typed behind it waits here, in the order sent, and takes the thread's place when the one
 * before it is taken; so do the messages scheduled for a time still ahead, which have not been sent
 * at all.
 *
 * Edit = cancel + restore the text to the composer. A message that has not left this device is
 * stopped here; one the hub holds is cancelled there.
 * Cancel = DELETE /sessions/:id/messages/:messageId with optimistic removal, or here for a message
 * still on this device.
 *
 * Inside a session the actions come from the QueuedMessageActionsProvider the chat shares with the
 * thread, so a row is never acted on twice from two places. Rendered on its own (a test), the
 * panel provides them itself.
 */
export function QueuedMessagesBar(props: QueuedMessagesBarProps) {
    const shared = useOptionalQueuedMessageActions()
    const panel = <QueuedMessageList sessionId={props.sessionId} />
    if (shared) return panel
    return (
        <QueuedMessageActionsProvider
            api={props.api}
            sessionId={props.sessionId}
            pendingSchedule={props.pendingSchedule ?? null}
            pendingScheduleRevision={props.pendingScheduleRevision ?? 0}
            onEdit={props.onEdit}
            onCancelSending={props.onCancelSending}
        >
            {panel}
        </QueuedMessageActionsProvider>
    )
}

function QueuedMessageList({ sessionId }: { sessionId: string }) {
    // The first waiting message is the thread's; the rest are this panel's.
    const behind = useWaitingMessages(sessionId).slice(1)
    const scheduled = useParkedScheduled(sessionId)
    const actions = useOptionalQueuedMessageActions()
    const { t } = useTranslation()

    if (behind.length === 0 && scheduled.length === 0) {
        return null
    }

    const rows = [...behind, ...scheduled]
    return (
        <div
            role="status"
            aria-label={`${t('queuedMessages.heading')} (${rows.length})`}
            className="mx-auto w-full max-w-content"
        >
            <div className="px-3 pb-0 pt-2 text-sm text-[var(--app-fg-muted)]">
                <div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-[var(--app-hint)]">
                    <ClockIcon />
                    <span>{t('queuedMessages.heading')}</span>
                    <span className="tabular-nums opacity-70">· {rows.length}</span>
                </div>
                <ul className="flex max-h-32 flex-col gap-1.5 overflow-y-auto sm:max-h-48">
                    {rows.map((msg) => {
                        const row = actions?.row(msg)
                        const { text, attachmentNames } = getQueuedMessagePreview(msg)
                        const fromTask = row?.fromTask ?? false
                        const cancelLabel = fromTask
                            ? t('queuedMessages.skipTaskPrompt')
                            : row?.sending ? t('queuedMessages.cancelSending') : t('queuedMessages.cancel')
                        return (
                            <li
                                key={msg.localId ?? msg.id}
                                data-testid="queued-panel-row"
                                className="flex items-start gap-2 min-w-0 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm"
                            >
                                <div className="flex-1 min-w-0">
                                    {fromTask ? (
                                        <div className="mb-1">
                                            <FromTaskChip label={t('queuedMessages.fromTask')} />
                                        </div>
                                    ) : null}
                                    {text ? (
                                        <span className="line-clamp-3 whitespace-pre-wrap break-words text-[var(--app-fg)]">
                                            {text}
                                        </span>
                                    ) : null}
                                    {row?.steerPending && msg.deliveryState !== 'indeterminate' ? (
                                        <div className="mt-1 flex items-center gap-1 text-xs text-[var(--app-hint)]">
                                            <svg className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                                <path d="M12 2a10 10 0 0 1 10 10" />
                                            </svg>
                                            {t('queuedMessages.steerRequesting')}
                                        </div>
                                    ) : null}
                                    {msg.deliveryState === 'indeterminate' ? (
                                        <div className={`mt-1 text-xs ${row?.waitingForCompaction ? 'text-[var(--app-hint)]' : 'text-[var(--app-warning-text)]'}`}>
                                            {t(row?.waitingForCompaction
                                                ? 'queuedMessages.compactionPending'
                                                : row?.deliveryPending
                                                    ? 'queuedMessages.deliveryPending'
                                                    : 'queuedMessages.steerOutcomeUnknown')}
                                        </div>
                                    ) : null}
                                    {attachmentNames.length > 0 ? (
                                        <div className={text ? 'mt-1 flex flex-wrap gap-1' : 'flex flex-wrap gap-1'}>
                                            {attachmentNames.map((name, index) => (
                                                <span
                                                    key={`${name}-${index}`}
                                                    className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--app-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]"
                                                    title={name}
                                                >
                                                    <span aria-hidden="true">📎</span>
                                                    <span className="truncate">{name}</span>
                                                </span>
                                            ))}
                                        </div>
                                    ) : null}
                                    {msg.scheduledAt != null && msg.scheduledAt > Date.now() ? (
                                        <div className="mt-1 flex items-center gap-1 text-xs text-[var(--app-hint)]">
                                            <ClockIcon />
                                            <span>
                                                {t('queuedMessages.scheduledFor', { time: formatScheduledTime(msg.scheduledAt) })}
                                            </span>
                                        </div>
                                    ) : null}
                                </div>
                                <div className={ROW_BUTTON_GROUP_CLASS}>
                                    {row?.needsResolution && !row.waitingForCompaction ? (
                                        <button
                                            type="button"
                                            aria-label={t('queuedMessages.retryOutcome')}
                                            title={t('queuedMessages.retryOutcome')}
                                            disabled={row.retryPending}
                                            onClick={row.retryOutcome}
                                            onMouseDown={(e) => e.preventDefault()}
                                            className={ROW_BUTTON_CLASS}
                                        >
                                            <span aria-hidden="true" className="text-sm leading-none font-semibold">↻</span>
                                        </button>
                                    ) : null}
                                    {row?.canSteer ? (
                                        <button
                                            type="button"
                                            aria-label={t('queuedMessages.steer')}
                                            title={t('queuedMessages.steer')}
                                            disabled={row.steerPending}
                                            onClick={row.steer}
                                            onMouseDown={(e) => e.preventDefault()}
                                            className={ROW_BUTTON_CLASS}
                                        >
                                            <SteerIcon />
                                        </button>
                                    ) : null}
                                    {row?.canDeliverNow ? (
                                        <button
                                            type="button"
                                            aria-label={t('queuedMessages.deliverNow')}
                                            title={t('queuedMessages.deliverNow')}
                                            disabled={row.deliverNowPending}
                                            onClick={row.deliverNow}
                                            onMouseDown={(e) => e.preventDefault()}
                                            className={ROW_BUTTON_CLASS}
                                        >
                                            <span aria-hidden="true" className="text-sm leading-none font-semibold">↑</span>
                                        </button>
                                    ) : null}
                                    {fromTask ? null : (
                                        <button
                                            type="button"
                                            aria-label={t('queuedMessages.edit')}
                                            title={t('queuedMessages.edit')}
                                            disabled={!row?.canEdit}
                                            onClick={() => row?.edit()}
                                            onMouseDown={(e) => e.preventDefault()}
                                            className={ROW_BUTTON_CLASS}
                                        >
                                            <EditIcon />
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        aria-label={cancelLabel}
                                        title={cancelLabel}
                                        disabled={!row?.canCancel}
                                        onClick={() => row?.cancel()}
                                        onMouseDown={(e) => e.preventDefault()}
                                        className={CANCEL_BUTTON_CLASS}
                                    >
                                        <CrossIcon />
                                    </button>
                                </div>
                            </li>
                        )
                    })}
                </ul>
            </div>
        </div>
    )
}

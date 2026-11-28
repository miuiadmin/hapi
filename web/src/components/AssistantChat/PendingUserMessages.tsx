import { useEffect, useRef, useState } from 'react'
import { isSessionTaskMessageLocalId } from '@hapi/protocol'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'
import type { QueuedRowActions } from '@/components/AssistantChat/queuedMessageActions'
import { useWaitingMessages } from '@/hooks/useQueuedMessages'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { useTranslation } from '@/lib/use-translation'
import { useOptionalQueuedMessageActions } from '@/components/AssistantChat/queuedMessageActions'
import { FromTaskChip, getUserBubbleClassName, UserBubbleContent } from '@/components/AssistantChat/messages/user-bubble'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { getUserSendPhase, UserSendActions, UserSendStatus } from '@/components/AssistantChat/messages/UserSendState'

/** What a row offers outside a session (a test that renders it on its own): its state, and nothing to click. */
const NO_ACTIONS: QueuedRowActions = {
    fromTask: false,
    sending: true,
    failed: false,
    canCancel: false,
    cancel: () => {},
    canDismiss: false,
    dismiss: () => {},
    canEdit: false,
    edit: () => {},
    canSteer: false,
    steer: () => {},
    steerPending: false,
    canDeliverNow: false,
    deliverNow: () => {},
    deliverNowPending: false,
    needsResolution: false,
    waitingForCompaction: false,
    deliveryPending: false,
    retryOutcome: () => {},
    retryPending: false,
}

function rowKey(row: DecryptedMessage): string {
    return row.localId ?? row.id
}

function PendingUserMessage(props: { row: DecryptedMessage; sessionId: string; agentBusy: boolean; arrived: boolean; actions: QueuedRowActions }) {
    const { row, actions } = props
    const { t } = useTranslation()
    const { text, attachments } = readUserContent(row)
    const fromTask = isSessionTaskMessageLocalId(row.localId)
    const sendState = { sessionId: props.sessionId, row, actions, agentBusy: props.agentBusy }
    // Whether the message arrived, decided once, as this row was first drawn: the thread animates it
    // through this attribute (see HappyThread), which stays for as long as the row does.
    const [arrived] = useState(() => props.arrived)
    return (
        <div
            className="happy-message flex flex-col items-end scroll-mt-4"
            data-hapi-message-role="user"
            data-hapi-pending-row="true"
            data-hapi-local-send={arrived ? 'true' : undefined}
            data-hapi-send-phase={getUserSendPhase(row, props.agentBusy)}
        >
            <div className="flex min-w-0 max-w-full items-center justify-end gap-2">
                <UserSendActions {...sendState} />
                <div className={getUserBubbleClassName(row.status)}>
                    {fromTask ? (
                        <div className="mb-1.5">
                            <FromTaskChip label={t('queuedMessages.fromTask')} />
                        </div>
                    ) : null}
                    <div className="min-w-0">
                        {text.length > 0 ? <UserBubbleContent text={text} /> : null}
                        {attachments.length > 0 ? (
                            // A preview the page left out is fetched by the hub's row id, which a send still on this device has not got.
                            <MessageAttachments
                                attachments={attachments}
                                messageId={row.id === row.localId ? undefined : row.id}
                            />
                        ) : null}
                    </div>
                    <UserSendStatus {...sendState} />
                </div>
            </div>
        </div>
    )
}

/** The words and files of a user row, whatever shape the hub stores them in. */
function readUserContent(row: DecryptedMessage): { text: string; attachments: AttachmentMetadata[] } {
    const normalized = normalizeDecryptedMessage(row)
    if (normalized?.role !== 'user') return { text: '', attachments: [] }
    return { text: normalized.content.text ?? '', attachments: normalized.content.attachments ?? [] }
}

/**
 * The message on its way to the agent, drawn after the thread's own messages in the same list:
 * from the moment it leaves the composer it is part of the conversation, under whatever the agent
 * is producing, until the agent takes it.
 *
 * There is never more than one. A message typed while another is still on its way waits in the
 * queue panel above the composer, and takes this place when the one before it is taken; only
 * then does it leave for the agent (useSendMessage keeps them in that order).
 *
 * It is not a thread message. The thread holds what the agent already has; a message still on its
 * way would otherwise be taken for the last thing said while the agent works, and read as the
 * start of the next answer.
 *
 * A message scheduled for later is not here either: it has not been sent, and waits in the queue
 * panel until its time comes.
 */
export function PendingUserMessages(props: { sessionId: string; agentBusy: boolean }) {
    const waiting = useWaitingMessages(props.sessionId)
    const head = waiting[0] ?? null
    // Read here, in the component that also reads the rows, so a change to either re-reads both:
    // a row acted on and its actions must never be a render apart.
    const queuedActions = useOptionalQueuedMessageActions()

    // Which messages have been drawn here, and whether any commit has happened yet. One that is new
    // here has just arrived: typed while nothing else was on its way, or it has just taken the place
    // of the one before it and left the queue panel. Either way it rises into the thread. What was
    // already waiting when the conversation opened, or was drawn here before, does not: a row the
    // window drops for a tick and puts back must not arrive twice. Kept through an effect, not
    // written while rendering, so a render that is run again gives the same answer.
    const drawnRef = useRef<{ committed: boolean; heads: ReadonlySet<string> }>({ committed: false, heads: new Set() })
    const drawn = drawnRef.current
    const headKey = head ? rowKey(head) : null
    const arrived = headKey !== null && drawn.committed && !drawn.heads.has(headKey)
    useEffect(() => {
        drawnRef.current = {
            committed: true,
            heads: headKey === null ? drawn.heads : new Set([...drawn.heads, headKey]),
        }
    }, [headKey])

    if (!head) return null
    return (
        <PendingUserMessage
            key={rowKey(head)}
            row={head}
            sessionId={props.sessionId}
            agentBusy={props.agentBusy}
            arrived={arrived}
            actions={queuedActions?.row(head) ?? NO_ACTIONS}
        />
    )
}

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import {
    appendOptimisticMessage,
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
    markMessagesConsumed,
    updateMessageStatus,
} from '@/lib/message-window-store'
import { markSendAborted, resetAbortedSends } from '@/lib/abortedSends'
import { QueuedMessageActionsProvider } from './queuedMessageActions'
import { PendingUserMessages } from './PendingUserMessages'

const mocks = vi.hoisted(() => ({
    composerText: '',
    composerSetText: vi.fn(),
    addToast: vi.fn(),
    cancelMessage: vi.fn(),
    attachments: vi.fn(),
}))
vi.mock('@assistant-ui/react', () => ({
    useAui: () => ({
        composer: () => ({ getState: () => ({ text: mocks.composerText }), setText: mocks.composerSetText }),
    }),
    useAuiState: () => '',
}))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/toast-context', () => ({ useToast: () => ({ addToast: mocks.addToast }) }))
vi.mock('./messages/MessageAttachments', () => ({
    MessageAttachments: (props: { attachments: { filename: string }[] }) => (
        <div data-testid="attachments">{props.attachments.map((attachment) => attachment.filename).join(',')}</div>
    ),
}))
vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text }: { text: string }) => <span>{text}</span>,
}))

const sid = 'outbox-session'
const api = { cancelMessage: mocks.cancelMessage } as unknown as ApiClient

type Options = {
    agentBusy?: boolean
    onCancelSending?: (localId: string) => 'dropped' | 'aborted' | false
    onEdit?: (params: { text: string; pendingSchedule: PendingSchedule | null }) => void
}

function mount(options: Options = {}) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const view = (next: Options) => (
        <QueryClientProvider client={client}>
            <QueuedMessageActionsProvider api={api} sessionId={sid} pendingSchedule={null} pendingScheduleRevision={0} onEdit={next.onEdit} onCancelSending={next.onCancelSending}>
                {/* The rows sit in the thread's own list, after the thread's messages. */}
                <div className="happy-thread-messages flex flex-col gap-3">
                    <div data-hapi-message-role="assistant">the answer so far</div>
                    <PendingUserMessages sessionId={sid} agentBusy={next.agentBusy ?? false} />
                </div>
            </QueuedMessageActionsProvider>
        </QueryClientProvider>
    )
    const result = render(view(options))
    return { ...result, show: (next: Options) => result.rerender(view(next)) }
}

function userRow(id: string, localId: string, text: string, overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id, localId, seq: 3, createdAt: 1_000, invokedAt: null, scheduledAt: null,
        content: { role: 'user', content: { type: 'text', text } },
        ...overrides,
    } as DecryptedMessage
}
const serverRow = (text = 'take this', localId = 'local-1') => userRow('server-1', localId, text)
const waitingRows = () => [...document.querySelectorAll('[data-hapi-pending-row]')]
const row = (text: string) => within(screen.getByText(text).closest('[data-hapi-pending-row]')!)
const statusOf = (text: string) => row(text).getByTestId('user-send-status')

describe('PendingUserMessages', () => {
    beforeEach(() => {
        mocks.composerText = ''
        mocks.composerSetText.mockReset()
        mocks.addToast.mockReset()
        mocks.cancelMessage.mockReset()
        mocks.cancelMessage.mockResolvedValue({ status: 'cancelled', localId: 'local-1' })
        clearMessageWindow(sid)
        resetAbortedSends()
    })
    afterEach(() => {
        clearMessageWindow(sid)
        resetAbortedSends()
    })

    it('draws a message the agent does not have yet as the last row of the list, right-aligned like any bubble', () => {
        ingestIncomingMessages(sid, [serverRow()])
        mount()
        const rows = waitingRows()
        expect(rows).toHaveLength(1)
        const list = document.querySelector('.happy-thread-messages')!
        expect(list.lastElementChild).toBe(rows[0])
        expect(rows[0]).toHaveAttribute('data-hapi-message-role', 'user')
        expect(rows[0]!.querySelector('.happy-user-bubble')).toHaveTextContent('take this')
        expect(rows[0]!.querySelector('.happy-user-bubble')!.className).toContain('ml-auto')
    })

    it('says it is sending while the agent is free to take it, and waiting once the agent is busy', () => {
        ingestIncomingMessages(sid, [serverRow()])
        const view = mount()
        expect(statusOf('take this')).toHaveAttribute('data-phase', 'sending')
        expect(statusOf('take this')).toHaveTextContent('queuedMessages.sending')

        view.show({ agentBusy: true })
        expect(statusOf('take this')).toHaveAttribute('data-phase', 'waiting')
        expect(statusOf('take this')).toHaveTextContent('queuedMessages.waiting')
    })

    it('leaves out what is not on its way to the agent', () => {
        const later = Date.now() + 60 * 60_000
        ingestIncomingMessages(sid, [
            { ...serverRow('scheduled for later', 'local-later'), scheduledAt: later },
            { ...serverRow('dismissed', 'local-dismissed'), queueDismissed: true },
            { ...serverRow('already taken', 'local-taken'), invokedAt: 5 },
        ])
        markSendAborted(sid, 'local-cancelled')
        ingestIncomingMessages(sid, [serverRow('cancelled in flight', 'local-cancelled')])
        mount()
        expect(waitingRows()).toHaveLength(0)
        expect(screen.queryByText('scheduled for later')).toBeNull()
        expect(screen.queryByText('dismissed')).toBeNull()
        expect(screen.queryByText('already taken')).toBeNull()
        expect(screen.queryByText('cancelled in flight')).toBeNull()
    })

    it('stops drawing a message the moment the agent takes it', async () => {
        ingestIncomingMessages(sid, [serverRow()])
        mount()
        expect(waitingRows()).toHaveLength(1)
        act(() => { markMessagesConsumed(sid, ['local-1'], 9_000) })
        // The window tells its readers on its next tick.
        await waitFor(() => expect(waitingRows()).toHaveLength(0))
        expect(screen.queryByText('take this')).toBeNull()
        expect(getMessageWindowState(sid).messages.find((message) => message.localId === 'local-1')?.invokedAt).toBe(9_000)
    })

    it('draws a scheduled message once its time has come', async () => {
        ingestIncomingMessages(sid, [{ ...serverRow('due in a moment', 'local-due'), scheduledAt: Date.now() + 250 }])
        mount()
        expect(waitingRows()).toHaveLength(0)
        await waitFor(() => expect(waitingRows()).toHaveLength(1), { timeout: 3_000 })
        expect(screen.getByText('due in a moment')).toBeTruthy()
    })

    it('marks a message that arrives while nothing else is waiting: that is what the thread animates', () => {
        const view = mount()
        act(() => {
            appendOptimisticMessage(sid, userRow('local-new', 'local-new', 'just sent', { seq: null, createdAt: 2_000, status: 'sending', originalText: 'just sent' }))
        })
        expect(waitingRows()).toHaveLength(1)
        expect(waitingRows()[0]).toHaveAttribute('data-hapi-local-send', 'true')
        // The mark is the row's for as long as it is drawn, whatever makes it draw again: the thread
        // plays the entrance once per row (HappyThread).
        view.show({ agentBusy: true })
        expect(waitingRows()[0]).toHaveAttribute('data-hapi-local-send', 'true')
    })

    it('does not mark, and so does not animate, what was already waiting when the conversation opened', () => {
        ingestIncomingMessages(sid, [serverRow('was already waiting')])
        mount()
        expect(waitingRows()[0]).not.toHaveAttribute('data-hapi-local-send')
    })

    it('does not animate a row a second time when a refused cancel puts it back', async () => {
        mocks.cancelMessage.mockRejectedValue(new Error('offline'))
        mount()
        act(() => {
            appendOptimisticMessage(sid, userRow('local-new', 'local-new', 'just sent', { seq: null, createdAt: 2_000, status: 'sending', originalText: 'just sent' }))
        })
        expect(waitingRows()[0]).toHaveAttribute('data-hapi-local-send', 'true')
        // The hub's copy takes the place of this device's, and the request settles; then the user
        // cancels, and the hub cannot.
        act(() => { ingestIncomingMessages(sid, [userRow('server-2', 'local-new', 'just sent', { seq: 5 })]) })
        act(() => { updateMessageStatus(sid, 'local-new', 'queued') })
        await waitFor(() => expect(row('just sent').getByRole('button', { name: 'queuedMessages.cancel' })).toBeEnabled())
        fireEvent.click(row('just sent').getByRole('button', { name: 'queuedMessages.cancel' }))
        await waitFor(() => expect(waitingRows()).toHaveLength(0))
        await waitFor(() => expect(waitingRows()).toHaveLength(1))
        expect(waitingRows()[0]).not.toHaveAttribute('data-hapi-local-send')
    })

    it('keeps the first of several waiting messages: the ones behind it are the queue panel\'s, not the thread\'s', () => {
        ingestIncomingMessages(sid, [serverRow('first', 'local-a'), { ...serverRow('second', 'local-b'), createdAt: 2_000, seq: 4 }])
        mount({ agentBusy: true })
        expect(waitingRows()).toHaveLength(1)
        expect(waitingRows()[0]).toHaveTextContent('first')
        expect(screen.queryByText('second')).toBeNull()
    })

    it('keeps the first in the thread when the hub stamps it later than the second typed behind it', () => {
        const view = mount()
        act(() => {
            appendOptimisticMessage(sid, userRow('local-a', 'local-a', 'first', { seq: null, createdAt: 1_000, status: 'sending', originalText: 'first' }))
        })
        act(() => {
            appendOptimisticMessage(sid, userRow('local-b', 'local-b', 'second', { seq: null, createdAt: 2_000, status: 'sending', originalText: 'second' }))
        })
        expect(waitingRows()).toHaveLength(1)
        expect(waitingRows()[0]).toHaveTextContent('first')
        expect(screen.queryByText('second')).toBeNull()

        // The hub's copy of the first takes over from this device's. Its request was on its way
        // while the second was typed, so the hub's clock says it is the newer.
        act(() => { ingestIncomingMessages(sid, [userRow('server-a', 'local-a', 'first', { seq: 7, createdAt: 9_000 })]) })
        view.show({ agentBusy: true })
        expect(waitingRows()).toHaveLength(1)
        expect(waitingRows()[0]).toHaveTextContent('first')
        expect(screen.queryByText('second')).toBeNull()
    })

    it('hands the thread\'s place to the next one when the one before it is taken, and that is when it arrives', async () => {
        ingestIncomingMessages(sid, [serverRow('first', 'local-a'), { ...serverRow('second', 'local-b'), createdAt: 2_000, seq: 4 }])
        mount({ agentBusy: true })
        expect(waitingRows()[0]).not.toHaveAttribute('data-hapi-local-send')
        act(() => { markMessagesConsumed(sid, ['local-a'], 9_000) })
        await waitFor(() => expect(screen.queryByText('first')).toBeNull())
        expect(waitingRows()).toHaveLength(1)
        expect(waitingRows()[0]).toHaveTextContent('second')
        expect(waitingRows()[0]).toHaveAttribute('data-hapi-local-send', 'true')
        // Taken together, they leave together: nothing is handed on.
        act(() => { markMessagesConsumed(sid, ['local-b'], 9_500) })
        await waitFor(() => expect(waitingRows()).toHaveLength(0))
    })

    it('cancel asks the hub to drop it, and the row goes', async () => {
        ingestIncomingMessages(sid, [serverRow()])
        mount()
        fireEvent.click(row('take this').getByRole('button', { name: 'queuedMessages.cancel' }))
        await waitFor(() => expect(mocks.cancelMessage).toHaveBeenCalledWith(sid, 'server-1'))
        expect(waitingRows()).toHaveLength(0)
        // Not a silent success: the hub's answer is said out loud.
        await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'queuedMessages.cancelled', sessionId: sid })))
    })

    it('says so, and keeps the row, when the hub could not cancel it', async () => {
        mocks.cancelMessage.mockRejectedValue(new Error('offline'))
        ingestIncomingMessages(sid, [serverRow()])
        mount()
        fireEvent.click(row('take this').getByRole('button', { name: 'queuedMessages.cancel' }))
        await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'queuedMessages.cancelFailed', body: 'offline', sessionId: sid })))
        // useCancelQueuedMessage put it back, and its cancel is there for another try.
        await waitFor(() => expect(row('take this').getByRole('button', { name: 'queuedMessages.cancel' })).toBeEnabled())
    })

    it('asks the hub when the request settled in the breath between the tap and the stop', async () => {
        // Nothing is left to abort, and the hub has not echoed the row yet: it is asked by the local id.
        const onCancelSending = vi.fn((): false => false)
        appendOptimisticMessage(sid, userRow('local-1', 'local-1', 'just landed', { seq: null, status: 'sending', originalText: 'just landed' }))
        mount({ onCancelSending })
        fireEvent.click(row('just landed').getByRole('button', { name: 'queuedMessages.cancelSending' }))
        await waitFor(() => expect(mocks.cancelMessage).toHaveBeenCalledWith(sid, 'local-1'))
    })

    it('for a send that never left the device, says it is cancelled and asks nothing of the hub', () => {
        const onCancelSending = vi.fn((): 'dropped' => 'dropped')
        appendOptimisticMessage(sid, userRow('local-1', 'local-1', 'still queued here', { seq: null, status: 'sending', originalText: 'still queued here' }))
        mount({ onCancelSending })
        fireEvent.click(row('still queued here').getByRole('button', { name: 'queuedMessages.cancelSending' }))
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'queuedMessages.cancelled', sessionId: sid }))
        expect(mocks.cancelMessage).not.toHaveBeenCalled()
    })

    it('says so when the agent took the message before the cancel arrived', async () => {
        mocks.cancelMessage.mockResolvedValue({
            status: 'invoked',
            message: { id: 'server-1', seq: null, localId: 'local-1', content: {}, createdAt: 1_000, invokedAt: 9_500 },
        })
        ingestIncomingMessages(sid, [serverRow()])
        mount()
        fireEvent.click(row('take this').getByRole('button', { name: 'queuedMessages.cancel' }))
        await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'queuedMessages.cancelTooLate', sessionId: sid })))
        // It was sent after all: it reads as a sent message, which the thread itself draws.
        expect(waitingRows()).toHaveLength(0)
    })

    it('stops on the device a send whose request is still on the wire', () => {
        const onCancelSending = vi.fn((): 'aborted' => 'aborted')
        appendOptimisticMessage(sid, userRow('local-1', 'local-1', 'stop this one', { seq: null, status: 'sending', originalText: 'stop this one' }))
        mount({ onCancelSending })
        expect(statusOf('stop this one')).toHaveTextContent('queuedMessages.sending')
        fireEvent.click(row('stop this one').getByRole('button', { name: 'queuedMessages.cancelSending' }))
        expect(onCancelSending).toHaveBeenCalledWith('local-1')
        // Nothing is on the hub yet, so nothing is asked of it. Whether some of it arrived is
        // useAbortedSendReconciler's to settle and report, so nothing is said here.
        expect(mocks.cancelMessage).not.toHaveBeenCalled()
        expect(mocks.addToast).not.toHaveBeenCalled()
    })

    it('takes the text back and stops a send that is on the wire', () => {
        const onCancelSending = vi.fn((): 'aborted' => 'aborted')
        const onEdit = vi.fn()
        appendOptimisticMessage(sid, userRow('local-1', 'local-1', 'said too soon', { seq: null, status: 'sending', originalText: 'said too soon' }))
        mount({ onCancelSending, onEdit })
        fireEvent.click(row('said too soon').getByRole('button', { name: 'queuedMessages.edit' }))
        expect(onCancelSending).toHaveBeenCalledWith('local-1')
        expect(mocks.composerSetText).toHaveBeenCalledWith('said too soon')
        expect(onEdit).toHaveBeenCalledWith({ text: 'said too soon', pendingSchedule: null })
        expect(mocks.cancelMessage).not.toHaveBeenCalled()
    })

    it('cancels on the hub a send whose request is still out but that the hub already has', async () => {
        const onCancelSending = vi.fn((): 'aborted' => 'aborted')
        ingestIncomingMessages(sid, [{ ...serverRow(), status: 'sending' }])
        mount({ onCancelSending })
        fireEvent.click(row('take this').getByRole('button', { name: 'queuedMessages.cancelSending' }))
        await waitFor(() => expect(mocks.cancelMessage).toHaveBeenCalledWith(sid, 'server-1'))
        expect(onCancelSending).not.toHaveBeenCalled()
    })

    it('takes the text back into the composer to edit it, once the hub has dropped the message', async () => {
        const onEdit = vi.fn()
        ingestIncomingMessages(sid, [serverRow('said too soon')])
        mount({ onEdit })
        fireEvent.click(row('said too soon').getByRole('button', { name: 'queuedMessages.edit' }))
        await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('said too soon'))
        expect(mocks.cancelMessage).toHaveBeenCalledWith(sid, 'server-1')
        expect(onEdit).toHaveBeenCalledWith({ text: 'said too soon', pendingSchedule: null })
        expect(waitingRows()).toHaveLength(0)
    })

    it('labels a prompt a task sent and offers only to skip it', () => {
        ingestIncomingMessages(sid, [serverRow('the task\'s prompt', 'hapi-task:task-1:2')])
        mount({ agentBusy: true })
        expect(screen.getByText('queuedMessages.fromTask')).toBeTruthy()
        expect(row("the task's prompt").getByRole('button', { name: 'queuedMessages.skipTaskPrompt' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'queuedMessages.edit' })).toBeNull()
    })

    it('shows the attachments of a message on its way', () => {
        ingestIncomingMessages(sid, [{
            ...serverRow('look at this'),
            content: {
                role: 'user',
                content: {
                    type: 'text', text: 'look at this',
                    attachments: [{ id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 10, path: '/tmp/shot.png' }],
                },
            },
        }])
        mount()
        expect(screen.getByTestId('attachments')).toHaveTextContent('shot.png')
    })
})

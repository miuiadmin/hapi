import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { appendOptimisticMessage, clearMessageWindow, getMessageWindowState } from '@/lib/message-window-store'
import { isSendAborted, resetAbortedSends } from '@/lib/abortedSends'
import { noteSendFailure, resetSendFailures } from '@/lib/sendFailures'
import { QueuedMessageActionsProvider } from '@/components/AssistantChat/queuedMessageActions'
import { HappyUserMessage } from './UserMessage'

const mocks = vi.hoisted(() => ({
    composerText: '',
    composerSetText: vi.fn(),
    addToast: vi.fn(),
    cancelMessage: vi.fn(),
    onRetryMessage: vi.fn(),
    invokedAt: null as number | null,
}))
const sid = 'failed-session'
const localId = 'local-failed'
const api = { cancelMessage: mocks.cancelMessage } as unknown as ApiClient

const state = {
    message: {
        id: 'server-failed', role: 'user', createdAt: new Date(10),
        content: [{ type: 'text', text: 'did not get through' }],
        metadata: { custom: { kind: 'user', status: 'failed' as const, localId, sourceMessageId: 'server-failed', invokedAt: null as number | null } },
    },
    thread: { isRunning: false, messages: [] },
}
const ctx = {
    sessionId: sid,
    metadata: { flavor: 'claude' },
    disabled: false,
    onRetryMessage: mocks.onRetryMessage,
}

vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (value: typeof state) => unknown) => selector(state),
    useAui: () => ({ composer: () => ({ getState: () => ({ text: mocks.composerText }), setText: mocks.composerSetText }) }),
    MessagePrimitive: { Root: ({ children, ...props }: PropsWithChildren) => <div {...props}>{children}</div> },
}))
vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ctx,
    useOptionalHappyChatContext: () => ctx,
}))
vi.mock('./MessageAttachments', () => ({ MessageAttachments: () => null }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/toast-context', () => ({ useToast: () => ({ addToast: mocks.addToast }) }))
vi.mock('./user-bubble', () => ({
    UserBubbleContent: ({ text }: { text: string }) => <span>{text}</span>,
    FromTaskChip: ({ label }: { label: string }) => <span>{label}</span>,
    getUserBubbleClassName: () => 'happy-user-bubble',
    shouldShowMessageStatus: (status?: string) => status === 'failed',
}))
vi.mock('@/components/AssistantChat/messages/MessageActions', () => ({
    MessageActions: () => null,
    isConversationHistoryBlocked: () => false,
}))

function failedRow(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: 'server-failed', seq: 5, localId, createdAt: 1_000, invokedAt: null, scheduledAt: null, status: 'failed', originalText: 'did not get through',
        content: { role: 'user', content: { type: 'text', text: 'did not get through' } },
        ...overrides,
    } as DecryptedMessage
}
function mount() {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
            <I18nProvider>
                <QueuedMessageActionsProvider api={api} sessionId={sid} pendingSchedule={null} pendingScheduleRevision={0}>
                    <HappyUserMessage />
                </QueuedMessageActionsProvider>
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('a send that failed, in the thread', () => {
    beforeEach(() => {
        mocks.composerText = ''
        mocks.composerSetText.mockReset()
        mocks.addToast.mockReset()
        mocks.cancelMessage.mockReset()
        mocks.cancelMessage.mockResolvedValue({ status: 'cancelled', localId })
        mocks.onRetryMessage.mockReset()
        mocks.invokedAt = null
        state.message.metadata.custom.invokedAt = null
        resetSendFailures()
        resetAbortedSends()
        clearMessageWindow(sid)
        noteSendFailure(sid, localId, 'HTTP 502 Bad Gateway')
        // The device's own copy: the request failed, so the hub never echoed it.
        appendOptimisticMessage(sid, failedRow({ id: localId, seq: null }))
    })
    afterEach(() => {
        clearMessageWindow(sid)
        resetAbortedSends()
        resetSendFailures()
    })

    it('says it was not sent, and why, and offers to retry from the row', () => {
        mount()
        const status = screen.getByTestId('user-send-status')
        expect(status).toHaveAttribute('data-phase', 'failed')
        expect(status).toHaveTextContent('queuedMessages.failed')
        expect(status).toHaveTextContent('HTTP 502 Bad Gateway')

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.retry' }))
        expect(mocks.onRetryMessage).toHaveBeenCalledWith(localId)
    })

    it('is retried with its text intact and nothing else', () => {
        mount()
        expect(screen.getByText('did not get through')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'queuedMessages.cancel' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'queuedMessages.steer' })).toBeNull()
    })

    it('drops it on request without asking a hub that never had it, but remembers it should a late echo show up', () => {
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.dismissFailed' }))
        expect(getMessageWindowState(sid).messages.some((message) => message.localId === localId)).toBe(false)
        expect(mocks.cancelMessage).not.toHaveBeenCalled()
        // The request may have failed after the hub committed it after all.
        expect(isSendAborted(sid, localId)).toBe(true)
    })

    it('drops one the hub did echo by cancelling it there', async () => {
        clearMessageWindow(sid)
        appendOptimisticMessage(sid, failedRow())
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.dismissFailed' }))
        await waitFor(() => expect(mocks.cancelMessage).toHaveBeenCalledWith(sid, 'server-failed'))
    })

    it('hands the text back to an empty composer to be edited, and leaves the message in place when a draft is already there', async () => {
        mocks.composerText = 'a newer draft'
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'queuedMessages.editDraftKept' })))
        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(getMessageWindowState(sid).messages.some((message) => message.localId === localId)).toBe(true)

        mocks.composerText = ''
        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('did not get through'))
        expect(getMessageWindowState(sid).messages.some((message) => message.localId === localId)).toBe(false)
    })

    it('is only a sent message once the agent took it before the device heard the request failed', () => {
        state.message.metadata.custom.invokedAt = 9_000
        mount()
        expect(screen.queryByTestId('user-send-status')).toBeNull()
        expect(screen.queryByRole('button', { name: 'queuedMessages.retry' })).toBeNull()
        expect(screen.getByText('did not get through')).toBeTruthy()
    })
})

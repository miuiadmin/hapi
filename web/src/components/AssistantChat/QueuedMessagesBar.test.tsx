import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import {
    computeCanCancel,
    computeEditPendingSchedule,
    getQueuedMessageEditText,
    getQueuedMessagePreview,
    QueuedMessagesBar,
    sortQueuedMessages,
} from './QueuedMessagesBar'
import { formatScheduledTime } from '@/lib/scheduledTime'
import { clearQueuedEditRecovery, getQueuedEditRecovery } from '@/lib/queued-edit-recovery'
import { QueuedMessageActionsProvider } from './queuedMessageActions'
import { PendingUserMessages } from './PendingUserMessages'

type DeferredCancelResult = { status: 'cancelled' | 'invoked' | 'busy'; localId?: string }

const mocks = vi.hoisted(() => ({
    composerText: '',
    composerSetText: vi.fn(),
    addToast: vi.fn(),
    mutateAsync: vi.fn(),
    resolveCancel: null as ((result: DeferredCancelResult) => void) | null,
    rejectCancel: null as ((reason?: unknown) => void) | null,
    steerMessage: vi.fn(),
    resolveSteer: null as ((result: unknown) => void) | null,
    markMessagesConsumed: vi.fn(),
    saveDraft: vi.fn(),
    messageWindowState: { messages: [] as unknown[] },
}))

vi.mock('@assistant-ui/react', () => ({
    useAui: () => ({
        composer: () => ({
            getState: () => ({ text: mocks.composerText }),
            setText: mocks.composerSetText,
        }),
    }),
    useAuiState: (selector: (state: { composer: { text: string } }) => unknown) => selector({
        composer: { text: mocks.composerText },
    }),
}))

vi.mock('@/lib/message-window-store', () => ({
    getMessageWindowState: () => mocks.messageWindowState,
    subscribeMessageWindow: () => () => {},
    markMessagesConsumed: mocks.markMessagesConsumed,
    markMessagesDispatching: (_sessionId: string, ids: string[]) => {
        mocks.messageWindowState = { messages: mocks.messageWindowState.messages.map(item => {
            const message = item as DecryptedMessage
            return message.localId && ids.includes(message.localId)
                ? { ...message, deliveryState: 'indeterminate', deliveryPending: true }
                : message
        }) }
    },
    markMessagesIndeterminate: vi.fn(),
    markMessagesRequeued: vi.fn(),
    reconcileQueuedLocalIds: vi.fn(),
}))

vi.mock('@/hooks/mutations/useCancelQueuedMessage', () => ({
    useCancelQueuedMessage: () => ({
        isPending: false,
        variables: undefined,
        mutateAsync: mocks.mutateAsync,
    }),
}))

vi.mock('@/lib/composer-drafts', () => ({
    saveDraft: mocks.saveDraft,
}))
vi.mock('./messages/MessageAttachments', () => ({ MessageAttachments: () => null }))
vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text }: { text: string }) => <span>{text}</span>,
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({ addToast: mocks.addToast }),
}))

function makeQueuedMessage(
    scheduledAt: number | null = null,
    id = 'server-message-id',
    overrides: Partial<DecryptedMessage> = {},
): DecryptedMessage {
    return {
        id,
        localId: `local-${id}`,
        createdAt: 1000,
        seq: 1,
        scheduledAt,
        invokedAt: null,
        status: 'queued',
        content: {
            role: 'user',
            content: { type: 'text', text: 'Queued request' },
        },
        ...overrides,
    } as unknown as DecryptedMessage
}

type RowOptions = {
    api?: ApiClient | null
    onEdit?: (params: { text: string; pendingSchedule: PendingSchedule | null }) => void
    pendingSchedule?: PendingSchedule | null
    pendingScheduleRevision?: number
    canSteer?: boolean
    deliveryActive?: boolean
    sharedNative?: boolean
    compactionPendingMessageIds?: string[] | undefined
    onCancelSending?: (localId: string) => 'dropped' | 'aborted' | false
    agentBusy?: boolean
}

/** Both places a queued row can live, sharing the actions the session gives them: the thread, for
 *  the one message on its way to the agent now, and the queue panel above the composer, for the
 *  messages typed behind it and the ones due later. */
function Rows(props: RowOptions) {
    return (
        <QueuedMessageActionsProvider
            api={props.api ?? null}
            sessionId="session-1"
            pendingSchedule={props.pendingSchedule ?? null}
            pendingScheduleRevision={props.pendingScheduleRevision ?? 0}
            onEdit={props.onEdit}
            canSteer={props.canSteer}
            deliveryActive={props.deliveryActive}
            sharedNative={props.sharedNative}
            compactionPendingMessageIds={props.compactionPendingMessageIds}
            onCancelSending={props.onCancelSending}
        >
            <QueuedMessagesBar sessionId="session-1" api={props.api ?? null} />
            <PendingUserMessages sessionId="session-1" agentBusy={props.agentBusy ?? false} />
        </QueuedMessageActionsProvider>
    )
}

function renderQueuedMessage(
    scheduledAt: number | null = null,
    pendingSchedule: PendingSchedule | null = null,
    pendingScheduleRevision = 0,
    canSteer = false,
    api: ApiClient | null = null,
    delivery: Partial<DecryptedMessage> = {},
    deliveryActive = canSteer,
    sharedNative = false,
    extra: Pick<RowOptions, 'onCancelSending' | 'agentBusy'> = {},
) {
    const onEdit = vi.fn()
    let currentPendingScheduleRevision = pendingScheduleRevision
    mocks.messageWindowState = { messages: [makeQueuedMessage(scheduledAt, 'server-message-id', delivery)] }
    // The real useSteerQueuedMessage hook runs inside the rows, so every render
    // needs a QueryClient (its mutations use the tanstack defaults).
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
    })
    const view = render(
        <QueryClientProvider client={queryClient}>
            <Rows
                api={api}
                pendingSchedule={pendingSchedule}
                pendingScheduleRevision={currentPendingScheduleRevision}
                onEdit={onEdit}
                canSteer={canSteer}
                deliveryActive={deliveryActive}
                sharedNative={sharedNative}
                onCancelSending={extra.onCancelSending}
                agentBusy={extra.agentBusy}
            />
        </QueryClientProvider>
    )
    return {
        onEdit,
        unmount: view.unmount,
        rerender: (nextPendingSchedule: PendingSchedule | null, nextPendingScheduleRevision = currentPendingScheduleRevision) => {
            currentPendingScheduleRevision = nextPendingScheduleRevision
            view.rerender(
                <QueryClientProvider client={queryClient}>
                    <Rows
                        api={api}
                        pendingSchedule={nextPendingSchedule}
                        pendingScheduleRevision={currentPendingScheduleRevision}
                        onEdit={onEdit}
                        canSteer={canSteer}
                        deliveryActive={deliveryActive}
                    />
                </QueryClientProvider>
            )
        },
    }
}

beforeEach(() => {
    mocks.composerText = ''
    mocks.composerSetText.mockReset()
    mocks.addToast.mockReset()
    mocks.mutateAsync.mockReset()
    mocks.resolveCancel = null
    mocks.rejectCancel = null
    mocks.steerMessage.mockReset()
    mocks.resolveSteer = null
    mocks.markMessagesConsumed.mockReset()
    mocks.saveDraft.mockReset()
    mocks.messageWindowState = { messages: [] }
    clearQueuedEditRecovery('session-1')
    mocks.mutateAsync.mockImplementation(() => new Promise<DeferredCancelResult>((resolve, reject) => {
        mocks.resolveCancel = resolve
        mocks.rejectCancel = reject
    }))
})

async function resolveCancel(result: DeferredCancelResult): Promise<void> {
    await act(async () => {
        mocks.resolveCancel?.(result)
        await Promise.resolve()
    })
}

function installManualAnimationFrames() {
    let nextHandle = 1
    const pending = new Map<number, FrameRequestCallback>()
    const history = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const handle = nextHandle++
        pending.set(handle, callback)
        history.set(handle, callback)
        return handle
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
        pending.delete(handle)
    })

    return {
        flushPending() {
            while (pending.size > 0) {
                const [handle, callback] = pending.entries().next().value as [number, FrameRequestCallback]
                pending.delete(handle)
                callback(Date.now())
            }
        },
        flushHistory() {
            for (const callback of history.values()) {
                callback(Date.now())
            }
        },
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('a waiting row during compaction', () => {
    it('shows waiting only for the observed message, then restores recovery controls when compaction ends', () => {
        mocks.messageWindowState = { messages: [
            makeQueuedMessage(null, 'compacting', { deliveryState: 'indeterminate' }),
            makeQueuedMessage(null, 'older', { deliveryState: 'indeterminate' }),
        ] }
        const client = new QueryClient()
        const rows = (ids?: string[]) => (
            <QueryClientProvider client={client}>
                <Rows api={null} compactionPendingMessageIds={ids} />
            </QueryClientProvider>
        )
        const view = render(rows(['local-compacting']))
        expect(screen.getAllByText('queuedMessages.compactionPending')).toHaveLength(1)
        expect(screen.getAllByText('queuedMessages.steerOutcomeUnknown')).toHaveLength(1)
        expect(screen.getAllByRole('button', { name: 'queuedMessages.retryOutcome' })).toHaveLength(1)
        view.rerender(rows())
        expect(screen.queryByText('queuedMessages.compactionPending')).toBeNull()
        expect(screen.getAllByText('queuedMessages.steerOutcomeUnknown')).toHaveLength(2)
        expect(screen.getAllByRole('button', { name: 'queuedMessages.retryOutcome' })).toHaveLength(2)
    })

    it('does not change a waiting message into an uncertain or consumed message', () => {
        mocks.messageWindowState = { messages: [makeQueuedMessage(null, 'queued')] }
        render(<QueryClientProvider client={new QueryClient()}>
            <Rows api={null} compactionPendingMessageIds={['local-queued']} />
        </QueryClientProvider>)
        expect(screen.queryByText('queuedMessages.compactionPending')).toBeNull()
        expect(screen.queryByText('queuedMessages.steerOutcomeUnknown')).toBeNull()
        expect(mocks.markMessagesConsumed).not.toHaveBeenCalled()
    })
})

describe('the queue panel', () => {
    const text = (words: string) => ({ role: 'user', content: { type: 'text', text: words } })
    const sent = (id: string, createdAt: number, words: string, overrides: Partial<DecryptedMessage> = {}) =>
        makeQueuedMessage(null, id, { createdAt, seq: createdAt, content: text(words), ...overrides })
    const panelRows = () => [...document.querySelectorAll('[data-testid="queued-panel-row"]')]
    const panelRow = (words: string) => within(screen.getByText(words).closest('[data-testid="queued-panel-row"]')!)
    const threadRows = () => [...document.querySelectorAll('[data-hapi-pending-row]')]

    function renderPanel(messages: DecryptedMessage[], options: RowOptions = {}) {
        mocks.messageWindowState = { messages }
        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
                <Rows api={options.api ?? null} canSteer={options.canSteer} deliveryActive={options.canSteer} onEdit={options.onEdit} onCancelSending={options.onCancelSending} agentBusy />
            </QueryClientProvider>
        )
    }

    it('is not there while nothing waits behind the message in the thread', () => {
        renderPanel([sent('server-a', 1_000, 'first')])
        expect(threadRows()).toHaveLength(1)
        expect(screen.queryByRole('status')).toBeNull()
    })

    it('lists what was typed behind the thread\'s message, in the order sent, and then what is scheduled for later', () => {
        const later = Date.now() + 60 * 60_000
        renderPanel([
            sent('server-c', 3_000, 'third'),
            sent('server-a', 1_000, 'first'),
            sent('server-b', 2_000, 'second'),
            makeQueuedMessage(later, 'server-later', { createdAt: 500, content: text('later'), localId: 'local-server-later' }),
        ])
        expect(threadRows()).toHaveLength(1)
        expect(threadRows()[0]).toHaveTextContent('first')
        expect(screen.getByRole('status', { name: 'queuedMessages.heading (3)' })).toHaveTextContent('queuedMessages.heading')
        expect(panelRows().map((row) => row.textContent)).toEqual([
            expect.stringContaining('second'),
            expect.stringContaining('third'),
            expect.stringContaining('later'),
        ])
        expect(panelRow('later').getByText('queuedMessages.scheduledFor')).toBeTruthy()
    })

    it('gives each waiting message its own edit and cancel, and asks the hub about that one alone', async () => {
        renderPanel([sent('server-a', 1_000, 'first'), sent('server-b', 2_000, 'second'), sent('server-c', 3_000, 'third')])
        fireEvent.click(panelRow('second').getByRole('button', { name: 'queuedMessages.cancel' }))
        await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1))
        expect(mocks.mutateAsync.mock.calls[0][0]).toEqual(expect.objectContaining({
            sessionId: 'session-1', messageId: 'server-b', localId: 'local-server-b',
        }))
        await resolveCancel({ status: 'cancelled', localId: 'local-server-b' })
        await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'queuedMessages.cancelled' })))
    })

    it('edits a message the hub holds by cancelling it there first', async () => {
        const onEdit = vi.fn()
        renderPanel([sent('server-a', 1_000, 'first'), sent('server-b', 2_000, 'second')], { onEdit })
        fireEvent.click(panelRow('second').getByRole('button', { name: 'queuedMessages.edit' }))
        expect(mocks.composerSetText).not.toHaveBeenCalled()
        await resolveCancel({ status: 'cancelled', localId: 'local-server-b' })
        expect(mocks.composerSetText).toHaveBeenCalledWith('second')
        expect(onEdit).toHaveBeenCalledWith({ text: 'second', pendingSchedule: null })
    })

    it('stops, on this device, a message that has not left it: the hub is asked nothing', () => {
        const onCancelSending = vi.fn((): 'dropped' => 'dropped')
        // Typed while the first was still on its way: its request has not gone out, so the hub has no row.
        renderPanel([sent('server-a', 1_000, 'first'), sent('local-b', 2_000, 'second', { localId: 'local-b', seq: null, status: 'sending' })], { onCancelSending })
        fireEvent.click(panelRow('second').getByRole('button', { name: 'queuedMessages.cancelSending' }))
        expect(onCancelSending).toHaveBeenCalledWith('local-b')
        expect(mocks.mutateAsync).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'queuedMessages.cancelled', sessionId: 'session-1' }))
    })

    it('hands back the text of a message that has not left this device', () => {
        const onCancelSending = vi.fn((): 'dropped' => 'dropped')
        const onEdit = vi.fn()
        renderPanel([sent('server-a', 1_000, 'first'), sent('local-b', 2_000, 'second', { localId: 'local-b', seq: null, status: 'sending' })], { onCancelSending, onEdit })
        fireEvent.click(panelRow('second').getByRole('button', { name: 'queuedMessages.edit' }))
        expect(onCancelSending).toHaveBeenCalledWith('local-b')
        expect(mocks.composerSetText).toHaveBeenCalledWith('second')
        expect(mocks.mutateAsync).not.toHaveBeenCalled()
    })

    it('can steer a waiting message the hub holds into the turn the agent is on', async () => {
        mocks.steerMessage.mockImplementation(() => new Promise((resolve) => { mocks.resolveSteer = resolve }))
        renderPanel([sent('server-a', 1_000, 'first'), sent('server-b', 2_000, 'second')], { canSteer: true, api: { steerMessage: mocks.steerMessage } as unknown as ApiClient })
        fireEvent.click(panelRow('second').getByRole('button', { name: 'queuedMessages.steer' }))
        await waitFor(() => expect(mocks.steerMessage).toHaveBeenCalledWith('session-1', 'server-b'))
        // While that request is out, the row offers nothing that would compete with it.
        expect(panelRow('second').getByRole('button', { name: 'queuedMessages.cancel' })).toBeDisabled()
        await act(async () => {
            mocks.resolveSteer?.({ status: 'failed', error: 'No active turn', localId: 'local-server-b' })
            await Promise.resolve()
        })
    })
})

describe('QueuedMessagesBar layout', () => {
    it('keeps the list of scheduled messages flush with the composer area', () => {
        renderQueuedMessage(Date.now() + 60_000)

        const bar = screen.getByRole('status', { name: 'queuedMessages.heading (1)' })
        const content = bar.firstElementChild

        expect(bar).not.toHaveClass('mb-1')
        expect(content).toHaveClass('pt-2', 'pb-0')
        expect(content).not.toHaveClass('py-2')
    })
})

describe('QueuedMessagesBar edit restore', () => {
    it('keeps a newly typed draft and its schedule when the deferred cancel succeeds', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        expect(mocks.resolveCancel).not.toBeNull()

        // The user starts a new draft while DELETE /messages/:id is still pending.
        mocks.composerText = 'New draft typed while cancelling'
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editCurrentDraftKept',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('keeps a newly selected schedule when the composer text is unchanged', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit, rerender } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        // The user changes only the clock selection while DELETE /messages/:id is pending.
        rerender({ type: 'preset', preset: '+30m' }, 1)
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editCurrentDraftKept',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('keeps the current state after selecting and then clearing a schedule', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit, rerender } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        rerender({ type: 'preset', preset: '+30m' }, 1)
        rerender(null, 2)
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editCurrentDraftKept',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('restores both text and schedule when the composer is unchanged', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request')
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
        expect(mocks.addToast).not.toHaveBeenCalled()
    })

    it('treats structurally equal schedule props as unchanged', async () => {
        const scheduledAt = Date.now() + 60_000
        const { onEdit, rerender } = renderQueuedMessage(scheduledAt, { type: 'preset', preset: '+5m' })

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        rerender({ type: 'preset', preset: '+5m' })
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request')
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
    })

    it('globally disables queued operations and keeps the first edit completion', async () => {
        const scheduledAt = Date.now() + 60_000
        // One message sent now (it waits in the thread) and one scheduled for later (it waits in the list).
        const sentNow = makeQueuedMessage(null, 'server-message-a')
        const scheduled = makeQueuedMessage(scheduledAt, 'server-message-b')
        mocks.messageWindowState = { messages: [sentNow, scheduled] }
        const onEdit = vi.fn()
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false } },
        })
        render(
            <QueryClientProvider client={queryClient}>
                <Rows api={null} onEdit={onEdit} />
            </QueryClientProvider>
        )

        // The scheduled list is drawn first.
        const editButtons = screen.getAllByRole('button', { name: 'queuedMessages.edit' })
        const cancelButtons = screen.getAllByRole('button', { name: 'queuedMessages.cancel' })
        fireEvent.click(editButtons[0]!)

        await waitFor(() => {
            for (const button of [...screen.getAllByRole('button', { name: 'queuedMessages.edit' }), ...screen.getAllByRole('button', { name: 'queuedMessages.cancel' })]) {
                expect(button).toBeDisabled()
            }
        })
        fireEvent.click(cancelButtons[0]!)
        fireEvent.click(editButtons[0]!)
        expect(mocks.mutateAsync).toHaveBeenCalledTimes(1)

        await resolveCancel({ status: 'cancelled' })
        expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request')
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
    })

    it('persists an unmounted edit result and restores it after the same session remounts', async () => {
        const scheduledAt = Date.now() + 60_000
        const { unmount } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        unmount()
        await resolveCancel({ status: 'cancelled' })

        expect(mocks.saveDraft).not.toHaveBeenCalled()
        expect(getQueuedEditRecovery('session-1')).toEqual(expect.objectContaining({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
            composerTextAtEdit: '',
            pendingScheduleAtEdit: null,
        }))

        const { onEdit } = renderQueuedMessage(scheduledAt)
        await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request'))
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
        expect(getQueuedEditRecovery('session-1')).toBeNull()
    })

    it('notifies a same-session remount that returns before the edit cancellation completes', async () => {
        const scheduledAt = Date.now() + 60_000
        const { unmount } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        unmount()
        const { onEdit } = renderQueuedMessage(scheduledAt)

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'queuedMessages.edit' })).toBeDisabled()
            expect(screen.getByRole('button', { name: 'queuedMessages.cancel' })).toBeDisabled()
        })
        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.cancel' }))
        expect(mocks.mutateAsync).toHaveBeenCalledTimes(1)

        await resolveCancel({ status: 'cancelled' })

        await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request'))
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
        expect(getQueuedEditRecovery('session-1')).toBeNull()
    })

    it('keeps a remounted session busy until its queued-edit recovery is consumed', async () => {
        const raf = installManualAnimationFrames()
        const scheduledAt = Date.now() + 60_000
        const { unmount } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        unmount()
        const { onEdit } = renderQueuedMessage(scheduledAt)
        await resolveCancel({ status: 'cancelled' })

        // The mutation token has ended, but the unconsumed recovery keeps Q2 busy.
        expect(screen.getByRole('button', { name: 'queuedMessages.edit' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.cancel' }))
        expect(mocks.mutateAsync).toHaveBeenCalledTimes(1)

        raf.flushPending()
        await waitFor(() => expect(screen.getByRole('button', { name: 'queuedMessages.edit' })).not.toBeDisabled())
        expect(onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
    })

    it('ignores overlapping and disposed recovery animation callbacks, then allows a fresh remount to consume', async () => {
        const raf = installManualAnimationFrames()
        const scheduledAt = Date.now() + 60_000
        const first = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        first.unmount()
        const second = renderQueuedMessage(scheduledAt)
        await resolveCancel({ status: 'cancelled' })
        second.unmount()

        raf.flushHistory()
        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(second.onEdit).not.toHaveBeenCalled()
        expect(getQueuedEditRecovery('session-1')).not.toBeNull()

        const third = renderQueuedMessage(scheduledAt)
        raf.flushPending()
        await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request'))
        expect(third.onEdit).toHaveBeenCalledWith({
            text: 'Queued request',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
        expect(getQueuedEditRecovery('session-1')).toBeNull()
    })

    it('clears a conflicting recovery once and never restores it after a later composer clear', async () => {
        const scheduledAt = Date.now() + 60_000
        const { unmount } = renderQueuedMessage(scheduledAt)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        unmount()
        await resolveCancel({ status: 'cancelled' })
        mocks.composerText = 'Current draft wins'

        const { onEdit, rerender } = renderQueuedMessage(scheduledAt)
        await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editCurrentDraftKept',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        }))
        expect(getQueuedEditRecovery('session-1')).toBeNull()

        mocks.composerText = ''
        rerender(null, 0)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
    })

    it('keeps the already-invoked toast behavior', async () => {
        const { onEdit } = renderQueuedMessage()

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        await resolveCancel({ status: 'invoked' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editAlreadyInvoked',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('does not prefill when a normal cancel returns busy (steer still may deliver)', async () => {
        const { onEdit } = renderQueuedMessage()

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        await resolveCancel({ status: 'busy', localId: 'local-server-message-id' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).not.toHaveBeenCalled()
    })

    it('does not prefill when editing an indeterminate row whose cancel returns busy', async () => {
        // Hub may still be mid-dispatch (serialized as indeterminate). Prefilling
        // would invite a duplicate send if the original later lands.
        const { onEdit } = renderQueuedMessage(null, null, 0, false, null, { deliveryState: 'indeterminate' })

        expect(screen.getByText('queuedMessages.steerOutcomeUnknown')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        await resolveCancel({ status: 'busy', localId: 'local-server-message-id' })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.editBusyNotRestored',
            body: '',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('does not restore an edit when cancel fails', async () => {
        const { onEdit } = renderQueuedMessage(Date.now() + 60_000)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.edit' }))
        await act(async () => {
            mocks.rejectCancel?.(new Error('network failed'))
            await Promise.resolve()
        })

        expect(mocks.composerSetText).not.toHaveBeenCalled()
        expect(onEdit).not.toHaveBeenCalled()
    })
})

/**
 * Unit tests for computeCanCancel — the race guard that prevents sending
 * DELETE before the hub has a row to delete (pre-server-echo scenario).
 *
 * Key invariant: useSendMessage.onMutate creates an optimistic message with
 *   { id: localId, localId }
 * so id === localId until the server echo (message-received SSE) arrives and
 * message-window-store replaces the row with the server-assigned UUID id.
 * After that replace, id !== localId.
 *
 * canCancel = hasServerEcho && !isPending
 */
describe('computeCanCancel', () => {
    describe('hasServerEcho detection', () => {
        it('is false when id === localId (purely optimistic, no server echo)', () => {
            // useSendMessage.onMutate sets id = localId before POST /messages completes.
            const localId = 'local-abc-123'
            expect(computeCanCancel({ id: localId, localId, isPending: false })).toBe(false)
        })

        it('is true when id !== localId (server echo replaced id with server UUID)', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
        })

        it('is true when localId is undefined/null (server-only row, no local tracking)', () => {
            // Rows from server-loaded history have no localId — treat as already echoed.
            expect(computeCanCancel({ id: 'server-uuid-789', localId: undefined, isPending: false })).toBe(true)
            expect(computeCanCancel({ id: 'server-uuid-789', localId: null, isPending: false })).toBe(true)
        })
    })

    describe('isPending guard', () => {
        it('is false when a cancel mutation is already in-flight, even with server echo', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            expect(computeCanCancel({ id: serverId, localId, isPending: true })).toBe(false)
        })

        it('is false when purely optimistic AND isPending', () => {
            const localId = 'local-abc-123'
            expect(computeCanCancel({ id: localId, localId, isPending: true })).toBe(false)
        })
    })

    describe('combined conditions', () => {
        it('is true only when server echo received AND no in-flight cancel', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            // The normal case: user can click ✕ or ✎
            expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
        })
    })
})

// ---------------------------------------------------------------------------
// #4 computeEditPendingSchedule — edit restores scheduledAt as absolute pending
// ---------------------------------------------------------------------------

describe('computeEditPendingSchedule', () => {
    it('returns null for immediate-queued message (no scheduledAt)', () => {
        const now = Date.now()
        expect(computeEditPendingSchedule(null, now)).toBeNull()
        expect(computeEditPendingSchedule(undefined, now)).toBeNull()
    })

    it('returns null for scheduledAt in the past (message matured)', () => {
        const now = Date.now()
        const past = now - 5000 // 5 seconds ago
        expect(computeEditPendingSchedule(past, now)).toBeNull()
    })

    it('returns absolute PendingSchedule for future scheduledAt', () => {
        const now = Date.now()
        const future = now + 60_000 // 1 minute from now
        const result = computeEditPendingSchedule(future, now)
        expect(result).not.toBeNull()
        expect(result?.type).toBe('absolute')
        if (result?.type === 'absolute') {
            expect(result.ms).toBe(future)
        }
    })
})

describe('sortQueuedMessages', () => {
    const make = (id: string, createdAt: number, scheduledAt: number | null = null): DecryptedMessage => ({
        id,
        localId: id,
        createdAt,
        seq: createdAt,
        scheduledAt,
        invokedAt: null,
        content: { role: 'user', content: { type: 'text', text: id } },
    } as unknown as DecryptedMessage)

    it('places immediate-queued messages before scheduled ones', () => {
        const a = make('a-immediate', 1000)
        const b = make('b-scheduled-soon', 500, Date.now() + 60_000)
        const result = sortQueuedMessages([b, a])
        expect(result.map((m) => m.id)).toEqual(['a-immediate', 'b-scheduled-soon'])
    })

    it('orders immediate-queued messages by createdAt ascending', () => {
        const older = make('older', 1000)
        const newer = make('newer', 2000)
        const result = sortQueuedMessages([newer, older])
        expect(result.map((m) => m.id)).toEqual(['older', 'newer'])
    })

    it('orders scheduled messages by scheduledAt ascending (soonest first)', () => {
        const later = make('fires-later', 1000, 10_000)
        const sooner = make('fires-sooner', 2000, 5_000)
        const result = sortQueuedMessages([later, sooner])
        expect(result.map((m) => m.id)).toEqual(['fires-sooner', 'fires-later'])
    })

    it('combined: immediate first, then scheduled in fire-time order', () => {
        const im1 = make('im1', 1000)
        const im2 = make('im2', 2000)
        const sched1 = make('sched-near', 500, 5_000)
        const sched2 = make('sched-far', 600, 10_000)
        const result = sortQueuedMessages([sched2, im2, sched1, im1])
        expect(result.map((m) => m.id)).toEqual(['im1', 'im2', 'sched-near', 'sched-far'])
    })
})

describe('getQueuedMessagePreview', () => {
    it('keeps attachment names with a text prompt', () => {
        const message = {
            id: 'queued-with-image',
            localId: 'queued-with-image',
            createdAt: 1000,
            seq: null,
            invokedAt: null,
            status: 'queued',
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Analyze this screenshot',
                    attachments: [{
                        id: 'att-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 1234,
                        path: '/tmp/image.png',
                    }],
                },
            },
        } as unknown as DecryptedMessage

        expect(getQueuedMessagePreview(message)).toEqual({
            text: 'Analyze this screenshot',
            attachmentNames: ['image.png'],
        })
    })

    it('uses attachment names for attachment-only queued messages', () => {
        const message = {
            id: 'queued-image-only',
            localId: 'queued-image-only',
            createdAt: 1000,
            seq: null,
            invokedAt: null,
            status: 'queued',
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: '',
                    attachments: [{
                        id: 'att-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 1234,
                        path: '/tmp/image.png',
                    }],
                },
            },
        } as unknown as DecryptedMessage

        expect(getQueuedMessagePreview(message)).toEqual({
            text: '',
            attachmentNames: ['image.png'],
        })
    })
})

describe('getQueuedMessageEditText', () => {
    it('keeps the prompt text when queued message has both text and attachments', () => {
        expect(getQueuedMessageEditText({
            text: 'Analyze this screenshot',
            attachmentNames: ['image.png'],
        })).toBe('Analyze this screenshot')
    })

    it('falls back to attachment names for attachment-only queued messages', () => {
        expect(getQueuedMessageEditText({
            text: '',
            attachmentNames: ['image.png', 'trace.log'],
        })).toBe('image.png, trace.log')
    })
})

// ---------------------------------------------------------------------------
// formatScheduledTime — cross-year support (#8)
// ---------------------------------------------------------------------------

describe('formatScheduledTime', () => {
    it('omits year for a date in the current year', () => {
        const now = new Date()
        // Use a date 1 month ahead in the same year, guarding against Dec edge case
        const sameYearDate = new Date(now.getFullYear(), now.getMonth() + 1 < 12 ? now.getMonth() + 1 : 0, 15, 10, 30)
        if (sameYearDate.getFullYear() !== now.getFullYear()) {
            // Wrapped to next year — skip (edge case in late December)
            return
        }
        const result = formatScheduledTime(sameYearDate.getTime())
        // Year digits should not appear
        expect(result).not.toContain(String(now.getFullYear()))
    })

    it('includes year for a date in a different year', () => {
        const nextYear = new Date().getFullYear() + 1
        const crossYearDate = new Date(nextYear, 0, 15, 10, 30) // Jan 15 next year
        const result = formatScheduledTime(crossYearDate.getTime())
        expect(result).toContain(String(nextYear))
    })
})

describe('QueuedMessagesBar prompts inserted by a task', () => {
    it('labels a task prompt and offers only Skip, never Edit or Steer', () => {
        const api = { steerMessage: mocks.steerMessage } as unknown as ApiClient
        renderQueuedMessage(null, null, 0, true, api, { localId: 'hapi-task:task-1:2' })
        expect(screen.getByText('queuedMessages.fromTask')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'queuedMessages.skipTaskPrompt' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'queuedMessages.edit' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'queuedMessages.steer' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'queuedMessages.cancel' })).toBeNull()
        // The task sends the prompt in its own time; the fork's ↑ (deliver now) stays off too.
        expect(screen.queryByRole('button', { name: 'queuedMessages.deliverNow' })).toBeNull()
    })

    it('keeps Edit, Cancel and Steer for a prompt the user queued', () => {
        const api = { steerMessage: mocks.steerMessage } as unknown as ApiClient
        renderQueuedMessage(null, null, 0, true, api, { localId: 'local-server-message-id' })
        expect(screen.queryByText('queuedMessages.fromTask')).toBeNull()
        expect(screen.getByRole('button', { name: 'queuedMessages.edit' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'queuedMessages.steer' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'queuedMessages.cancel' })).toBeTruthy()
    })

    it('gives the row buttons a 32 px target and a wider gap under a coarse pointer only', () => {
        const api = { steerMessage: mocks.steerMessage } as unknown as ApiClient
        renderQueuedMessage(null, null, 0, true, api)
        // jsdom applies no media query, so the classes are what is checked: gap 1 by default,
        // 1.5 under (pointer: coarse), like the task bar.
        const group = screen.getByRole('button', { name: 'queuedMessages.cancel' }).parentElement as HTMLElement
        expect(group.className.split(/\s+/)).toEqual(expect.arrayContaining(['gap-1', 'pointer-coarse:gap-1.5']))
        for (const name of ['queuedMessages.edit', 'queuedMessages.steer']) {
            const classes = screen.getByRole('button', { name }).className.split(/\s+/)
            expect(classes, name).toEqual(expect.arrayContaining(['h-6', 'w-6', 'pointer-coarse:h-8', 'pointer-coarse:w-8']))
        }
        // Cancel is the one red control, and a little larger to begin with.
        const cancel = screen.getByRole('button', { name: 'queuedMessages.cancel' }).className.split(/\s+/)
        expect(cancel).toEqual(expect.arrayContaining(['h-7', 'w-7', 'pointer-coarse:h-8', 'pointer-coarse:w-8', 'text-red-500']))
    })
})

describe('QueuedMessagesBar steer action', () => {
    // The real useSteerQueuedMessage hook runs here (only the cancel hook is
    // module-mocked); pass a fake api whose steerMessage resolves on demand.
    function renderSteerable(canSteer = true) {
        mocks.steerMessage.mockImplementation(() => new Promise((resolve) => {
            mocks.resolveSteer = resolve
        }))
        const api = { steerMessage: mocks.steerMessage } as unknown as ApiClient
        const view = renderQueuedMessage(null, null, 0, canSteer, api)
        return { unmount: view.unmount }
    }

    it('shows the Steer button only when canSteer is set and the row is immediate', () => {
        const immediate = renderSteerable(true)
        expect(screen.getByRole('button', { name: 'queuedMessages.steer' })).toBeTruthy()
        immediate.unmount()

        renderSteerable(false)
        expect(screen.queryByRole('button', { name: 'queuedMessages.steer' })).toBeNull()
    })

    it('hides the Steer button on future-scheduled rows', () => {
        const api = { steerMessage: mocks.steerMessage } as unknown as ApiClient
        renderQueuedMessage(Date.now() + 60_000, null, 0, true, api)
        expect(screen.queryByRole('button', { name: 'queuedMessages.steer' })).toBeNull()
    })

    it('calls the steer api with the session and message id', async () => {
        renderSteerable(true)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.steer' }))

        await waitFor(() => expect(mocks.steerMessage).toHaveBeenCalledWith('session-1', 'server-message-id'))
        // Settle the pending mutation so the queued-operation token releases;
        // otherwise the next test would see the session as busy.
        await act(async () => {
            mocks.resolveSteer?.({ status: 'steered', localId: 'local-server-message-id' })
            await Promise.resolve()
        })
    })

    it('toasts when the steer fails and leaves the row queued', async () => {
        renderSteerable(true)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.steer' }))
        await waitFor(() => expect(mocks.steerMessage).toHaveBeenCalled())
        await act(async () => {
            mocks.resolveSteer?.({ status: 'failed', error: 'Session is not streaming', localId: 'local-server-message-id' })
            await Promise.resolve()
        })

        expect(mocks.addToast).toHaveBeenCalledWith({
            title: 'queuedMessages.steerFailed',
            body: 'Session is not streaming',
            sessionId: 'session-1',
            url: window.location.href,
        })
    })

    it('does not toast on a successful steer (the consumed event clears the row)', async () => {
        renderSteerable(true)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.steer' }))
        await waitFor(() => expect(mocks.steerMessage).toHaveBeenCalled())
        await act(async () => {
            mocks.resolveSteer?.({ status: 'steered', localId: 'local-server-message-id' })
            await Promise.resolve()
        })

        expect(mocks.addToast).not.toHaveBeenCalled()
    })

    it('reconciles a stale queued row when the steer returns invoked (missed consumption SSE)', async () => {
        renderSteerable(true)

        fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.steer' }))
        await waitFor(() => expect(mocks.steerMessage).toHaveBeenCalled())
        await act(async () => {
            mocks.resolveSteer?.({
                status: 'invoked',
                message: { localId: 'local-server-message-id', invokedAt: 5_000 },
            })
            await Promise.resolve()
        })

        expect(mocks.markMessagesConsumed).toHaveBeenCalledWith(
            'session-1',
            ['local-server-message-id'],
            5_000,
        )
        expect(mocks.addToast).not.toHaveBeenCalled()
    })
})


describe('unconfirmed delivery actions', () => {
    it('shows confirmation pending without Steer or Retry while the turn owns the delivery', () => {
        renderQueuedMessage(null, null, 0, true, null, { deliveryState: 'indeterminate', deliveryPending: true })
        expect(screen.getByText('queuedMessages.deliveryPending')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'queuedMessages.steer' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'queuedMessages.retryOutcome' })).toBeNull()
        expect(screen.getByRole('button', { name: 'queuedMessages.cancel' })).toBeDisabled()
    })

    it.each([false, true])('keeps explicit resolution for real uncertainty when steer capability is %s', (canSteer) => {
        renderQueuedMessage(null, null, 0, canSteer, null, { deliveryState: 'indeterminate' })
        expect(screen.getByText('queuedMessages.steerOutcomeUnknown')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'queuedMessages.retryOutcome' })).toBeEnabled()
        expect(screen.getByRole('button', { name: 'queuedMessages.cancel' })).toBeEnabled()
    })

    it('offers explicit resolution when the pending owner is no longer steerable', () => {
        renderQueuedMessage(null, null, 0, false, null, { deliveryState: 'indeterminate', deliveryPending: true })
        expect(screen.getByText('queuedMessages.steerOutcomeUnknown')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'queuedMessages.retryOutcome' })).toBeEnabled()
        expect(screen.queryByText('queuedMessages.deliveryPending')).toBeNull()
    })
})


it('keeps a live confirmation pending during normal drain after new Steer admission closes', () => {
    renderQueuedMessage(null, null, 0, false, null, { deliveryState: 'indeterminate', deliveryPending: true }, true)
    expect(screen.getByText('queuedMessages.deliveryPending')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'queuedMessages.retryOutcome' })).toBeNull()
})


it('does not expose a second Steer when REST success beats the pending SSE', async () => {
    const api = { steerMessage: vi.fn().mockResolvedValue({ status: 'steered', localId: 'local-server-message-id' }), getQueuedState: vi.fn().mockResolvedValue({ queuedLocalIds: [], indeterminateLocalIds: ['local-server-message-id'], dispatchingLocalIds: ['local-server-message-id'], invokedLocalMessages: [] }) } as unknown as ApiClient
    renderQueuedMessage(null, null, 0, true, api)
    fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.steer' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'queuedMessages.steer' })).toBeNull())
    expect(await screen.findByText('queuedMessages.deliveryPending')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'queuedMessages.steer' })).toBeNull()
    expect(mocks.addToast).not.toHaveBeenCalled()
})

describe('QueuedMessagesBar send-now affordance', () => {
    it('shows the ↑ send-now button for a queued row once the turn has stopped and delivers on click', async () => {
        const deliverNow = vi.fn().mockResolvedValue({ status: 'delivered', localId: 'local-server-message-id' })
        const api = { deliverQueuedMessageNow: deliverNow } as unknown as ApiClient
        renderQueuedMessage(null, null, 0, false, api)
        const button = screen.getByRole('button', { name: 'queuedMessages.deliverNow' })
        await act(async () => {
            fireEvent.click(button)
        })
        await waitFor(() => expect(deliverNow).toHaveBeenCalledWith('session-1', 'server-message-id'))
    })

    it('hides ↑ while a turn is dispatching, even when steer is not available', () => {
        renderQueuedMessage(null, null, 0, false, null, {}, true)
        expect(screen.queryByRole('button', { name: 'queuedMessages.deliverNow' })).toBeNull()
    })

    it('hides ↑ while steer owns the row (mid-turn case)', () => {
        renderQueuedMessage(null, null, 0, true, null)
        expect(screen.queryByRole('button', { name: 'queuedMessages.deliverNow' })).toBeNull()
        expect(screen.getByRole('button', { name: 'queuedMessages.steer' })).toBeTruthy()
    })

    it('hides ↑ for future-scheduled rows', () => {
        renderQueuedMessage(Date.now() + 60_000, null, 0, false, null)
        expect(screen.queryByRole('button', { name: 'queuedMessages.deliverNow' })).toBeNull()
    })

    it('shows ↑ for a scheduled row once it has matured', () => {
        renderQueuedMessage(Date.now() - 1_000, null, 0, false, null)
        expect(screen.getByRole('button', { name: 'queuedMessages.deliverNow' })).toBeTruthy()
    })

    it('hides ↑ for a prompt a task sent — the task tracks that row and sends it itself', () => {
        renderQueuedMessage(null, null, 0, false, null, { localId: 'hapi-task:task-1:2' })
        expect(screen.getByText('queuedMessages.fromTask')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'queuedMessages.deliverNow' })).toBeNull()
        expect(screen.getByRole('button', { name: 'queuedMessages.skipTaskPrompt' })).toBeTruthy()
    })

    it('hides ↑ for shared-native sessions — the hub refuses deliver-now for them', () => {
        renderQueuedMessage(null, null, 0, false, null, {}, false, true)
        expect(screen.queryByRole('button', { name: 'queuedMessages.deliverNow' })).toBeNull()
    })

    it('toasts when the runner cannot accept the re-delivery and keeps the row actionable', async () => {
        const deliverNow = vi.fn().mockResolvedValue({ status: 'unavailable', localId: 'local-server-message-id' })
        const api = { deliverQueuedMessageNow: deliverNow } as unknown as ApiClient
        renderQueuedMessage(null, null, 0, false, api)
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'queuedMessages.deliverNow' }))
        })
        await waitFor(() => expect(mocks.addToast).toHaveBeenCalledTimes(1))
        expect(mocks.addToast.mock.calls[0][0].title).toBe('queuedMessages.deliverNowUnavailable')
        // The row is untouched; the affordance stays available for another try.
        expect(screen.getByRole('button', { name: 'queuedMessages.deliverNow' })).toBeTruthy()
    })
})

import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
} from '@/lib/message-window-store'
import { forgetSendAborted, isSendAborted, listAbortedSends, markSendAborted, resetAbortedSends } from '@/lib/abortedSends'
import { useAbortedSendReconciler } from './useAbortedSendReconciler'

const mocks = vi.hoisted(() => ({ cancelMessage: vi.fn(), getQueuedState: vi.fn(), addToast: vi.fn() }))
const api = { cancelMessage: mocks.cancelMessage, getQueuedState: mocks.getQueuedState } as unknown as ApiClient
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/toast-context', () => ({ useToast: () => ({ addToast: mocks.addToast }) }))
/** What the user was told, in order. */
const told = () => mocks.addToast.mock.calls.map((call) => call[0].title)

const sid = 'reconcile-session'
const localId = 'local-cancelled'
const noSuchMessage = { queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] }

function hubRow(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: 'server-1', localId, seq: 4, createdAt: 1_000, invokedAt: null,
        content: { role: 'user', content: { type: 'text', text: 'never mind' } },
        ...overrides,
    } as DecryptedMessage
}

function mount(sessionId: string | null = sid, probeDelayMs = 20) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    // The real clock, and a probe that waits only a blink: the window paces its notifications by
    // the clock and an animation frame, which a fake clock only half owns.
    return renderHook(() => useAbortedSendReconciler(api, sessionId, { probeDelayMs }), {
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })
}
const rowInWindow = () => getMessageWindowState(sid).messages.find((message) => message.localId === localId) ?? null
/** Lets the promises already started (a mutation, a probe) run to where they wait on nothing. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await act(async () => { await Promise.resolve() })
    }
}

/** A cancel in flight whose echo has not come: the device's row is gone and the send is remembered. */
function cancelledInFlight(sessionId: string) {
    markSendAborted(sessionId, localId)
    clearMessageWindow(sessionId)
}

describe('useAbortedSendReconciler', () => {
    beforeEach(() => {
        resetAbortedSends()
        clearMessageWindow(sid)
        mocks.cancelMessage.mockReset()
        mocks.cancelMessage.mockResolvedValue({ status: 'cancelled', localId })
        mocks.getQueuedState.mockReset()
        mocks.getQueuedState.mockResolvedValue(noSuchMessage)
        mocks.addToast.mockReset()
    })
    afterEach(() => {
        resetAbortedSends()
        for (const id of [sid, 'probe-1', 'probe-2', 'probe-3', 'probe-4']) clearMessageWindow(id)
    })

    it('cancels, for real, the row the hub kept of a send the user cancelled in flight', async () => {
        cancelledInFlight(sid)
        // Then the hub's echo turns up.
        ingestIncomingMessages(sid, [hubRow()])
        expect(rowInWindow()?.id).toBe('server-1')

        mount()
        await waitFor(() => expect(mocks.cancelMessage).toHaveBeenCalledWith(sid, 'server-1'))
        await waitFor(() => expect(rowInWindow()).toBeNull())
        expect(isSendAborted(sid, localId)).toBe(false)
    })

    it('tells the user how the cancel went', async () => {
        cancelledInFlight(sid)
        ingestIncomingMessages(sid, [hubRow()])
        mount()
        await waitFor(() => expect(told()).toEqual(['queuedMessages.cancelled']))
    })

    it('cancels a row that turns up while mounted', async () => {
        cancelledInFlight(sid)
        mount()
        await act(async () => { ingestIncomingMessages(sid, [hubRow()]) })
        // The window tells its readers on its next tick.
        await waitFor(() => expect(mocks.cancelMessage).toHaveBeenCalledWith(sid, 'server-1'))
        await waitFor(() => expect(rowInWindow()).toBeNull())
    })

    it('asks the hub by local id when no echo came, and cancels there what it is holding', async () => {
        const s = 'probe-1'
        mocks.getQueuedState.mockResolvedValue({ ...noSuchMessage, queuedLocalIds: [localId] })
        cancelledInFlight(s)
        mount(s)
        expect(mocks.getQueuedState).not.toHaveBeenCalled()
        await waitFor(() => expect(mocks.getQueuedState).toHaveBeenCalledWith(s, [localId]))
        // The hub knows a row by its local id as well as by its own.
        await waitFor(() => expect(mocks.cancelMessage).toHaveBeenCalledWith(s, localId))
        await waitFor(() => expect(listAbortedSends(s)).toEqual([]))
        expect(told()).toEqual(['queuedMessages.cancelled'])
    })

    it('tells the user when the hub says the agent already took the cancelled message', async () => {
        const s = 'probe-2'
        mocks.getQueuedState.mockResolvedValue({ ...noSuchMessage, invokedLocalMessages: [{ localId, invokedAt: 9_000 }] })
        cancelledInFlight(s)
        mount(s)
        await waitFor(() => expect(told()).toEqual(['queuedMessages.cancelTooLate']))
        expect(mocks.cancelMessage).not.toHaveBeenCalled()
        expect(listAbortedSends(s)).toEqual([])
    })

    it('when the hub has nothing of it, says so and keeps watching for a late echo', async () => {
        const s = 'probe-3'
        mocks.getQueuedState.mockResolvedValue(noSuchMessage)
        cancelledInFlight(s)
        mount(s)
        await waitFor(() => expect(told()).toEqual(['queuedMessages.cancelled']))
        // On a slow line the request may still be on its way: if its echo turns up, it is cancelled.
        expect(listAbortedSends(s)).toHaveLength(1)
        await act(async () => { ingestIncomingMessages(s, [hubRow()]) })
        // The window tells its readers on its next tick.
        await waitFor(() => expect(mocks.cancelMessage).toHaveBeenCalledWith(s, 'server-1'))
        await waitFor(() => expect(listAbortedSends(s)).toEqual([]))
        // And it is not told twice.
        expect(told()).toEqual(['queuedMessages.cancelled'])
    })

    it('when the hub did not answer, says nothing yet, and asks again until it does', async () => {
        const s = 'probe-4'
        mocks.getQueuedState.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(noSuchMessage)
        cancelledInFlight(s)
        mount(s, 300)
        await waitFor(() => expect(mocks.getQueuedState).toHaveBeenCalled())
        await settle()
        // Nothing is claimed before the hub has said.
        expect(told()).toEqual([])
        expect(listAbortedSends(s)).toHaveLength(1)
        await waitFor(() => expect(told()).toEqual(['queuedMessages.cancelled']))
        expect(mocks.getQueuedState).toHaveBeenCalledTimes(2)
    })

    it('does not ask the hub about a row the agent already took, and lets it read as sent', async () => {
        markSendAborted(sid, localId)
        ingestIncomingMessages(sid, [hubRow({ invokedAt: 9_000 })])
        mount()
        await waitFor(() => expect(told()).toEqual(['queuedMessages.cancelTooLate']))
        expect(mocks.cancelMessage).not.toHaveBeenCalled()
        expect(isSendAborted(sid, localId)).toBe(false)
        expect(rowInWindow()?.invokedAt).toBe(9_000)
    })

    it('waits while the window only holds the device’s own copy', async () => {
        markSendAborted(sid, localId)
        ingestIncomingMessages(sid, [hubRow({ id: localId })])
        mount()
        await settle()
        expect(mocks.cancelMessage).not.toHaveBeenCalled()
        expect(isSendAborted(sid, localId)).toBe(true)
    })

    it('shows the row again, with its cancel, and says the hub could not be reached', async () => {
        mocks.cancelMessage.mockRejectedValue(new Error('offline'))
        markSendAborted(sid, localId)
        ingestIncomingMessages(sid, [hubRow()])
        mount()
        await waitFor(() => expect(told()).toEqual(['queuedMessages.cancelFailed']))
        // useCancelQueuedMessage put it back; it must not stay hidden behind a forgotten entry.
        expect(rowInWindow()?.id).toBe('server-1')
        expect(isSendAborted(sid, localId)).toBe(false)
    })

    it('says so when the hub could not cancel it, and the row comes back for another try', async () => {
        mocks.cancelMessage.mockResolvedValue({ status: 'busy', localId })
        markSendAborted(sid, localId)
        ingestIncomingMessages(sid, [hubRow()])
        mount()
        await waitFor(() => expect(told()).toEqual(['queuedMessages.cancelFailed']))
        expect(rowInWindow()).not.toBeNull()
        expect(isSendAborted(sid, localId)).toBe(false)
    })

    it('lets a row the agent took first read as sent', async () => {
        mocks.cancelMessage.mockResolvedValue({
            status: 'invoked',
            message: { id: 'server-1', seq: null, localId, content: {}, createdAt: 1, invokedAt: 9_500 },
        })
        markSendAborted(sid, localId)
        ingestIncomingMessages(sid, [hubRow()])
        mount()
        await waitFor(() => expect(told()).toEqual(['queuedMessages.cancelTooLate']))
        expect(isSendAborted(sid, localId)).toBe(false)
        expect(rowInWindow()).toMatchObject({ status: 'sent', invokedAt: 9_500 })
    })

    it('does not repeat a cancel that is already on its way', async () => {
        let settleCancel!: (value: unknown) => void
        mocks.cancelMessage.mockImplementation(() => new Promise((resolve) => { settleCancel = resolve }))
        markSendAborted(sid, localId)
        ingestIncomingMessages(sid, [hubRow()])
        mount()
        // Store notifications while the DELETE is in flight must not send a second one.
        await waitFor(() => expect(mocks.cancelMessage).toHaveBeenCalledTimes(1))
        await act(async () => {
            ingestIncomingMessages(sid, [{ ...hubRow(), id: 'unrelated', localId: 'local-unrelated' } as DecryptedMessage])
            await Promise.resolve()
        })
        await settle()
        expect(mocks.cancelMessage).toHaveBeenCalledTimes(1)
        await act(async () => { settleCancel({ status: 'cancelled', localId }) })
        await waitFor(() => expect(listAbortedSends(sid)).toEqual([]))
        expect(mocks.cancelMessage).toHaveBeenCalledTimes(1)
    })

    it('leaves the rows of another session alone', async () => {
        const other = 'other-session'
        try {
            markSendAborted(other, localId)
            ingestIncomingMessages(sid, [hubRow()])
            mount()
            await settle()
            expect(mocks.cancelMessage).not.toHaveBeenCalled()
            expect(isSendAborted(other, localId)).toBe(true)
        } finally {
            forgetSendAborted(other, localId)
        }
    })
})

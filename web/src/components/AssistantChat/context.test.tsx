import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memo } from 'react'
import {
    HappyChatProvider,
    useHappyChatContext,
    useHappyChatStatus,
    type HappyChatContextValue,
    type HappyChatStatusValue,
} from '@/components/AssistantChat/context'
import type { ApiClient } from '@/api/client'

// Render prototype A: the sync/paging status lives on its own context, so a
// status flip re-renders the components that display it and nothing else.
// The rows here are memoized prop-less components, like the real message rows.

function baseValue(overrides: Partial<HappyChatContextValue> = {}): HappyChatContextValue {
    return {
        api: {} as ApiClient,
        sessionId: 'session-1',
        metadata: null,
        terminalToolDisplayMode: 'compact',
        showSessionSummaryInChat: false,
        disabled: false,
        onRefresh: () => {},
        hasMoreMessages: true,
        isSyncingTail: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'terminal-stop',
        ...overrides,
    }
}

const Rows = memo(function Rows({ onRender }: { onRender: (value: HappyChatContextValue) => void }) {
    const ctx = useHappyChatContext()
    onRender(ctx)
    return <div data-testid="rows" />
})

function StatusReader({ onRender }: { onRender: (status: HappyChatStatusValue) => void }) {
    const status = useHappyChatStatus()
    onRender(status)
    return <div data-testid="status">{`${status.isSyncingTail}|${status.isLoadingMoreMessages}|${status.hasMoreMessages}`}</div>
}

function PlanFooter({ onRender }: { onRender: (ctx: HappyChatContextValue) => void }) {
    const ctx = useHappyChatContext()
    onRender(ctx)
    return <button type="button" onClick={() => ctx.onContinuePlan?.('plan-1')}>continue</button>
}

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

describe('HappyChatProvider status context', () => {
    it('does not re-render rows when the sync status changes, and keeps their context value identical', () => {
        const rowRenders = vi.fn()
        const statusRenders = vi.fn()
        const tree = () => (
            <HappyChatProvider value={value}>
                <Rows onRender={rowRenders} />
                <StatusReader onRender={statusRenders} />
            </HappyChatProvider>
        )
        // Only the status fields change between renders; every other field keeps its identity.
        const base = baseValue()
        let value = base
        const view = render(tree())
        expect(rowRenders).toHaveBeenCalledTimes(1)
        expect(statusRenders).toHaveBeenCalledTimes(1)
        expect(view.getByTestId('status').textContent).toBe('false|false|true')

        act(() => { value = { ...base, isSyncingTail: true }; view.rerender(tree()) })
        act(() => { value = { ...base, isSyncingTail: true, isLoadingMoreMessages: true }; view.rerender(tree()) })
        act(() => { value = { ...base, isSyncingTail: false, isLoadingMoreMessages: false, hasMoreMessages: false }; view.rerender(tree()) })

        expect(statusRenders).toHaveBeenCalledTimes(4)
        expect(view.getByTestId('status').textContent).toBe('false|false|false')
        expect(rowRenders).toHaveBeenCalledTimes(1)
    })

    it('publishes the status only on the status context', () => {
        const rowRenders = vi.fn()
        const tree = () => (
            <HappyChatProvider value={value}>
                <Rows onRender={rowRenders} />
            </HappyChatProvider>
        )
        let value = baseValue({ isSyncingTail: true, isLoadingMoreMessages: true, hasMoreMessages: false })
        const view = render(tree())
        // `value` passed all three as true/true/false; the rows' context carries none of them.
        const seen = rowRenders.mock.calls[0][0]
        expect(seen.isSyncingTail).toBeUndefined()
        expect(seen.isLoadingMoreMessages).toBeUndefined()
        expect(seen.hasMoreMessages).toBeUndefined()
        expect(view.getByTestId('rows')).toBeTruthy()
    })

    it('re-renders rows when a field they do depend on changes', () => {
        const rowRenders = vi.fn()
        const tree = () => (
            <HappyChatProvider value={value}>
                <Rows onRender={rowRenders} />
            </HappyChatProvider>
        )
        const base = baseValue()
        let value = base
        const view = render(tree())
        const before = rowRenders.mock.calls[0][0]
        act(() => { value = { ...base, disabled: true }; view.rerender(tree()) })
        expect(rowRenders).toHaveBeenCalledTimes(2)
        const after = rowRenders.mock.calls[1][0]
        expect(after).not.toBe(before)
        expect(after.disabled).toBe(true)
        expect(after.api).toBe(before.api)
    })

    it('still re-renders rows while a fork / branch action is pending (known, deliberate)', () => {
        const rowRenders = vi.fn()
        const tree = () => (
            <HappyChatProvider value={value}>
                <Rows onRender={rowRenders} />
            </HappyChatProvider>
        )
        const base = baseValue()
        let value = base
        const view = render(tree())
        act(() => { value = { ...base, historyActionPending: true }; view.rerender(tree()) })
        expect(rowRenders).toHaveBeenCalledTimes(2)
        expect(rowRenders.mock.calls[1][0].historyActionPending).toBe(true)
    })
})

describe('HappyChatProvider onContinuePlan', () => {
    function renderFooter(value: Partial<HappyChatContextValue>) {
        const renders: HappyChatContextValue[] = []
        const onContinuePlan = vi.fn()
        const full = baseValue({ codexPlanProposalId: 'plan-1', onContinuePlan, ...value })
        const view = render(<HappyChatProvider value={full}><PlanFooter onRender={(ctx) => renders.push(ctx)} /></HappyChatProvider>)
        return { view, onContinuePlan, renders }
    }

    it('forwards the first click and remembers the dismissal', () => {
        const { view, onContinuePlan, renders } = renderFooter({})
        const button = within(view.container).getByText('continue')
        // Two separate clicks, each flushed like a discrete user event would be.
        act(() => { button.click() })
        act(() => { button.click() })
        expect(onContinuePlan).toHaveBeenCalledTimes(1)
        expect(onContinuePlan).toHaveBeenCalledWith('plan-1')
        const last = renders[renders.length - 1]
        expect([...(last.continuedPlanIds ?? [])]).toEqual(['plan-1'])
    })

    it('does not offer the action when no handler is given', () => {
        const renders: HappyChatContextValue[] = []
        render(<HappyChatProvider value={baseValue({ codexPlanProposalId: 'plan-1' })}><PlanFooter onRender={(ctx) => renders.push(ctx)} /></HappyChatProvider>)
        expect(renders[0].onContinuePlan).toBeUndefined()
    })

    it('ignores clicks for another proposal or while disabled', () => {
        const other = renderFooter({ codexPlanProposalId: 'plan-2' })
        within(other.view.container).getByText('continue').click()
        expect(other.onContinuePlan).not.toHaveBeenCalled()

        const locked = renderFooter({ disabled: true })
        within(locked.view.container).getByText('continue').click()
        expect(locked.onContinuePlan).not.toHaveBeenCalled()
        expect(locked.renders[locked.renders.length - 1].continuedPlanIds?.size ?? 0).toBe(0)
    })
})

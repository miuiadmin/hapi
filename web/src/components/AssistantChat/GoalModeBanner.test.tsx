import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadGoal } from '@/types/api'
import { GoalModeBanner, useGoalModeTransitionBanner } from '@/components/AssistantChat/GoalModeBanner'
import { I18nProvider } from '@/lib/i18n-context'

function makeGoal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
    return {
        threadId: 'thread-1',
        objective: 'Ship the release',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0,
        ...overrides
    }
}

describe('useGoalModeTransitionBanner', () => {
    afterEach(() => vi.useRealTimers())

    it('stays silent for a goal that already exists on mount', () => {
        const { result } = renderHook((goal: ThreadGoal | null) => useGoalModeTransitionBanner(goal), {
            initialProps: makeGoal() as ThreadGoal | null
        })
        expect(result.current.banner).toBeNull()
    })

    it('announces entering goal mode (null → goal)', () => {
        const { result, rerender } = renderHook((goal: ThreadGoal | null) => useGoalModeTransitionBanner(goal), {
            initialProps: null as ThreadGoal | null
        })
        rerender(makeGoal())
        expect(result.current.banner).toEqual({ kind: 'entered', objective: 'Ship the release' })
    })

    it('announces exiting goal mode (goal → null)', () => {
        const { result, rerender } = renderHook((goal: ThreadGoal | null) => useGoalModeTransitionBanner(goal), {
            initialProps: makeGoal() as ThreadGoal | null
        })
        rerender(null as ThreadGoal | null)
        expect(result.current.banner).toEqual({ kind: 'exited', objective: 'Ship the release' })
    })

    it.each(['complete', 'blocked'] as const)('announces clearing when the goal becomes %s', (status) => {
        const { result, rerender } = renderHook((goal: ThreadGoal | null) => useGoalModeTransitionBanner(goal), {
            initialProps: makeGoal() as ThreadGoal | null
        })
        rerender(makeGoal({ status, objective: 'Now done' }))
        expect(result.current.banner).toEqual({ kind: 'cleared', objective: 'Now done' })
    })

    it('ignores content-only goal updates that keep goal mode running', () => {
        const { result, rerender } = renderHook((goal: ThreadGoal | null) => useGoalModeTransitionBanner(goal), {
            initialProps: makeGoal() as ThreadGoal | null
        })
        rerender(makeGoal({ tokensUsed: 999, status: 'paused' }))
        expect(result.current.banner).toBeNull()
    })

    it('ignores identity churn once the goal is already terminal', () => {
        const { result, rerender } = renderHook((goal: ThreadGoal | null) => useGoalModeTransitionBanner(goal), {
            initialProps: makeGoal({ status: 'complete' }) as ThreadGoal | null
        })
        rerender(makeGoal({ status: 'complete', tokensUsed: 5 }))
        expect(result.current.banner).toBeNull()
    })

    it('auto-dismisses after five seconds', () => {
        vi.useFakeTimers()
        const { result, rerender } = renderHook((goal: ThreadGoal | null) => useGoalModeTransitionBanner(goal), {
            initialProps: null as ThreadGoal | null
        })
        rerender(makeGoal())
        act(() => { vi.advanceTimersByTime(4999) })
        expect(result.current.banner).not.toBeNull()
        act(() => { vi.advanceTimersByTime(1) })
        expect(result.current.banner).toBeNull()
    })

    it('can be dismissed manually', () => {
        const { result, rerender } = renderHook((goal: ThreadGoal | null) => useGoalModeTransitionBanner(goal), {
            initialProps: null as ThreadGoal | null
        })
        rerender(makeGoal())
        act(() => result.current.dismiss())
        expect(result.current.banner).toBeNull()
    })
})

describe('GoalModeBanner', () => {
    beforeEach(() => localStorage.setItem('hapi-lang', 'en'))

    it('renders the transition title with the objective and a dismiss control', () => {
        render(<I18nProvider>
            <GoalModeBanner banner={{ kind: 'entered', objective: 'Ship the release' }} onDismiss={() => {}} />
        </I18nProvider>)
        expect(screen.getByText('Goal mode')).toBeInTheDocument()
        expect(screen.getByText('Ship the release')).toBeInTheDocument()
        expect(screen.getByRole('status')).toBeInTheDocument()
    })

    it('renders nothing without a transition', () => {
        const { container } = render(<I18nProvider>
            <GoalModeBanner banner={null} onDismiss={() => {}} />
        </I18nProvider>)
        expect(container.querySelector('[data-goal-mode-banner]')).toBeNull()
    })

    it('dismisses through the toast close button', () => {
        const onDismiss = vi.fn()
        render(<I18nProvider>
            <GoalModeBanner banner={{ kind: 'cleared', objective: 'Done' }} onDismiss={onDismiss} />
        </I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
        expect(onDismiss).toHaveBeenCalledTimes(1)
    })
})

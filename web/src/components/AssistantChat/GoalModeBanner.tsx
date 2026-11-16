import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadGoal } from '@/types/api'
import { Toast } from '@/components/ui/Toast'
import { useTranslation } from '@/lib/use-translation'

export type GoalBannerKind = 'entered' | 'exited' | 'cleared'

export type GoalBannerState = { kind: GoalBannerKind; objective: string } | null

/** Goal statuses that end goal mode without a thread-goal-cleared event. */
const TERMINAL_GOAL_STATUSES = ['complete', 'blocked']

const AUTO_DISMISS_MS = 5000

/**
 * Watch the reducer's latestGoal for identity transitions and surface a
 * transient banner:
 *   - null → goal                entered  ("Goal mode: <objective>")
 *   - goal → null                exited
 *   - goal → complete/blocked    cleared
 * Content-only goal updates (token usage ticks, pause/resume) produce new
 * identities too and are deliberately ignored. The first observation after
 * mount only records the baseline, so opening a session that already has a
 * goal stays silent.
 */
export function useGoalModeTransitionBanner(goal: ThreadGoal | null): { banner: GoalBannerState; dismiss: () => void } {
    const [banner, setBanner] = useState<GoalBannerState>(null)
    const previousRef = useRef<{ initialized: boolean; goal: ThreadGoal | null }>({ initialized: false, goal: null })

    useEffect(() => {
        const previous = previousRef.current
        previousRef.current = { initialized: true, goal }
        if (!previous.initialized) return

        const before = previous.goal
        if (before === goal) return

        if (before === null && goal !== null) {
            setBanner({ kind: 'entered', objective: goal.objective })
        } else if (before !== null && goal === null) {
            setBanner({ kind: 'exited', objective: before.objective })
        } else if (before !== null && goal !== null
            && TERMINAL_GOAL_STATUSES.includes(goal.status)
            && !TERMINAL_GOAL_STATUSES.includes(before.status)) {
            setBanner({ kind: 'cleared', objective: goal.objective })
        }
    }, [goal])

    useEffect(() => {
        if (banner === null) return
        const timer = window.setTimeout(() => setBanner(null), AUTO_DISMISS_MS)
        return () => window.clearTimeout(timer)
    }, [banner])

    const dismiss = useCallback(() => setBanner(null), [])
    return { banner, dismiss }
}

const BANNER_TITLE_KEYS: Record<GoalBannerKind, string> = {
    entered: 'session.status.goal.entered',
    exited: 'session.status.goal.exited',
    cleared: 'session.status.goal.cleared'
}

/** Floating transient banner for goal-mode transitions (auto-dismisses). */
export function GoalModeBanner(props: { banner: GoalBannerState; onDismiss: () => void }) {
    const { t } = useTranslation()
    if (props.banner === null) return null
    return (
        <div
            data-goal-mode-banner={props.banner.kind}
            className="pointer-events-none fixed inset-x-0 bottom-28 z-40 mx-auto w-full max-w-sm px-3"
        >
            <Toast
                title={t(BANNER_TITLE_KEYS[props.banner.kind])}
                body={props.banner.objective}
                onClose={props.onDismiss}
            />
        </div>
    )
}

import type { ReactNode } from 'react'
import { Spinner } from '@/components/Spinner'

/**
 * The app's one floating status pill: top centre over a scrolling area, moving
 * nothing and taking no focus. Every "this view is working on it" notice draws
 * through it — the session list loading or refreshing, a conversation waiting for
 * the hub to resume the session, locating a search hit, catching up on the latest
 * messages, loading older ones — so they share one look and one place, and cannot
 * drift apart.
 */
export function FloatingStatusPill(props: {
    testId?: string
    /** Draw the spinner (a state in progress) when no other icon is given. */
    spinner?: boolean
    /** A leading icon other than the spinner, e.g. a pull-to-refresh arrow. */
    icon?: ReactNode
    /** Where it sits in its area, as a vertical position class. */
    top?: string
    children: ReactNode
}) {
    const top = props.top ?? 'top-3'
    return (
        <div
            data-testid={props.testId}
            role="status"
            aria-live="polite"
            className={`pointer-events-none absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-2.5 py-1 text-xs text-[var(--app-hint)] shadow-sm backdrop-blur ${top}`}
        >
            {props.icon ?? (props.spinner === false ? null : <Spinner size="sm" label={null} className="text-current" />)}
            <span>{props.children}</span>
        </div>
    )
}

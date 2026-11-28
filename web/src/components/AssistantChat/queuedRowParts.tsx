/** Parts the queue panel's rows and a waiting bubble share. */

/** 24 px here, a full 32 px where a finger does the tapping; the group widens its gap to match. */
export const ROW_BUTTON_CLASS = 'flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-8 pointer-coarse:w-8'
export const ROW_BUTTON_GROUP_CLASS = 'flex shrink-0 items-center gap-1 pointer-coarse:gap-1.5'
/** The cancel button is the one red thing on a row the agent does not have yet: it is what stops the message. */
export const CANCEL_BUTTON_CLASS = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-red-500/40 text-red-500 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent pointer-coarse:h-8 pointer-coarse:w-8'

export function ClockIcon({ className = 'h-[14px] w-[14px]' }: { className?: string }) {
    return (
        <svg className={`${className} shrink-0`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v3.5l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

export function SteerIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M9.5 1 3 9h3.8L6 15l6.5-8H8.7L9.5 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
    )
}

export function EditIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path
                d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H3v-2L11.5 2.5Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

export function CrossIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    )
}

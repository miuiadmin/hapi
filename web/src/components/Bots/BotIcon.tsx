/**
 * A robot, drawn the way the session list's other toolbar icons are (a 24
 * box, a 2 point stroke): an antenna, a head, two eyes.
 */
export function BotIcon({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <rect x="4" y="8" width="16" height="12" rx="3" />
            <path d="M12 8V4" />
            <path d="M9 4h6" />
            <path d="M9 13v2" />
            <path d="M15 13v2" />
        </svg>
    )
}

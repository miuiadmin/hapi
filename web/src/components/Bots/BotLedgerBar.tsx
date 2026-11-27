import type { BotSummary } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'

function LedgerIcon({ className }: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
            <rect x="5" y="3" width="14" height="18" rx="2" />
            <path d="M9 8h6M9 12h6M9 16h4" />
        </svg>
    )
}

/**
 * The phone-sized way into a bot's ledger: one row under the chat header,
 * since the header itself has no room for another icon below 640px. The
 * header icon takes over from `sm:` up.
 */
export function BotLedgerBar({ bot, active, onToggle }: { bot: BotSummary; active: boolean; onToggle: () => void }) {
    const { t } = useTranslation()
    const needs = bot.counts.needsYou
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={active}
            aria-label={active ? t('bots.ledger.close') : t('bots.ledger.open')}
            data-testid="bot-ledger-bar"
            data-ledger-entry=""
            className="flex w-full items-center gap-2 border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-1.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)] sm:hidden"
        >
            <LedgerIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--app-fg-muted)]">
                {t('bots.ledger.title')}
            </span>
            {needs > 0 ? (
                <span
                    className="inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold leading-4 text-white tabular-nums"
                    data-testid="bot-ledger-bar-badge"
                >
                    <span className="sr-only">{t('bots.needsYou.badge', { count: needs })}</span>
                    <span aria-hidden="true">{needs > 99 ? '99+' : needs}</span>
                </span>
            ) : null}
            <svg viewBox="0 0 16 16" fill="none" className={`h-3.5 w-3.5 shrink-0 text-[var(--app-hint)] transition-transform ${active ? 'rotate-90' : ''}`} aria-hidden="true">
                <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </button>
    )
}

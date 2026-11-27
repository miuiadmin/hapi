import { useId, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { BotSummary } from '@hapi/protocol'
import { apiErrorMessage, type ApiClient } from '@/api/client'
import { invalidateBotSummaries, useBotMutations, useBots } from '@/hooks/queries/useBots'
import { botDisplayStatus, listableBots } from '@/lib/bots'
import { useTranslation } from '@/lib/use-translation'
import { CreateBotDialog } from './CreateBotDialog'
import { useTwoStepConfirm } from './useTwoStepConfirm'

const STATUS_TONE_CLASS = {
    normal: 'text-[var(--app-hint)]',
    warning: 'text-[var(--app-warning-text)]',
    danger: 'text-red-500'
} as const

function BotIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
            <rect x="2.5" y="5" width="11" height="8" rx="2" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 5V2.5M6.2 2.5h3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="5.8" cy="8.5" r="0.9" fill="currentColor" />
            <circle cx="10.2" cy="8.5" r="0.9" fill="currentColor" />
            <path d="M6 10.8h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
    )
}

function PlusIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
    )
}

/** The one action a failed bot without a home chat can still take; two clicks, since archiving is final. */
function RowArchiveButton({ onArchive, busy }: { onArchive: () => void; busy: boolean }) {
    const { t } = useTranslation()
    const archive = useTwoStepConfirm(onArchive)
    const label = archive.armed ? t('bots.row.confirmArchive') : t('bots.row.archive')
    return (
        <button
            type="button"
            aria-label={label}
            disabled={busy}
            onClick={archive.onClick}
            onBlur={archive.onBlur}
            className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                archive.armed ? 'bg-red-600 text-white' : 'text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-red-600'
            }`}
            data-testid="bot-row-archive"
        >
            {label}
        </button>
    )
}

function BotRow({ bot, onOpen, onArchive, archiveBusy }: {
    bot: BotSummary
    onOpen: (sessionId: string) => void
    onArchive: (botId: string) => void
    archiveBusy: boolean
}) {
    const { t } = useTranslation()
    const status = botDisplayStatus(bot)
    if (!status) return null
    const needs = bot.counts.needsYou
    const body = (
        <>
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--app-fg)]">{bot.name}</span>
            <span className={`shrink-0 text-[11px] ${STATUS_TONE_CLASS[status.tone]}`}>
                {t(`bots.status.${status.key}`)}
            </span>
            {needs > 0 ? (
                <span
                    data-testid="bot-needs-you-badge"
                    className="inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold leading-4 text-white tabular-nums"
                >
                    <span className="sr-only">{t('bots.needsYou.badge', { count: needs })}</span>
                    <span aria-hidden="true">{needs > 99 ? '99+' : needs}</span>
                </span>
            ) : null}
        </>
    )
    const title = bot.lastError ?? undefined
    // A bot whose home chat is not there yet (still creating, or it failed) can be seen but not opened.
    if (!bot.homeChatSessionId) {
        return (
            <li>
                <div className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 opacity-70" title={title}>
                    {body}
                    {bot.state === 'failed' ? <RowArchiveButton onArchive={() => onArchive(bot.id)} busy={archiveBusy} /> : null}
                </div>
            </li>
        )
    }
    return (
        <li>
            <button
                type="button"
                onClick={() => onOpen(bot.homeChatSessionId as string)}
                title={title}
                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--app-secondary-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
            >
                {body}
            </button>
        </li>
    )
}

/**
 * The sidebar's "Bots" block: one row per bot with its state and the
 * number of things waiting on the owner, plus the way to make a new one.
 * With no bot yet it is just that way in, so the first bot can be made.
 * Renders nothing on a hub without bot routes, and nothing while the list
 * is still loading (so the "new bot" entry does not flash in and out). A
 * list that failed to load says so and can be retried; it must not read
 * as "no bots".
 */
export function BotsSection({ api, onSelect }: {
    api: ApiClient | null
    /** Opens the bot's home chat like a session row does. */
    onSelect: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const headingId = useId()
    const { bots, isLoading, error, unsupported } = useBots(api)
    const { archiveBot } = useBotMutations(api)
    const [createOpen, setCreateOpen] = useState(false)
    const [archiveError, setArchiveError] = useState<string | null>(null)
    const listed = useMemo(() => listableBots(bots), [bots])

    if (!api || unsupported || isLoading) return null

    const archive = async (botId: string) => {
        setArchiveError(null)
        try {
            await archiveBot.mutateAsync(botId)
        } catch (cause) {
            setArchiveError(apiErrorMessage(cause, t('bots.ledger.archiveFailed')))
        }
    }

    if (error && bots.length === 0) {
        return (
            <section aria-label={t('bots.section.title')} data-testid="bots-section" className="pt-1">
                <div role="alert" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-red-500">
                    <span className="min-w-0 flex-1">{t('bots.section.loadFailed')}</span>
                    <button
                        type="button"
                        onClick={() => { void invalidateBotSummaries(queryClient) }}
                        className="shrink-0 rounded px-2 py-0.5 text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]"
                    >
                        {t('bots.ledger.retry')}
                    </button>
                </div>
            </section>
        )
    }

    return (
        <section aria-label={t('bots.section.title')} data-testid="bots-section" className="pt-1">
            {listed.length === 0 ? (
                <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    data-testid="bots-new-first"
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-[var(--app-link)] transition-colors hover:bg-[var(--app-secondary-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    <PlusIcon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{t('bots.new')}</span>
                </button>
            ) : (
                <>
                    <div className="flex min-w-0 items-center gap-1.5 rounded-lg py-1 pl-2 pr-1">
                        <BotIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]" />
                        <span id={headingId} className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--app-hint)]">
                            {t('bots.section.title')}
                        </span>
                        <button
                            type="button"
                            aria-label={t('bots.new')}
                            title={t('bots.new')}
                            onClick={() => setCreateOpen(true)}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-link)] transition-colors hover:bg-[var(--app-secondary-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <PlusIcon className="h-4 w-4" />
                        </button>
                    </div>
                    <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                        {listed.map((bot) => (
                            <BotRow key={bot.id} bot={bot} onOpen={onSelect} onArchive={(botId) => { void archive(botId) }} archiveBusy={archiveBot.isPending} />
                        ))}
                    </ul>
                    {archiveError ? <p role="alert" className="px-2 py-1 text-xs text-red-500">{archiveError}</p> : null}
                </>
            )}
            <CreateBotDialog
                isOpen={createOpen}
                onClose={() => setCreateOpen(false)}
                api={api}
                onCreated={(bot) => {
                    setCreateOpen(false)
                    if (bot.homeChatSessionId) onSelect(bot.homeChatSessionId)
                }}
            />
        </section>
    )
}

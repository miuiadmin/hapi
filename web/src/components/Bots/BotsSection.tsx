import { useId, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { BotSummary } from '@hapi/protocol'
import { apiErrorMessage, type ApiClient } from '@/api/client'
import { invalidateBotSummaries, useBotMutations, useBots } from '@/hooks/queries/useBots'
import { botDisplayStatus, listableBots } from '@/lib/bots'
import { useTranslation } from '@/lib/use-translation'
import { BotIcon } from './BotIcon'
import { useTwoStepConfirm } from './useTwoStepConfirm'

const STATUS_TONE_CLASS = {
    normal: 'text-[var(--app-hint)]',
    warning: 'text-[var(--app-warning-text)]',
    danger: 'text-red-500'
} as const

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
 * number of things waiting on the owner. With no bot there is no block: the
 * way to make one is the robot icon in the list's toolbar (`SessionList`).
 * Renders nothing on a hub without bot routes, and nothing while the list
 * is still loading (so the block does not flash in and out). A list that
 * failed to load says so and can be retried; it must not read as "no bots".
 */
export function BotsSection({ api, onSelect }: {
    api: ApiClient | null
    /** Opens the bot's home chat like a session row does. */
    onSelect: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { bots, isLoading, error, unsupported } = useBots(api)
    const { archiveBot } = useBotMutations(api)
    const [archiveError, setArchiveError] = useState<string | null>(null)
    const headingId = useId()
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
    // Nothing to list: no block at all. Creating a bot is not done from here.
    if (listed.length === 0) return null

    return (
        <section aria-label={t('bots.section.title')} data-testid="bots-section" className="pt-1">
            <div className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1">
                <BotIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]" />
                <span id={headingId} className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--app-hint)]">
                    {t('bots.section.title')}
                </span>
            </div>
            <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                {listed.map((bot) => (
                    <BotRow key={bot.id} bot={bot} onOpen={onSelect} onArchive={(botId) => { void archive(botId) }} archiveBusy={archiveBot.isPending} />
                ))}
            </ul>
            {archiveError ? <p role="alert" className="px-2 py-1 text-xs text-red-500">{archiveError}</p> : null}
        </section>
    )
}

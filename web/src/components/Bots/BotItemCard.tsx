import { useMemo, useState } from 'react'
import type { BotItem } from '@hapi/protocol'
import { useBotItemEvents } from '@/hooks/queries/useBots'
import { botItemEventHead, isBotItemSnoozed } from '@/lib/bots'
import { formatAbsoluteDateTime, formatRelativeTime } from '@/lib/relativeTime'
import { formatScheduledTime } from '@/lib/scheduledTime'
import { useTranslation } from '@/lib/use-translation'
import { BotCommentBox } from './BotCommentBox'
import { BotItemActions } from './BotItemActions'
import { useBotLedger } from './BotLedgerContext'

const STATUS_CLASS: Record<BotItem['status'], string> = {
    planned: 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]',
    working: 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]',
    waiting: 'bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]',
    needs_you: 'bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)]',
    done: 'bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]',
    canceled: 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] line-through'
}

function SnoozeIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 5v3l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

/**
 * One ledger item: the number, title and status always; opened, the
 * background, the worker doing it, the owner's decisions (done, cancel,
 * snooze), the event log and, while it is still open, a comment box. A
 * finished or canceled item is read-only: a comment would wake the bot.
 * Failures of the decisions are shown on the tab, since the optimistic
 * edit may already have moved this card to another list.
 */
export function BotItemCard({ item, defaultExpanded = false }: { item: BotItem; defaultExpanded?: boolean }) {
    const { t } = useTranslation()
    const { api, bot, onOpenSession, sessionLabel } = useBotLedger()
    const [expanded, setExpanded] = useState(defaultExpanded)
    const { events, isLoading: eventsLoading, error: eventsError, failed: eventsFailed } = useBotItemEvents(api, bot.id, expanded ? item.id : null)
    const eventsLoadError = eventsFailed ? (eventsError ?? t('bots.ledger.loadFailed')) : null
    const sortedEvents = useMemo(() => [...events].sort((a, b) => a.seq - b.seq), [events])
    const closed = item.status === 'done' || item.status === 'canceled'
    const snoozed = isBotItemSnoozed(item)
    const workerName = item.workerSessionId ? sessionLabel(item.workerSessionId) : null

    return (
        <li
            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)]"
            aria-label={`#${item.number} ${item.title}`}
            data-testid="bot-item"
            data-item-number={item.number}
            data-status={item.status}
        >
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left"
            >
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">#{item.number}</span>
                <span className="min-w-0 flex-1 break-words text-sm text-[var(--app-fg)]">{item.title}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASS[item.status]}`}>
                    {t(`bots.ledger.itemStatus.${item.status}`)}
                </span>
            </button>
            {snoozed ? (
                <p className="flex items-center gap-1 px-3 pb-2 pl-9 text-xs text-[var(--app-hint)]">
                    <SnoozeIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>{t('bots.ledger.item.snoozedUntil', { when: formatScheduledTime(item.snoozedUntil as number) })}</span>
                </p>
            ) : null}
            {expanded ? (
                <div className="flex flex-col gap-2 border-t border-[var(--app-border)] px-3 pb-3 pt-2">
                    {item.detail ? (
                        <p className="whitespace-pre-wrap break-words text-xs text-[var(--app-fg-muted)]">{item.detail}</p>
                    ) : null}
                    {item.workerSessionId ? (
                        <button
                            type="button"
                            onClick={() => onOpenSession(item.workerSessionId as string)}
                            className="inline-flex max-w-full items-center gap-1 self-start rounded text-xs text-[var(--app-link)] hover:underline"
                        >
                            <span className="truncate">{t('bots.ledger.item.worker', { name: workerName ?? '' })}</span>
                            <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3 shrink-0" aria-hidden="true">
                                <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </button>
                    ) : null}
                    <BotItemActions item={item} />
                    <section aria-label={t('bots.ledger.item.activity')} className="flex flex-col gap-1">
                        <h4 className="text-[11px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                            {t('bots.ledger.item.activity')}
                        </h4>
                        {eventsLoading ? <p className="text-xs text-[var(--app-hint)]">{t('misc.loading')}</p> : null}
                        {eventsLoadError ? <p role="alert" className="text-xs text-red-500">{eventsLoadError}</p> : null}
                        {!eventsLoading && !eventsLoadError && sortedEvents.length === 0 ? (
                            <p className="text-xs text-[var(--app-hint)]">{t('bots.ledger.eventsEmpty')}</p>
                        ) : null}
                        {sortedEvents.length > 0 ? (
                            <ol className="flex flex-col gap-1.5">
                                {sortedEvents.map((event) => (
                                    <li key={event.id} className="text-xs">
                                        <div className="flex flex-wrap items-baseline gap-x-1.5">
                                            <span className="font-medium text-[var(--app-fg)]">{botItemEventHead(event, t)}</span>
                                            <span
                                                className="text-[var(--app-hint)]"
                                                title={formatAbsoluteDateTime(event.createdAt) ?? undefined}
                                            >
                                                {formatRelativeTime(event.createdAt, t)}
                                            </span>
                                        </div>
                                        {event.text ? (
                                            event.kind === 'comment'
                                                ? <p className="mt-0.5 whitespace-pre-wrap break-words text-[var(--app-fg)]">{event.text}</p>
                                                : <p className="whitespace-pre-wrap break-words text-[var(--app-hint)]">{event.text}</p>
                                        ) : null}
                                    </li>
                                ))}
                            </ol>
                        ) : null}
                    </section>
                    {closed ? (
                        <p className="text-[11px] text-[var(--app-hint)]">{t('bots.ledger.item.closedReadOnly')}</p>
                    ) : (
                        <BotCommentBox itemId={item.id} />
                    )}
                </div>
            ) : null}
        </li>
    )
}

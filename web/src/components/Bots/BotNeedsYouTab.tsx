import { useState } from 'react'
import type { BotItem } from '@hapi/protocol'
import { Button } from '@/components/ui/button'
import { isBotItemSnoozed, type NeedsYouEntry } from '@/lib/bots'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatScheduledTime } from '@/lib/scheduledTime'
import { useTranslation } from '@/lib/use-translation'
import { BotCommentBox, useBotComment } from './BotCommentBox'
import { BotItemActions } from './BotItemActions'
import { useBotLedger } from './BotLedgerContext'

type RequestEntry = Extract<NeedsYouEntry, { kind: 'request' }>
type QuestionEntry = Extract<NeedsYouEntry, { kind: 'question' }>

const SECTION_TITLE_CLASS = 'mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--app-hint)]'

function RequestRow({ entry }: { entry: RequestEntry }) {
    const { t } = useTranslation()
    const { onOpenSession, sessionLabel } = useBotLedger()
    return (
        <li
            className="flex items-start gap-2 rounded-lg border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] px-3 py-2"
            data-testid="bot-request"
        >
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--app-fg)]" title={entry.sessionId}>
                    {sessionLabel(entry.sessionId)}
                </div>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--app-hint)]">
                    <code className="truncate font-mono">{entry.tool}</code>
                    {entry.createdAt !== null ? (
                        <span className="shrink-0">· {formatRelativeTime(entry.createdAt, t)}</span>
                    ) : null}
                </div>
            </div>
            <Button
                type="button"
                size="sm"
                variant="destructive"
                className="shrink-0"
                onClick={() => onOpenSession(entry.sessionId, entry.requestId)}
            >
                {t('bots.ledger.goAnswer')}
            </Button>
        </li>
    )
}

/**
 * A question the bot put to its owner: answer by tapping an option or
 * writing a comment (one comment in flight at a time, from either), or
 * decide without answering: mark done, cancel, snooze.
 */
function QuestionCard({ entry, item }: { entry: QuestionEntry; item: BotItem | null }) {
    const { t } = useTranslation()
    const { onOpenSession, sessionLabel } = useBotLedger()
    const { send, pending, error, clearError } = useBotComment(entry.itemId)
    const [showBackground, setShowBackground] = useState(false)
    const [failedOption, setFailedOption] = useState<number | null>(null)
    const options = entry.ask.options ?? []
    const recommended = typeof entry.ask.recommended === 'number' ? entry.ask.recommended : null
    const detail = item?.detail ?? ''
    const snoozed = item ? isBotItemSnoozed(item) : false

    const answer = async (index: number) => {
        setFailedOption(null)
        const ok = await send(options[index].label)
        if (!ok) setFailedOption(index)
    }

    return (
        <li className="flex flex-col gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2.5" data-testid="bot-question">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--app-hint)]">
                <span className="tabular-nums">#{entry.number}</span>
                <span className="min-w-0 truncate text-[var(--app-fg)]">{entry.title}</span>
                {entry.workerSessionId ? (
                    <button
                        type="button"
                        onClick={() => onOpenSession(entry.workerSessionId as string)}
                        className="min-w-0 truncate text-[var(--app-link)] hover:underline"
                    >
                        {t('bots.ledger.item.worker', { name: sessionLabel(entry.workerSessionId) })}
                    </button>
                ) : null}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-[var(--app-fg)]">{entry.ask.question}</p>
            {snoozed && item ? (
                <p className="text-xs text-[var(--app-hint)]">
                    {t('bots.ledger.item.snoozedUntil', { when: formatScheduledTime(item.snoozedUntil as number) })}
                </p>
            ) : null}
            {detail ? (
                <div>
                    <button
                        type="button"
                        aria-expanded={showBackground}
                        onClick={() => setShowBackground((value) => !value)}
                        className="text-xs text-[var(--app-link)] hover:underline"
                    >
                        {t(showBackground ? 'bots.ledger.questionBackgroundHide' : 'bots.ledger.questionBackground')}
                    </button>
                    {showBackground ? (
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-[var(--app-fg-muted)]">{detail}</p>
                    ) : null}
                </div>
            ) : null}
            {options.length > 0 ? (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('bots.ledger.options')}>
                    {options.map((option, index) => {
                        const isRecommended = recommended !== null && recommended === index
                        const failed = failedOption === index
                        return (
                            <button
                                key={`${entry.itemId}:${index}`}
                                type="button"
                                aria-label={isRecommended ? `${option.label} (${t('bots.ledger.recommended')})` : option.label}
                                disabled={pending}
                                onClick={() => { void answer(index) }}
                                className={`inline-flex max-w-full items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                    failed
                                        ? 'border-red-400 text-red-500'
                                        : isRecommended
                                            ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                            : 'border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                }`}
                            >
                                <span className="truncate">{option.label}</span>
                                {isRecommended ? (
                                    <span className="shrink-0 rounded bg-[var(--app-link)] px-1 text-[10px] font-semibold uppercase text-white">
                                        {t('bots.ledger.recommended')}
                                    </span>
                                ) : null}
                            </button>
                        )
                    })}
                </div>
            ) : null}
            {error ? (
                <p role="alert" className="text-xs text-red-500" data-testid={`bot-comment-error-${entry.itemId}`}>
                    {error}
                    <button
                        type="button"
                        onClick={clearError}
                        className="ml-2 underline hover:text-red-600"
                        aria-label={t('button.dismiss')}
                    >
                        {t('button.dismiss')}
                    </button>
                </p>
            ) : null}
            <BotItemActions item={{ id: entry.itemId, status: item?.status ?? 'needs_you', snoozedUntil: item?.snoozedUntil ?? null }} quiet />
            <BotCommentBox itemId={entry.itemId} />
        </li>
    )
}

/**
 * "Needs you": approvals and other requests waiting in the bot's chat or
 * its workers' come first (answer them in that session), then the bot's
 * own questions (answer here).
 */
export function BotNeedsYouTab({ entries, items }: { entries: NeedsYouEntry[]; items: BotItem[] }) {
    const { t } = useTranslation()
    const { bot } = useBotLedger()
    const requests = entries.filter((entry): entry is RequestEntry => entry.kind === 'request')
    const questions = entries.filter((entry): entry is QuestionEntry => entry.kind === 'question')
    const itemsById = new Map(items.map((item) => [item.id, item]))

    if (entries.length === 0) {
        return <p className="px-3 py-6 text-center text-sm text-[var(--app-hint)]">{t('bots.ledger.needsYouEmpty')}</p>
    }

    return (
        <div className="flex flex-col gap-4 p-3">
            {requests.length > 0 ? (
                <section aria-label={t('bots.ledger.requests')}>
                    <h3 className={SECTION_TITLE_CLASS}>
                        {t('bots.ledger.requests')}
                        <span className="ml-1 tabular-nums">({requests.length})</span>
                    </h3>
                    <ul className="flex flex-col gap-2">
                        {requests.map((entry) => (
                            <RequestRow key={`${entry.sessionId}:${entry.requestId}`} entry={entry} />
                        ))}
                    </ul>
                </section>
            ) : null}
            <section aria-label={t('bots.ledger.questions', { name: bot.name })}>
                <h3 className={SECTION_TITLE_CLASS}>
                    {t('bots.ledger.questions', { name: bot.name })}
                    {questions.length > 0 ? <span className="ml-1 tabular-nums">({questions.length})</span> : null}
                </h3>
                {questions.length === 0 ? (
                    <p className="text-xs text-[var(--app-hint)]">{t('bots.ledger.questionsEmpty')}</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {questions.map((entry) => (
                            <QuestionCard key={entry.itemId} entry={entry} item={itemsById.get(entry.itemId) ?? null} />
                        ))}
                    </ul>
                )}
            </section>
        </div>
    )
}

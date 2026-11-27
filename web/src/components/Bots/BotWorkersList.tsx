import { useState } from 'react'
import type { BotWorker } from '@hapi/protocol'
import { botWorkersSummaryKey } from '@/lib/bots'
import { useTranslation } from '@/lib/use-translation'
import { useBotLedger } from './BotLedgerContext'

export type BotWorkerActivity = 'busy' | 'idle' | 'stopped'

/** A worker that is not running cannot be busy, whatever it last reported. */
export function botWorkerActivity(worker: Pick<BotWorker, 'active' | 'thinking'>): BotWorkerActivity {
    if (!worker.active) return 'stopped'
    return worker.thinking ? 'busy' : 'idle'
}

const ACTIVITY_DOT_CLASS: Record<BotWorkerActivity, string> = {
    busy: 'bg-[var(--app-link)]',
    idle: 'bg-[var(--app-hint)]',
    stopped: 'bg-[var(--app-border)]'
}

/**
 * The sessions working for the bot right now, collapsed under the ledger:
 * who is busy, who is idle, and who is waiting on a request. Tap a row to
 * open that session.
 */
export function BotWorkersList({ workers }: { workers: BotWorker[] }) {
    const { t } = useTranslation()
    const { onOpenSession, sessionLabel } = useBotLedger()
    const [open, setOpen] = useState(false)
    const waiting = workers.reduce((sum, worker) => sum + (worker.pendingRequests > 0 ? 1 : 0), 0)
    const summary = t(botWorkersSummaryKey(workers.length, waiting), { count: workers.length, waiting })

    return (
        <section
            aria-label={t('bots.ledger.workers')}
            className="shrink-0 border-t border-[var(--app-border)]"
            data-testid="bot-workers"
        >
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
            >
                <svg viewBox="0 0 16 16" fill="none" className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
                    <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="min-w-0 flex-1 truncate">{summary}</span>
                {waiting > 0 ? (
                    <span className="shrink-0 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums">
                        <span className="sr-only">{t('bots.ledger.workersWaiting', { count: waiting })}</span>
                        <span aria-hidden="true">{waiting}</span>
                    </span>
                ) : null}
            </button>
            {open ? (
                workers.length === 0 ? (
                    <p className="px-3 pb-3 text-xs text-[var(--app-hint)]">{t('bots.ledger.workersEmpty')}</p>
                ) : (
                    <ul className="max-h-48 overflow-y-auto px-2 pb-2">
                        {workers.map((worker) => {
                            const activity = botWorkerActivity(worker)
                            const name = sessionLabel(worker.sessionId)
                            return (
                                <li key={worker.sessionId}>
                                    <button
                                        type="button"
                                        onClick={() => onOpenSession(worker.sessionId)}
                                        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--app-secondary-bg)]"
                                    >
                                        <span className={`h-2 w-2 shrink-0 rounded-full ${ACTIVITY_DOT_CLASS[activity]}`} aria-hidden="true" />
                                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-fg)]">{name}</span>
                                        {worker.itemNumber !== null ? (
                                            <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">
                                                {t('bots.ledger.worker.item', { number: worker.itemNumber })}
                                            </span>
                                        ) : null}
                                        <span className={`shrink-0 text-[11px] ${activity === 'stopped' ? 'text-[var(--app-hint)]' : 'text-[var(--app-fg-muted)]'}`}>
                                            {t(`bots.ledger.worker.${activity}`)}
                                        </span>
                                        {worker.pendingRequests > 0 ? (
                                            <span className="shrink-0 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums">
                                                <span className="sr-only">{t('bots.ledger.worker.pendingRequests', { count: worker.pendingRequests })}</span>
                                                <span aria-hidden="true">{worker.pendingRequests}</span>
                                            </span>
                                        ) : null}
                                    </button>
                                </li>
                            )
                        })}
                    </ul>
                )
            ) : null}
        </section>
    )
}

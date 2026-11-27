import { useState } from 'react'
import type { BotItem } from '@hapi/protocol'
import { isBotItemSnoozed, snoozeOneHourFrom, tomorrowNineAm } from '@/lib/bots'
import { useTranslation } from '@/lib/use-translation'
import { useBotLedger } from './BotLedgerContext'
import { useTwoStepConfirm } from './useTwoStepConfirm'

const OUTLINE_BUTTON_CLASS = 'inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md border border-[var(--app-border)] bg-transparent px-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:pointer-events-none disabled:opacity-50'
const QUIET_BUTTON_CLASS = 'inline-flex items-center justify-center whitespace-nowrap rounded-md px-2 py-1 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:pointer-events-none disabled:opacity-50'
const CHOICE_BUTTON_CLASS = 'rounded-md border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40'

/**
 * The owner's decisions on one item: mark done, cancel, snooze (an hour,
 * or tomorrow nine), and stop a snooze. Done and cancel are final on the
 * hub, so each takes a second click; snooze is not and goes at once.
 * The same row serves the item cards and the questions on "Needs you".
 */
export function BotItemActions({ item, quiet = false }: {
    item: Pick<BotItem, 'id' | 'status' | 'snoozedUntil'>
    /** On a question the row sits under the options and must not compete with them. */
    quiet?: boolean
}) {
    const { t } = useTranslation()
    const { patchItem, isItemBusy } = useBotLedger()
    const [snoozeOpen, setSnoozeOpen] = useState(false)
    const busy = isItemBusy(item.id)
    const closed = item.status === 'done' || item.status === 'canceled'
    const snoozed = isBotItemSnoozed(item)
    const buttonClass = quiet ? QUIET_BUTTON_CLASS : OUTLINE_BUTTON_CLASS

    const done = useTwoStepConfirm(() => { void patchItem(item.id, { status: 'done' }) })
    const cancel = useTwoStepConfirm(() => { void patchItem(item.id, { status: 'canceled' }) })

    if (closed) return null

    return (
        <div className="flex flex-col gap-1.5" data-testid={`bot-item-actions-${item.id}`}>
            <div className="flex flex-wrap items-center gap-1.5">
                <button
                    type="button"
                    disabled={busy}
                    aria-label={done.armed ? t('bots.ledger.item.confirmDone') : t('bots.ledger.item.markDone')}
                    onClick={done.onClick}
                    onBlur={done.onBlur}
                    className={`${buttonClass}${done.armed ? ' border-red-500 text-red-600' : ''}`}
                >
                    {done.armed ? t('bots.ledger.item.confirmDone') : t('bots.ledger.item.markDone')}
                </button>
                <button
                    type="button"
                    disabled={busy}
                    aria-label={cancel.armed ? t('bots.ledger.item.confirmCancel') : t('bots.ledger.item.cancel')}
                    onClick={cancel.onClick}
                    onBlur={cancel.onBlur}
                    className={`${buttonClass}${cancel.armed ? ' border-red-500 text-red-600' : ''}`}
                >
                    {cancel.armed ? t('bots.ledger.item.confirmCancel') : t('bots.ledger.item.cancel')}
                </button>
                {snoozed ? (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => { void patchItem(item.id, { snoozedUntil: null }) }}
                        className={buttonClass}
                    >
                        {t('bots.ledger.item.unsnooze')}
                    </button>
                ) : (
                    <button
                        type="button"
                        disabled={busy}
                        aria-expanded={snoozeOpen}
                        onClick={() => setSnoozeOpen((value) => !value)}
                        className={buttonClass}
                    >
                        {t('bots.ledger.item.snooze')}
                    </button>
                )}
            </div>
            {snoozeOpen && !snoozed ? (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('bots.ledger.item.snooze')}>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                            setSnoozeOpen(false)
                            void patchItem(item.id, { snoozedUntil: snoozeOneHourFrom() })
                        }}
                        className={CHOICE_BUTTON_CLASS}
                    >
                        {t('bots.ledger.item.snoozeHour')}
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                            setSnoozeOpen(false)
                            void patchItem(item.id, { snoozedUntil: tomorrowNineAm() })
                        }}
                        className={CHOICE_BUTTON_CLASS}
                    >
                        {t('bots.ledger.item.snoozeMorning')}
                    </button>
                </div>
            ) : null}
        </div>
    )
}

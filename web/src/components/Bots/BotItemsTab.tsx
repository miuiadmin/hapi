import { useId, useState } from 'react'
import type { BotItem } from '@hapi/protocol'
import { BOT_ITEM_DETAIL_MAX_LENGTH, BOT_ITEM_TITLE_MAX_LENGTH } from '@hapi/protocol'
import { apiErrorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { validateBotItemDetail, validateBotItemTitle, type BotItemDraftError } from '@/lib/bots'
import { useTranslation } from '@/lib/use-translation'
import { BotItemCard } from './BotItemCard'
import { useBotLedger } from './BotLedgerContext'

const FIELD_CLASS = 'w-full min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50'

const ITEM_ERROR_KEY: Record<BotItemDraftError, string> = {
    titleRequired: 'bots.ledger.error.titleRequired',
    titleTooLong: 'bots.ledger.error.titleTooLong',
    detailTooLong: 'bots.ledger.error.detailTooLong',
    commentRequired: 'bots.ledger.error.commentRequired',
    commentTooLong: 'bots.ledger.error.commentTooLong'
}

/** Draft ids of the new-item form, kept by the ledger so a tab switch does not lose them. */
export const NEW_ITEM_TITLE_DRAFT_ID = 'new-item:title'
export const NEW_ITEM_DETAIL_DRAFT_ID = 'new-item:detail'

/** The owner's way to put something on the ledger themselves. */
export function NewItemForm({ onDone }: { onDone: () => void }) {
    const { t } = useTranslation()
    const { api, bot, drafts, setDraft, createItem } = useBotLedger()
    const idPrefix = useId()
    const title = drafts[NEW_ITEM_TITLE_DRAFT_ID] ?? ''
    const detail = drafts[NEW_ITEM_DETAIL_DRAFT_ID] ?? ''
    const [error, setError] = useState<string | null>(null)

    const submit = async () => {
        const titleProblem = validateBotItemTitle(title)
        const detailProblem = validateBotItemDetail(detail)
        const problem = titleProblem ?? detailProblem
        if (problem) {
            const count = problem === 'titleTooLong'
                ? BOT_ITEM_TITLE_MAX_LENGTH
                : problem === 'detailTooLong'
                    ? BOT_ITEM_DETAIL_MAX_LENGTH
                    : undefined
            setError(count === undefined ? t(ITEM_ERROR_KEY[problem]) : t(ITEM_ERROR_KEY[problem], { count }))
            return
        }
        setError(null)
        try {
            await createItem.mutateAsync({
                botId: bot.id,
                title: title.trim(),
                ...(detail.trim() ? { detail: detail.trim() } : {})
            })
            setDraft(NEW_ITEM_TITLE_DRAFT_ID, '')
            setDraft(NEW_ITEM_DETAIL_DRAFT_ID, '')
            onDone()
        } catch (cause) {
            setError(apiErrorMessage(cause, t('bots.ledger.item.actionFailed')))
        }
    }

    return (
        <form
            className="flex flex-col gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
            aria-label={t('bots.ledger.newItem')}
            onSubmit={(event) => {
                event.preventDefault()
                void submit()
            }}
        >
            <div>
                <label className="mb-1 block text-xs font-medium text-[var(--app-hint)]" htmlFor={`${idPrefix}-title`}>
                    {t('bots.ledger.itemTitle')}
                </label>
                <input
                    id={`${idPrefix}-title`}
                    type="text"
                    value={title}
                    placeholder={t('bots.ledger.itemTitlePlaceholder')}
                    disabled={createItem.isPending}
                    onChange={(event) => {
                        setDraft(NEW_ITEM_TITLE_DRAFT_ID, event.target.value)
                        setError(null)
                    }}
                    className={FIELD_CLASS}
                />
            </div>
            <div>
                <label className="mb-1 block text-xs font-medium text-[var(--app-hint)]" htmlFor={`${idPrefix}-detail`}>
                    {t('bots.ledger.itemDetail')}
                </label>
                <textarea
                    id={`${idPrefix}-detail`}
                    rows={2}
                    value={detail}
                    disabled={createItem.isPending}
                    onChange={(event) => {
                        setDraft(NEW_ITEM_DETAIL_DRAFT_ID, event.target.value)
                        setError(null)
                    }}
                    className={`${FIELD_CLASS} resize-y`}
                />
            </div>
            {error ? <p role="alert" className="text-xs text-red-500">{error}</p> : null}
            <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={createItem.isPending}>
                    {t('bots.ledger.itemAdd')}
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={createItem.isPending} onClick={onDone}>
                    {t('button.cancel')}
                </Button>
            </div>
        </form>
    )
}

/**
 * The two list tabs. "In progress" carries the owner's "New item" entry;
 * both list the items newest first. The form stays mounted while the tab
 * is, so a tab switch keeps what was typed.
 */
export function BotItemsTab({ items, done, adding, onAddingChange }: {
    items: BotItem[]
    done: boolean
    adding: boolean
    onAddingChange: (adding: boolean) => void
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-2 p-3">
            {!done ? (
                adding
                    ? <NewItemForm onDone={() => onAddingChange(false)} />
                    : (
                        <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => onAddingChange(true)}>
                            {t('bots.ledger.newItem')}
                        </Button>
                    )
            ) : null}
            {items.length === 0 && (done || !adding) ? (
                <p className="py-6 text-center text-sm text-[var(--app-hint)]">
                    {t(done ? 'bots.ledger.itemsEmpty.done' : 'bots.ledger.itemsEmpty.inProgress')}
                </p>
            ) : null}
            {items.length > 0 ? (
                <ul className="flex flex-col gap-2">
                    {items.map((item) => (
                        <BotItemCard key={item.id} item={item} />
                    ))}
                </ul>
            ) : null}
        </div>
    )
}

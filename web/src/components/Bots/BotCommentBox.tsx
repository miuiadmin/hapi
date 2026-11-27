import { useCallback, useState } from 'react'
import { BOT_ITEM_COMMENT_MAX_LENGTH } from '@hapi/protocol'
import { Button } from '@/components/ui/button'
import { validateBotItemComment } from '@/lib/bots'
import { useTranslation } from '@/lib/use-translation'
import { useBotLedger } from './BotLedgerContext'

const FIELD_CLASS = 'min-h-[40px] flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50'

/** The draft id of an item's free-text comment, kept by the ledger while it is open. */
export function commentDraftId(itemId: string): string {
    return `comment:${itemId}`
}

/**
 * Posts one owner comment on an item through the ledger's one comment
 * mutation, so an option tap and the box cannot both be in flight for
 * the same item. The hub relays the comment into the home chat as a new
 * message and, when the item was a question, moves it back to "working".
 * Resolves false (and sets `error`) when the text or the hub refuses it.
 */
export function useBotComment(itemId: string): {
    send: (text: string) => Promise<boolean>
    pending: boolean
    error: string | null
    clearError: () => void
} {
    const ledger = useBotLedger()
    const { t } = useTranslation()
    const [error, setError] = useState<string | null>(null)

    const send = useCallback(async (text: string) => {
        const problem = validateBotItemComment(text)
        if (problem) {
            setError(problem === 'commentRequired'
                ? t('bots.ledger.error.commentRequired')
                : t('bots.ledger.error.commentTooLong', { count: BOT_ITEM_COMMENT_MAX_LENGTH }))
            return false
        }
        const result = await ledger.sendComment(itemId, text.trim())
        if (!result.ok) {
            setError(result.error)
            return false
        }
        setError(null)
        return true
    }, [ledger, itemId, t])

    const clearError = useCallback(() => setError(null), [])

    return { send, pending: ledger.isCommentPending(itemId), error, clearError }
}

/** Free-text comment under an item or a question. */
export function BotCommentBox({ itemId, disabled = false, placeholder }: {
    itemId: string
    disabled?: boolean
    placeholder?: string
}) {
    const { t } = useTranslation()
    const { drafts, setDraft } = useBotLedger()
    const { send, pending, error, clearError } = useBotComment(itemId)
    const draftId = commentDraftId(itemId)
    const text = drafts[draftId] ?? ''

    const submit = async () => {
        if (!(await send(text))) return
        setDraft(draftId, '')
    }

    return (
        <div className="flex flex-col gap-1" data-testid={`bot-comment-box-${itemId}`}>
            {error ? <p role="alert" className="text-xs text-red-500">{error}</p> : null}
            <div className="flex items-end gap-2">
                <textarea
                    rows={2}
                    value={text}
                    aria-label={placeholder ?? t('bots.ledger.commentLabel')}
                    placeholder={placeholder ?? t('bots.ledger.commentPlaceholder')}
                    disabled={disabled || pending}
                    onChange={(event) => {
                        clearError()
                        setDraft(draftId, event.target.value)
                    }}
                    onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault()
                            void submit()
                        }
                    }}
                    className={`${FIELD_CLASS} resize-y`}
                />
                <Button
                    type="button"
                    size="sm"
                    className="shrink-0"
                    disabled={disabled || pending || !text.trim()}
                    onClick={() => { void submit() }}
                >
                    {t('bots.ledger.sendComment')}
                </Button>
            </div>
        </div>
    )
}

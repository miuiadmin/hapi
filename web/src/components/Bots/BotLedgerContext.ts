import { createContext, useContext } from 'react'
import type { BotSummary, UpdateBotItemRequest } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { useBotMutations } from '@/hooks/queries/useBots'

/** What a write on the ledger resolves with; `error` is what to show (the hub's own words when it has them). */
export type LedgerActionResult = { ok: true } | { ok: false; error: string }

export type BotLedgerContextValue = {
    api: ApiClient | null
    bot: BotSummary
    /** Opens a session; with a request id the session page jumps to that pending request. */
    onOpenSession: (sessionId: string, requestId?: string) => void
    /** A session's display name: the bot's own chat, a worker's name, else a short id. */
    sessionLabel: (sessionId: string) => string
    /** Free-text drafts by id (comments, the new-item form), kept while the ledger is open so switching tabs loses nothing. */
    drafts: Readonly<Record<string, string>>
    setDraft: (id: string, text: string) => void
    /** Changes an item's status or snooze. A failure is reported on the tab, not in the item's card, which the optimistic edit may already have removed. */
    patchItem: (itemId: string, changes: UpdateBotItemRequest) => Promise<LedgerActionResult>
    isItemBusy: (itemId: string) => boolean
    /** Posts a comment on an item: an answer to its question, or a note. */
    sendComment: (itemId: string, text: string) => Promise<LedgerActionResult>
    /** One comment at a time per item, whichever control (option or box) sent it. */
    isCommentPending: (itemId: string) => boolean
    /** The new-item form's mutation, shared so its failure shows in the form. */
    createItem: ReturnType<typeof useBotMutations>['createItem']
}

export const BotLedgerContext = createContext<BotLedgerContextValue | null>(null)

export function useBotLedger(): BotLedgerContextValue {
    const context = useContext(BotLedgerContext)
    if (!context) throw new Error('useBotLedger must be used inside a bot ledger')
    return context
}

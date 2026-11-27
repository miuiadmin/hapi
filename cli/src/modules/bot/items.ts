/**
 * The bot's ledger of items (`bot_items` on the hub): things to deliver and
 * decisions to make. REST, all under `/api`:
 *   GET    /bots/:botId/items
 *   POST   /bots/:botId/items
 *   PATCH  /bots/:botId/items/:itemId
 *   POST   /bots/:botId/items/:itemId/ask
 *   POST   /bots/:botId/items/:itemId/comments
 *   GET    /bots/:botId/items/:itemId/events
 *
 * An item is addressed by its number or its id; the hub accepts both in the
 * path, so the reference travels as given. Agent calls add `fromSessionId`
 * so the hub can check the caller is the bot's home chat.
 */

import { z } from 'zod'
import {
    BOT_ITEM_ASK_MAX_OPTIONS,
    BOT_ITEM_ASK_OPTION_MAX_LENGTH,
    BOT_ITEM_ASK_QUESTION_MAX_LENGTH,
    BOT_ITEM_COMMENT_MAX_LENGTH,
    BOT_ITEM_DETAIL_MAX_LENGTH,
    BOT_ITEM_TITLE_MAX_LENGTH,
    BotItemEventSchema,
    BotItemSchema,
    type BotItem,
    type BotItemAsk,
    type BotItemAskRequest,
    type BotItemCommentRequest,
    type BotItemEvent,
    type BotItemStatus,
    type CreateBotItemRequest,
    type UpdateBotItemRequest
} from '@hapi/protocol'
import { BotClientError, botAuthHeaders, botRequest, type BotClientOptions } from './botClient'
import { formatWhen } from './time'

/** An item by number (`3`, `#3`) or by id; see `normalizeItemRef`. */
export type BotItemRef = string | number

/** The hub is authoritative; these bounds only fail fast with a clear message. */
export const BOT_ITEM_LIMITS = {
    title: BOT_ITEM_TITLE_MAX_LENGTH,
    detail: BOT_ITEM_DETAIL_MAX_LENGTH,
    comment: BOT_ITEM_COMMENT_MAX_LENGTH,
    askQuestion: BOT_ITEM_ASK_QUESTION_MAX_LENGTH,
    askOptions: BOT_ITEM_ASK_MAX_OPTIONS,
    askOption: BOT_ITEM_ASK_OPTION_MAX_LENGTH
} as const

export const BOT_ITEM_STATUSES: readonly BotItemStatus[] = ['planned', 'working', 'waiting', 'needs_you', 'done', 'canceled']

/** An item the bot or the owner still has work on. */
export function isBotItemOpen(item: Pick<BotItem, 'status'>): boolean {
    return item.status !== 'done' && item.status !== 'canceled'
}

/** `#12` for an item; the number is what the owner and the bot refer to it by. */
export function botItemLabel(item: Pick<BotItem, 'number'>): string {
    return `#${item.number}`
}

/**
 * Accept an item as written by a person or a model: `3`, `#3` (the label the
 * tools print) or the item id. Numbers come back as numbers.
 */
export function normalizeItemRef(ref: BotItemRef): BotItemRef {
    const text = String(ref).trim().replace(/^#+/, '').trim()
    return /^\d+$/.test(text) ? Number(text) : text
}

export function encodeItemRef(ref: BotItemRef): string {
    return encodeURIComponent(String(normalizeItemRef(ref)))
}

export function withFromSession<T extends object>(body: T, fromSessionId?: string): T {
    const id = (fromSessionId ?? '').trim()
    return id ? { ...body, fromSessionId: id } : body
}

const BotItemResponseSchema = z.object({ item: BotItemSchema })
const BotItemListResponseSchema = z.object({ items: z.array(BotItemSchema) })
const BotItemEventsResponseSchema = z.object({ events: z.array(BotItemEventSchema) })
const BotItemCommentResponseSchema = z.object({
    item: BotItemSchema.optional(),
    event: BotItemEventSchema.optional()
})

const itemsPath = (botId: string) => `/api/bots/${encodeURIComponent(botId)}/items`
const itemPath = (botId: string, itemId: BotItemRef) => `${itemsPath(botId)}/${encodeItemRef(itemId)}`

export type BotItemRequestOptions = BotClientOptions & { botId: string; fromSessionId?: string }

export async function listItems(options: BotItemRequestOptions): Promise<BotItem[]> {
    const botId = options.botId.trim()
    if (!botId) throw new BotClientError('bad_args', 'bot id is required')
    return botRequest(options, {
        action: 'list items',
        request: async ({ jwt, http }) => http.get(itemsPath(botId), {
            headers: botAuthHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }),
        parse: (data) => {
            const parsed = BotItemListResponseSchema.parse(data)
            return [...parsed.items].sort((a, b) => b.number - a.number)
        }
    })
}

export async function createItem(
    options: BotItemRequestOptions & { body: CreateBotItemRequest }
): Promise<BotItem> {
    return botRequest(options, {
        action: 'create item',
        request: async ({ jwt, http }) => http.post(itemsPath(options.botId), withFromSession(options.body, options.fromSessionId), {
            headers: botAuthHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }),
        parse: (data) => BotItemResponseSchema.parse(data).item
    })
}

export async function updateItem(
    options: BotItemRequestOptions & { itemId: BotItemRef; body: UpdateBotItemRequest }
): Promise<BotItem> {
    return botRequest(options, {
        action: `update item ${options.itemId}`,
        notFoundMessage: `no item ${options.itemId}`,
        request: async ({ jwt, http }) => http.patch(itemPath(options.botId, options.itemId), withFromSession(options.body, options.fromSessionId), {
            headers: botAuthHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }),
        parse: (data) => BotItemResponseSchema.parse(data).item
    })
}

export async function askItem(
    options: BotItemRequestOptions & { itemId: BotItemRef; body: Omit<BotItemAskRequest, 'fromSessionId'> }
): Promise<BotItem> {
    return botRequest(options, {
        action: `ask about item ${options.itemId}`,
        notFoundMessage: `no item ${options.itemId}`,
        request: async ({ jwt, http }) => http.post(`${itemPath(options.botId, options.itemId)}/ask`, withFromSession(options.body, options.fromSessionId), {
            headers: botAuthHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }),
        parse: (data) => BotItemResponseSchema.parse(data).item
    })
}

export type BotItemCommentResult = { item: BotItem | null; event: BotItemEvent | null }

export async function commentItem(
    options: BotItemRequestOptions & { itemId: BotItemRef; body: BotItemCommentRequest }
): Promise<BotItemCommentResult> {
    return botRequest(options, {
        action: `comment on item ${options.itemId}`,
        notFoundMessage: `no item ${options.itemId}`,
        request: async ({ jwt, http }) => http.post(`${itemPath(options.botId, options.itemId)}/comments`, withFromSession(options.body, options.fromSessionId), {
            headers: botAuthHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }),
        parse: (data) => {
            const parsed = BotItemCommentResponseSchema.parse(data)
            return { item: parsed.item ?? null, event: parsed.event ?? null }
        }
    })
}

export async function listItemEvents(options: BotItemRequestOptions & { itemId: BotItemRef }): Promise<BotItemEvent[]> {
    return botRequest(options, {
        action: `list events of item ${options.itemId}`,
        notFoundMessage: `no item ${options.itemId}`,
        request: async ({ jwt, http }) => http.get(`${itemPath(options.botId, options.itemId)}/events`, {
            headers: botAuthHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }),
        parse: (data) => BotItemEventsResponseSchema.parse(data).events
    })
}

// ── Question validation ──────────────────────────────────────────────────

/** Tool-layer question: options are plain labels; the contract wants `{ label }`. */
export type BotItemAskInput = {
    question: string
    options?: string[]
    recommended?: number | null
}

export function normalizeAsk(input: BotItemAskInput): BotItemAsk {
    const question = input.question.trim()
    if (!question) {
        throw new BotClientError('bad_args', 'ask.question is required')
    }
    if (question.length > BOT_ITEM_LIMITS.askQuestion) {
        throw new BotClientError('bad_args', `ask.question must be at most ${BOT_ITEM_LIMITS.askQuestion} characters`)
    }
    const labels = (input.options ?? []).map((label) => label.trim())
    if (labels.length > BOT_ITEM_LIMITS.askOptions) {
        throw new BotClientError('bad_args', `ask.options accepts at most ${BOT_ITEM_LIMITS.askOptions} options`)
    }
    labels.forEach((label, index) => {
        if (!label) {
            throw new BotClientError('bad_args', `ask.options[${index}] must not be blank`)
        }
        if (label.length > BOT_ITEM_LIMITS.askOption) {
            throw new BotClientError('bad_args', `ask.options[${index}] must be at most ${BOT_ITEM_LIMITS.askOption} characters`)
        }
    })
    const recommended = input.recommended ?? null
    if (recommended !== null) {
        if (!Number.isInteger(recommended) || recommended < 0) {
            throw new BotClientError('bad_args', 'ask.recommended must be a zero-based option index')
        }
        if (labels.length === 0) {
            throw new BotClientError('bad_args', 'ask.recommended needs ask.options')
        }
        if (recommended >= labels.length) {
            throw new BotClientError('bad_args', `ask.recommended=${recommended} is out of range for ${labels.length} option(s)`)
        }
    }
    return {
        question,
        ...(labels.length > 0 ? { options: labels.map((label) => ({ label })) } : {}),
        ...(recommended !== null ? { recommended } : {})
    }
}

// ── Agent-readable text ──────────────────────────────────────────────────

export function formatAskText(ask: BotItemAsk | null | undefined): string {
    if (!ask) return ''
    const lines = [`ask: ${ask.question}`]
    if (ask.options && ask.options.length > 0) {
        lines.push(`  options: ${ask.options.map((option, index) => `(${index}) ${option.label}`).join('  ')}`)
        if (typeof ask.recommended === 'number' && ask.options[ask.recommended]) {
            lines.push(`  recommended: (${ask.recommended}) ${ask.options[ask.recommended]!.label}`)
        }
    }
    return lines.join('\n')
}

/** One compact line per item: number, status, title, then what matters for triage. */
export function formatBotItemLine(item: BotItem, now: number = Date.now()): string {
    const parts = [`${botItemLabel(item)} [${item.status}] ${item.title}`]
    const marks: string[] = []
    if (item.workerSessionId) marks.push(`worker=${item.workerSessionId.slice(0, 8)}`)
    if (item.snoozedUntil) marks.push(`snoozed until ${formatWhen(item.snoozedUntil, now)}`)
    if (item.status === 'needs_you' && item.ask) {
        marks.push(`waiting on owner: ${item.ask.question}`)
    }
    return parts[0]! + (marks.length > 0 ? `  (${marks.join('; ')})` : '')
}

export function formatBotItemList(items: BotItem[], options: { all?: boolean; now?: number } = {}): string {
    const now = options.now ?? Date.now()
    const shown = options.all ? items : items.filter(isBotItemOpen)
    const openCount = items.filter(isBotItemOpen).length
    if (shown.length === 0) {
        return options.all
            ? 'No items.'
            : openCount === 0 && items.length > 0
                ? `No open items (${items.length} finished; use all=true to see them).`
                : 'No open items.'
    }
    const header = options.all
        ? `${items.length} item(s), ${openCount} open:`
        : `${shown.length} open item(s):`
    return [header, ...shown.map((item) => `  ${formatBotItemLine(item, now)}`)].join('\n')
}

export function formatBotItemDetail(item: BotItem, events: BotItemEvent[], now: number = Date.now()): string {
    const lines = [
        formatBotItemLine(item, now),
        `  id: ${item.id}`,
        `  worker: ${item.workerSessionId ?? '(none)'}`,
        `  snoozed until: ${item.snoozedUntil ? formatWhen(item.snoozedUntil, now) : '(none)'}`,
        `  updated: ${formatWhen(item.updatedAt, now)}`
    ]
    if (item.detail.trim()) {
        lines.push('  detail:')
        for (const line of item.detail.trimEnd().split('\n')) lines.push(`    ${line}`)
    }
    const ask = formatAskText(item.ask)
    if (ask) {
        lines.push('  ' + ask.split('\n').join('\n  '))
    }
    lines.push(`  events (${events.length}):`)
    if (events.length === 0) {
        lines.push('    (none)')
    }
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
        const text = event.text.replace(/\s+/g, ' ').trim()
        const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text
        lines.push(`    ${formatWhen(event.createdAt, now)} ${event.kind} by ${event.actor}${snippet ? `: ${snippet}` : ''}`)
    }
    return lines.join('\n')
}

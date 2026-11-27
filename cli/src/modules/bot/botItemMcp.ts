/**
 * MCP `bot_item`: the bot's ledger of deliverables and decisions.
 * Same discovery class as ping_peer / session_job — a tool catalog entry.
 *
 * Registered only in a bot's home chat (`client.botId`). One item per
 * deliverable and per decision; `ask` puts an item to the owner as a
 * structured question and ends the bot's turn until the owner comments.
 * Shell twin: `hapi item`.
 */

import { z } from 'zod'
import type { AxiosInstance } from 'axios'
import {
    BOT_ITEM_ASK_MAX_OPTIONS,
    BOT_ITEM_ASK_OPTION_MAX_LENGTH,
    BOT_ITEM_ASK_QUESTION_MAX_LENGTH,
    BOT_ITEM_COMMENT_MAX_LENGTH,
    BOT_ITEM_DETAIL_MAX_LENGTH,
    BOT_ITEM_TITLE_MAX_LENGTH,
    type BotItem,
    type BotItemStatus
} from '@hapi/protocol'
import {
    BOT_ITEM_STATUSES,
    askItem,
    commentItem,
    createItem,
    formatAskText,
    formatBotItemDetail,
    formatBotItemList,
    formatBotItemLine,
    listItemEvents,
    listItems,
    normalizeAsk,
    normalizeItemRef,
    updateItem
} from './items'
import { BotClientError, botErrorMessage, createBotAuthSource, type BotAuthSource } from './botClient'
import { formatWhen } from './time'

export const BOT_ITEM_TOOL_NAME = 'bot_item'

/** Written for selection: what an item is for, when to ask, that delegating ends the turn. */
export const BOT_ITEM_TOOL_DESCRIPTION = [
    'Your ledger: one item per deliverable and per decision you are responsible for. Bot home chat only.',
    'add: when you take work on (title = the deliverable; detail = context and what counts as done); attach the worker session once opened (set workerSessionId).',
    'done / set: write the result back into the item (detail) and mark it done when it lands; status working or waiting as work moves.',
    'ask: put a decision to your owner — preferences, spending, irreversible actions, what you cannot settle — with the background in detail, the options and your recommendation (at most five open at a time). The owner is notified; their comment comes back as a new message. End your turn after asking.',
    'list (open items by default; all=true adds finished), show (detail + event log), comment (a note on the record).',
    'Not for todos you finish within this turn.'
].join(' ')

const CreateStatusSchema = z.enum(['planned', 'working'])

export const botItemInputSchema: z.ZodTypeAny = z.object({
    action: z.enum(['add', 'set', 'ask', 'comment', 'list', 'show', 'done']).describe(
        'add=set|ask|comment|list|show|done'
    ),
    itemId: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional().describe(
        'Item number (#) or item id. Required for set / ask / comment / show / done.'
    ),
    title: z.string().trim().min(1).max(BOT_ITEM_TITLE_MAX_LENGTH).optional().describe('Short deliverable or decision title (add, set)'),
    detail: z.string().max(BOT_ITEM_DETAIL_MAX_LENGTH).optional().describe('Context, scope and what counts as done; the result once it lands'),
    status: z.enum([...BOT_ITEM_STATUSES]).optional().describe('planned | working | waiting | needs_you | done | canceled (add: planned|working only)'),
    ask: z.object({
        question: z.string().trim().min(1).max(BOT_ITEM_ASK_QUESTION_MAX_LENGTH),
        options: z.array(z.string().trim().min(1).max(BOT_ITEM_ASK_OPTION_MAX_LENGTH)).max(BOT_ITEM_ASK_MAX_OPTIONS).optional()
            .describe('Choices for the owner; omit for a free-text answer'),
        recommended: z.number().int().nonnegative().nullable().optional().describe('Zero-based index into options you recommend')
    }).strict().optional().describe('The structured question for your owner (action=ask)'),
    workerSessionId: z.string().trim().min(1).nullable().optional().describe('Session doing this item; null detaches'),
    snoozeUntil: z.number().int().positive().nullable().optional().describe('Epoch ms to hide the item until; null clears'),
    text: z.string().trim().min(1).max(BOT_ITEM_COMMENT_MAX_LENGTH).optional().describe('Comment text (action=comment)'),
    all: z.boolean().optional().describe('list: include done and canceled items too')
})

export type BotItemAskInput = {
    question: string
    options?: string[]
    recommended?: number | null
}

export type BotItemToolArgs = {
    action: 'add' | 'set' | 'ask' | 'comment' | 'list' | 'show' | 'done'
    itemId?: number | string
    title?: string
    detail?: string
    status?: BotItemStatus
    ask?: BotItemAskInput
    workerSessionId?: string | null
    snoozeUntil?: number | null
    text?: string
    all?: boolean
}

/** Identity and transport the bot tools act with. MCP passes the session client's values; tests inject http. */
export type BotToolContext = {
    botId: string
    /** The calling session (the bot's home chat); sent as `fromSessionId`. */
    sessionId: string
    http?: AxiosInstance
    apiUrl?: string
    accessToken?: string
    /** Shared auth for one tool call; created from the fields above when omitted. */
    auth?: BotAuthSource
    now?: () => number
}

function fieldsUsed(args: BotItemToolArgs, fields: Array<keyof BotItemToolArgs>): boolean {
    return fields.some((field) => args[field] !== undefined)
}

function requireItemId(args: BotItemToolArgs, action: string): string | number {
    if (args.itemId === undefined || String(args.itemId).trim() === '') {
        throw new BotClientError('bad_args', `itemId is required for action=${action}`)
    }
    // `#3` is how the tools print an item; accept it the way `3` is accepted.
    return normalizeItemRef(args.itemId)
}

export async function handleBotItemTool(args: BotItemToolArgs, ctx: BotToolContext): Promise<{ text: string; isError: boolean }> {
    const now = ctx.now ?? Date.now
    // One JWT exchange per tool call, however many hub calls an action makes (show: list + events).
    const request = { botId: ctx.botId, fromSessionId: ctx.sessionId, http: ctx.http, apiUrl: ctx.apiUrl, accessToken: ctx.accessToken, auth: ctx.auth ?? createBotAuthSource(ctx) }
    try {
        switch (args.action) {
            case 'list': {
                if (fieldsUsed(args, ['itemId', 'title', 'detail', 'status', 'ask', 'workerSessionId', 'snoozeUntil', 'text'])) {
                    throw new BotClientError('bad_args', 'action=list only accepts all')
                }
                const items = await listItems(request)
                return { text: formatBotItemList(items, { all: args.all === true, now: now() }), isError: false }
            }
            case 'add': {
                if (fieldsUsed(args, ['itemId', 'ask', 'text', 'snoozeUntil', 'all'])) {
                    throw new BotClientError('bad_args', 'action=add takes title, detail, status, workerSessionId only')
                }
                if (!args.title) {
                    throw new BotClientError('bad_args', 'title is required for action=add')
                }
                if (args.status !== undefined && !CreateStatusSchema.safeParse(args.status).success) {
                    throw new BotClientError('bad_args', 'a new item starts as planned or working; use set to move it later')
                }
                const item = await createItem({
                    ...request,
                    body: {
                        title: args.title,
                        ...(args.detail !== undefined ? { detail: args.detail } : {}),
                        ...(args.status !== undefined ? { status: args.status as 'planned' | 'working' } : {}),
                        ...(args.workerSessionId ? { workerSessionId: args.workerSessionId } : {})
                    }
                })
                return { text: `Created ${formatBotItemLine(item, now())}`, isError: false }
            }
            case 'set': {
                const itemId = requireItemId(args, 'set')
                if (fieldsUsed(args, ['ask', 'text', 'all'])) {
                    throw new BotClientError('bad_args', 'action=set takes title, detail, status, workerSessionId, snoozeUntil only')
                }
                if (!fieldsUsed(args, ['title', 'detail', 'status', 'workerSessionId', 'snoozeUntil'])) {
                    throw new BotClientError('bad_args', 'action=set needs at least one of title, detail, status, workerSessionId, snoozeUntil')
                }
                if (args.status === 'needs_you') {
                    throw new BotClientError('bad_args', 'needs_you is set by action=ask (the item needs a question); use waiting for work held by someone else')
                }
                const item = await updateItem({
                    ...request,
                    itemId,
                    body: {
                        ...(args.title !== undefined ? { title: args.title } : {}),
                        ...(args.detail !== undefined ? { detail: args.detail } : {}),
                        ...(args.status !== undefined ? { status: args.status } : {}),
                        ...(args.workerSessionId !== undefined ? { workerSessionId: args.workerSessionId } : {}),
                        ...(args.snoozeUntil !== undefined ? { snoozeUntil: args.snoozeUntil } : {})
                    }
                })
                return { text: `Updated ${formatBotItemLine(item, now())}`, isError: false }
            }
            case 'ask': {
                const itemId = requireItemId(args, 'ask')
                if (fieldsUsed(args, ['title', 'status', 'workerSessionId', 'snoozeUntil', 'text', 'all'])) {
                    throw new BotClientError('bad_args', 'action=ask takes itemId, ask and detail only (detail carries the background)')
                }
                if (!args.ask) {
                    throw new BotClientError('bad_args', 'ask { question, options?, recommended? } is required for action=ask')
                }
                // The background travels in the item's detail (set first so the
                // owner sees it with the question); the hub moves the item to needs_you.
                if (args.detail !== undefined) {
                    await updateItem({ ...request, itemId, body: { detail: args.detail } })
                }
                const item = await askItem({
                    ...request,
                    itemId,
                    body: normalizeAsk(args.ask)
                })
                return { text: formatAsked(item, now()), isError: false }
            }
            case 'comment': {
                const itemId = requireItemId(args, 'comment')
                if (fieldsUsed(args, ['title', 'detail', 'status', 'ask', 'workerSessionId', 'snoozeUntil', 'all'])) {
                    throw new BotClientError('bad_args', 'action=comment takes itemId and text only')
                }
                if (!args.text) {
                    throw new BotClientError('bad_args', 'text is required for action=comment')
                }
                const result = await commentItem({ ...request, itemId, body: { text: args.text } })
                const state = result.item ? ` ${formatBotItemLine(result.item, now())}` : ''
                return { text: `Commented on item ${itemId}${state}`, isError: false }
            }
            case 'show': {
                const itemId = requireItemId(args, 'show')
                const wanted = String(itemId)
                if (fieldsUsed(args, ['title', 'detail', 'status', 'ask', 'workerSessionId', 'snoozeUntil', 'text', 'all'])) {
                    throw new BotClientError('bad_args', 'action=show takes itemId only')
                }
                const items = await listItems(request)
                const item = items.find((candidate) => candidate.id === wanted || String(candidate.number) === wanted)
                if (!item) {
                    throw new BotClientError('not_found', `no item ${itemId}`)
                }
                const events = await listItemEvents({ ...request, itemId: item.id })
                return { text: formatBotItemDetail(item, events, now()), isError: false }
            }
            case 'done': {
                const itemId = requireItemId(args, 'done')
                if (fieldsUsed(args, ['title', 'status', 'ask', 'workerSessionId', 'snoozeUntil', 'text', 'all'])) {
                    throw new BotClientError('bad_args', 'action=done takes itemId and an optional detail (the result) only')
                }
                const item = await updateItem({
                    ...request,
                    itemId,
                    body: { status: 'done', ...(args.detail !== undefined ? { detail: args.detail } : {}) }
                })
                return { text: formatBotItemLine(item, now()), isError: false }
            }
        }
    } catch (error) {
        return { text: `bot_item failed: ${botErrorMessage(error)}`, isError: true }
    }
}

function formatAsked(item: BotItem, now: number): string {
    const lines = [
        `${formatBotItemLine(item, now)} — waiting on your owner`,
        `  ${formatAskText(item.ask).split('\n').join('\n  ')}`
    ]
    if (item.snoozedUntil) lines.push(`  snoozed until ${formatWhen(item.snoozedUntil, now)}`)
    lines.push('The owner is notified; their comment comes back as a new message and the item returns to working. End your turn now.')
    return lines.join('\n')
}


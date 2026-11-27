import type { BotItem, BotSummary, CreateBotRequest, NeedsYouResponse } from '@hapi/protocol'
import {
    BOT_ITEM_COMMENT_MAX_LENGTH,
    BOT_ITEM_DETAIL_MAX_LENGTH,
    BOT_ITEM_TITLE_MAX_LENGTH,
    BOT_NAME_MAX_LENGTH,
    BOT_PURPOSE_MAX_LENGTH,
    CreateBotRequestSchema,
    botHomeSlug,
    defaultBotHomeDir
} from '@hapi/protocol'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** The contract exports the needs-you schema and response but not this member type. */
export type NeedsYouEntry = NeedsYouResponse['entries'][number]

// ── Sidebar rows ─────────────────────────────────────────────────────

export type BotDisplayStatus = {
    key: 'creating' | 'running' | 'paused' | 'failed' | 'machineOffline'
    tone: 'normal' | 'warning' | 'danger'
}

/** The one status a sidebar row shows. Archived bots are not listed at all. */
export function botDisplayStatus(bot: Pick<BotSummary, 'state' | 'machineOnline'>): BotDisplayStatus | null {
    switch (bot.state) {
        case 'archived':
            return null
        case 'creating':
            return { key: 'creating', tone: 'normal' }
        case 'failed':
            return { key: 'failed', tone: 'danger' }
        case 'paused':
            return { key: 'paused', tone: 'normal' }
        case 'active':
            return bot.machineOnline
                ? { key: 'running', tone: 'normal' }
                : { key: 'machineOffline', tone: 'warning' }
    }
}

/** Bots the sidebar lists: everything the hub still keeps, newest first. */
export function listableBots(bots: BotSummary[]): BotSummary[] {
    return bots
        .filter((bot) => bot.state !== 'archived')
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

// ── Create form ──────────────────────────────────────────────────────

export type CreateBotDraft = {
    name: string
    purpose: string
    machineId: string | null
    agent: string | null
    /** null leaves the mode to the hub's default for bots; a value is the owner's explicit choice. */
    permissionMode: string | null
    /** '' uses the hub default, `~/.hapi/bots/<slug>`. */
    homeDir: string
}

export type CreateBotDraftError =
    | 'nameRequired'
    | 'nameTooLong'
    | 'nameChars'
    | 'nameSlug'
    | 'purposeTooLong'
    | 'machine'
    | 'homeDir'

export const EMPTY_CREATE_BOT_DRAFT: CreateBotDraft = {
    name: '',
    purpose: '',
    machineId: null,
    agent: null,
    permissionMode: null,
    homeDir: ''
}

/** The folder the hub will use when the form's home folder is left empty. */
export function previewBotHomeDir(name: string): string | null {
    const trimmed = name.trim()
    if (!trimmed || botHomeSlug(trimmed) === '') return null
    return defaultBotHomeDir(trimmed)
}

/**
 * Validates the form the way the contract does (same limits, same name
 * rules) and hands back a request the hub accepts. The folder preview
 * being empty while the default folder is wanted is an error: the hub
 * would place the bot directly in `~/.hapi/bots/`.
 */
export function buildCreateBotRequest(draft: CreateBotDraft): { request: CreateBotRequest } | { error: CreateBotDraftError } {
    const name = draft.name.trim()
    if (!name) return { error: 'nameRequired' }
    if (name.length > BOT_NAME_MAX_LENGTH) return { error: 'nameTooLong' }
    if (/[\u0000-\u001f\u007f/\\]/.test(name)) return { error: 'nameChars' }
    if (!draft.machineId) return { error: 'machine' }
    const purpose = draft.purpose.trim()
    if (purpose.length > BOT_PURPOSE_MAX_LENGTH) return { error: 'purposeTooLong' }
    const homeDir = draft.homeDir.trim()
    // `~` or `~/` would make the user's whole home folder the bot's home.
    const isHomeRoot = homeDir === '~' || (homeDir.startsWith('~/') && homeDir.slice(2).trim() === '')
    if (isHomeRoot) return { error: 'homeDir' }
    if (!homeDir && previewBotHomeDir(name) === null) {
        return { error: 'nameSlug' }
    }
    const request: CreateBotRequest = { name, machineId: draft.machineId }
    if (purpose) request.purpose = purpose
    if (draft.agent) request.agent = draft.agent
    // Without an explicit choice the hub applies its own default for bots.
    if (draft.permissionMode) request.permissionMode = draft.permissionMode
    if (homeDir) request.homeDir = homeDir
    // The contract schema has the last word; a name it trims is the name sent.
    const parsed = CreateBotRequestSchema.safeParse(request)
    if (!parsed.success) return { error: 'nameChars' }
    return { request: parsed.data }
}

// ── Ledger items ─────────────────────────────────────────────────────

export type BotItemTab = 'needsYou' | 'inProgress' | 'done'

/**
 * Splits the bot's items over the two list tabs. An item that is a question
 * for the owner is shown on "Needs you" (the needs-you feed carries it with
 * its ask), so it is left out of "In progress" unless the feed no longer
 * lists it (a snoozed question). Snoozed items sort last, then by number.
 */
export function splitBotItems(items: BotItem[], needsYou: NeedsYouEntry[]): { inProgress: BotItem[]; done: BotItem[] } {
    const questionIds = new Set(
        needsYou
            .filter((entry): entry is Extract<NeedsYouEntry, { kind: 'question' }> => entry.kind === 'question')
            .map((entry) => entry.itemId)
    )
    const inProgress: BotItem[] = []
    const done: BotItem[] = []
    for (const item of items) {
        if (item.status === 'done' || item.status === 'canceled') {
            done.push(item)
        } else if (item.status === 'needs_you' && questionIds.has(item.id)) {
            continue
        } else {
            inProgress.push(item)
        }
    }
    inProgress.sort((a, b) => Number(a.snoozedUntil !== null) - Number(b.snoozedUntil !== null) || b.number - a.number)
    done.sort((a, b) => b.number - a.number)
    return { inProgress, done }
}

export const SNOOZE_ONE_HOUR_MS = 60 * 60_000

export function snoozeOneHourFrom(now: number = Date.now()): number {
    return now + SNOOZE_ONE_HOUR_MS
}

/** A snooze in the past has expired; the hub derives that rather than storing it. */
export function isBotItemSnoozed(item: Pick<BotItem, 'snoozedUntil'>, now: number = Date.now()): boolean {
    return item.snoozedUntil !== null && item.snoozedUntil > now
}

/** Tomorrow at 9:00 in the viewer's local time, whatever the clock says now: the button promises tomorrow. */
export function tomorrowNineAm(now: number = Date.now()): number {
    const current = new Date(now)
    const candidate = new Date(current.getFullYear(), current.getMonth(), current.getDate(), 9, 0, 0, 0)
    candidate.setDate(candidate.getDate() + 1)
    return candidate.getTime()
}

export type BotItemDraftError = 'titleRequired' | 'titleTooLong' | 'detailTooLong' | 'commentRequired' | 'commentTooLong'

export function validateBotItemTitle(title: string): BotItemDraftError | null {
    if (!title.trim()) return 'titleRequired'
    if (title.trim().length > BOT_ITEM_TITLE_MAX_LENGTH) return 'titleTooLong'
    return null
}

export function validateBotItemDetail(detail: string): BotItemDraftError | null {
    return detail.length > BOT_ITEM_DETAIL_MAX_LENGTH ? 'detailTooLong' : null
}

export function validateBotItemComment(text: string): BotItemDraftError | null {
    if (!text.trim()) return 'commentRequired'
    if (text.trim().length > BOT_ITEM_COMMENT_MAX_LENGTH) return 'commentTooLong'
    return null
}

// ── Event log ────────────────────────────────────────────────────────

/**
 * "<Actor> <did>"; the event's own text follows on the same row. The
 * join is the locale's: a space in English and Russian, none in Chinese
 * and Japanese.
 */
export function botItemEventHead(event: { kind: string; actor: string }, t: Translate): string {
    return t('bots.ledger.eventHead', {
        actor: t(`bots.ledger.actor.${event.actor}`),
        verb: t(`bots.ledger.event.${event.kind}`)
    })
}

/** The collapsed workers line: "1 worker" / "2 workers", and who waits when anyone does. */
export function botWorkersSummaryKey(count: number, waiting: number): string {
    if (waiting > 0) return count === 1 ? 'bots.ledger.workersSummaryWaiting.one' : 'bots.ledger.workersSummaryWaiting.other'
    return count === 1 ? 'bots.ledger.workersSummary.one' : 'bots.ledger.workersSummary.other'
}

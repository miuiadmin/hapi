import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
    BotItem,
    BotItemEvent,
    BotSummary,
    BotWorker,
    CreateBotItemRequest,
    CreateBotRequest,
    UpdateBotItemRequest,
    UpdateBotRequest
} from '@hapi/protocol'
import { ApiError, apiErrorMessage, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import type { NeedsYouEntry } from '@/lib/bots'

/** A hub without the bot routes answers 404; retrying cannot change that. */
export function isBotsUnsupported(error: unknown): boolean {
    return error instanceof ApiError && error.status === 404 && error.code !== 'bot_not_found'
}

/** `GET /bots/:id` for a bot that is gone: the hub names the reason in `code`. */
export function isBotNotFound(error: unknown): boolean {
    return error instanceof ApiError && error.status === 404 && error.code === 'bot_not_found'
}

/** What a failed read shows: the hub's own error string, else the error's message; never the raw HTTP envelope. */
function messageOf(error: unknown): string | null {
    if (!(error instanceof Error) || isBotsUnsupported(error) || isBotNotFound(error)) return null
    const message = apiErrorMessage(error, '').trim()
    return message || null
}

// ── Cache edits (pure, so they can be tested without React) ─────────

/** Flips one bot between `active` and `paused`; other states are left alone. */
export function applyBotPaused(bots: BotSummary[], botId: string, paused: boolean): BotSummary[] {
    let changed = false
    const next = bots.map((bot) => {
        if (bot.id !== botId || bot.state !== (paused ? 'active' : 'paused')) return bot
        changed = true
        return { ...bot, state: paused ? 'paused' as const : 'active' as const }
    })
    return changed ? next : bots
}

export function upsertBot(bots: BotSummary[], bot: BotSummary): BotSummary[] {
    return bots.some((existing) => existing.id === bot.id)
        ? bots.map((existing) => (existing.id === bot.id ? bot : existing))
        : [...bots, bot]
}

/** Applies a status / snooze edit to the cached item until the hub answers. */
export function applyBotItemPatch(
    items: BotItem[],
    itemId: string,
    patch: Pick<UpdateBotItemRequest, 'status' | 'snoozedUntil'>
): BotItem[] {
    let changed = false
    const next = items.map((item) => {
        if (item.id !== itemId) return item
        changed = true
        return {
            ...item,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.snoozedUntil !== undefined ? { snoozedUntil: patch.snoozedUntil } : {})
        }
    })
    return changed ? next : items
}

// ── Invalidation ────────────────────────────────────────────────────

/**
 * The bot list and, when one is named, that bot's own summary. The hub
 * announces count changes as `bots-changed`, so a ledger change never
 * needs the list.
 */
export function invalidateBotSummaries(queryClient: QueryClient, botId?: string | null): Promise<unknown> {
    const keys: (readonly unknown[])[] = [queryKeys.bots]
    if (botId) keys.push(queryKeys.bot(botId))
    return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}

/** The lists a bot's ledger reads, plus one item's log when it is named. */
export function invalidateBotLedger(queryClient: QueryClient, botId: string, itemId?: string | null): Promise<unknown> {
    const keys: (readonly unknown[])[] = [
        queryKeys.botItems(botId),
        queryKeys.botNeedsYou(botId),
        queryKeys.botWorkers(botId)
    ]
    if (itemId) keys.push(queryKeys.botItemEvents(botId, itemId))
    return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}

/**
 * How long hub events are held before the refetch. Both SSE connections
 * (the global one and the session's) deliver the same event, and the hub
 * sends a burst for one change; one refetch per window serves them all.
 */
export const BOT_INVALIDATION_DELAY_MS = 150

type PendingBotInvalidations = {
    bots: boolean
    botIds: Set<string>
    ledgerBotIds: Set<string>
    /** `botId` and `itemId` joined, so the same item's log is refetched once. */
    ledgerItemIds: Set<string>
    timer: ReturnType<typeof setTimeout> | null
}

const ITEM_KEY_SEPARATOR = '\u0000'

// Module-level: the two SSE connections are two hook instances, and the
// coalescing has to span both.
const pendingByClient = new WeakMap<QueryClient, PendingBotInvalidations>()

function pendingFor(queryClient: QueryClient): PendingBotInvalidations {
    let pending = pendingByClient.get(queryClient)
    if (!pending) {
        pending = { bots: false, botIds: new Set(), ledgerBotIds: new Set(), ledgerItemIds: new Set(), timer: null }
        pendingByClient.set(queryClient, pending)
    }
    return pending
}

/** Runs what is pending now; for tests and a synchronous flush. */
export function flushBotInvalidations(queryClient: QueryClient): void {
    const pending = pendingByClient.get(queryClient)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    pendingByClient.delete(queryClient)
    const keys: (readonly unknown[])[] = []
    if (pending.bots) keys.push(queryKeys.bots)
    for (const botId of pending.botIds) keys.push(queryKeys.bot(botId))
    for (const botId of pending.ledgerBotIds) {
        keys.push(queryKeys.botItems(botId), queryKeys.botNeedsYou(botId), queryKeys.botWorkers(botId))
    }
    for (const itemId of pending.ledgerItemIds) {
        const [botId, itemIdPart] = itemId.split(ITEM_KEY_SEPARATOR)
        keys.push(queryKeys.botItemEvents(botId as string, itemIdPart as string))
    }
    void Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}

function scheduleFlush(queryClient: QueryClient): void {
    const pending = pendingFor(queryClient)
    if (pending.timer) return
    pending.timer = setTimeout(() => flushBotInvalidations(queryClient), BOT_INVALIDATION_DELAY_MS)
}

/** A bot was created, changed, paused or archived: refetch the list (and that bot). */
export function queueBotSummariesInvalidation(queryClient: QueryClient, botId?: string | null): void {
    const pending = pendingFor(queryClient)
    pending.bots = true
    if (botId) pending.botIds.add(botId)
    scheduleFlush(queryClient)
}

/** A bot's ledger changed: refetch its lists, and the named item's log. */
export function queueBotLedgerInvalidation(queryClient: QueryClient, botId: string, itemId?: string | null): void {
    const pending = pendingFor(queryClient)
    pending.ledgerBotIds.add(botId)
    if (itemId) pending.ledgerItemIds.add(`${botId}${ITEM_KEY_SEPARATOR}${itemId}`)
    scheduleFlush(queryClient)
}

// ── Queries ─────────────────────────────────────────────────────────

function useBotQuery<T>(api: ApiClient | null, queryKey: readonly unknown[], fetcher: (api: ApiClient) => Promise<T>, enabled = true) {
    const query = useQuery({
        queryKey,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await fetcher(api)
        },
        enabled: Boolean(api) && enabled,
        // The hub announces every change on the SSE stream (`bots-changed`,
        // `bot-items-changed`); unprompted refetches have nothing new to find.
        staleTime: 30_000,
        retry: false
    })
    return {
        data: query.data,
        isLoading: query.isLoading,
        error: messageOf(query.error),
        // True for any failure a retry could mend (so not a hub without bot routes, not a bot that is gone).
        failed: query.isError && !isBotsUnsupported(query.error) && !isBotNotFound(query.error),
        notFound: isBotNotFound(query.error),
        unsupported: isBotsUnsupported(query.error)
    }
}

export function useBots(api: ApiClient | null): { bots: BotSummary[]; isLoading: boolean; error: string | null; unsupported: boolean } {
    const query = useBotQuery(api, queryKeys.bots, (client) => client.listBots())
    return {
        bots: query.data?.bots ?? [],
        isLoading: query.isLoading,
        error: query.error,
        unsupported: query.unsupported
    }
}

export function useBot(api: ApiClient | null, botId: string | null): {
    bot: BotSummary | null
    isLoading: boolean
    error: string | null
    failed: boolean
    /** The hub answered `bot_not_found`: the bot was archived or deleted elsewhere. */
    notFound: boolean
    unsupported: boolean
} {
    const query = useBotQuery(api, queryKeys.bot(botId ?? ''), (client) => client.getBot(botId as string), Boolean(botId))
    return {
        bot: query.data?.bot ?? null,
        isLoading: query.isLoading,
        error: query.error,
        failed: query.failed,
        notFound: query.notFound,
        unsupported: query.unsupported
    }
}

export function useBotItems(api: ApiClient | null, botId: string): { items: BotItem[]; isLoading: boolean; error: string | null; failed: boolean } {
    const query = useBotQuery(api, queryKeys.botItems(botId), (client) => client.listBotItems(botId))
    return { items: query.data?.items ?? [], isLoading: query.isLoading, error: query.error, failed: query.failed }
}

export function useBotNeedsYou(api: ApiClient | null, botId: string): { entries: NeedsYouEntry[]; isLoading: boolean; error: string | null; failed: boolean } {
    const query = useBotQuery(api, queryKeys.botNeedsYou(botId), (client) => client.listBotNeedsYou(botId))
    return { entries: query.data?.entries ?? [], isLoading: query.isLoading, error: query.error, failed: query.failed }
}

export function useBotWorkers(api: ApiClient | null, botId: string): { workers: BotWorker[]; isLoading: boolean; error: string | null; failed: boolean } {
    const query = useBotQuery(api, queryKeys.botWorkers(botId), (client) => client.listBotWorkers(botId))
    return { workers: query.data?.workers ?? [], isLoading: query.isLoading, error: query.error, failed: query.failed }
}

/** The item's event log; nothing is fetched until an item is open. */
export function useBotItemEvents(api: ApiClient | null, botId: string, itemId: string | null): { events: BotItemEvent[]; isLoading: boolean; error: string | null; failed: boolean } {
    const query = useBotQuery(
        api,
        queryKeys.botItemEvents(botId, itemId ?? ''),
        (client) => client.listBotItemEvents(botId, itemId as string),
        Boolean(itemId)
    )
    return { events: query.data?.events ?? [], isLoading: query.isLoading, error: query.error, failed: query.failed }
}

// ── Mutations ───────────────────────────────────────────────────────

/**
 * Every write the bot UI makes. Mutations patch the cache they can
 * predict (pause, item status) and refetch the rest; the hub's SSE event
 * lands on the same keys.
 */
export function useBotMutations(api: ApiClient | null) {
    const queryClient = useQueryClient()
    const requireApi = (): ApiClient => {
        if (!api) throw new Error('API unavailable')
        return api
    }
    const readBots = (): BotSummary[] => queryClient.getQueryData<{ bots: BotSummary[] }>(queryKeys.bots)?.bots ?? []
    const writeBots = (bots: BotSummary[]) => queryClient.setQueryData(queryKeys.bots, { bots })
    const itemsKey = (botId: string) => queryKeys.botItems(botId)

    const createBot = useMutation({
        mutationFn: async (request: CreateBotRequest): Promise<BotSummary> => {
            const { bot } = await requireApi().createBot(request)
            return bot
        },
        onSuccess: (bot) => {
            writeBots(upsertBot(readBots(), bot))
            queryClient.setQueryData(queryKeys.bot(bot.id), { bot })
        },
        onSettled: () => invalidateBotSummaries(queryClient)
    })

    const setPaused = useMutation({
        mutationFn: async (input: { botId: string; paused: boolean }): Promise<BotSummary> => {
            const { bot } = await requireApi().updateBot(input.botId, { paused: input.paused })
            return bot
        },
        onMutate: async ({ botId, paused }) => {
            await queryClient.cancelQueries({ queryKey: queryKeys.bot(botId) })
            const previousList = queryClient.getQueryData<{ bots: BotSummary[] }>(queryKeys.bots)
            if (previousList) writeBots(applyBotPaused(previousList.bots, botId, paused))
            const previousBot = queryClient.getQueryData<{ bot: BotSummary }>(queryKeys.bot(botId))
            if (previousBot?.bot) {
                queryClient.setQueryData(queryKeys.bot(botId), (current: { bot: BotSummary } | undefined) => ({
                    bot: applyBotPaused([current?.bot ?? previousBot.bot], botId, paused)[0]
                }))
            }
            return { previousList, previousBot }
        },
        onError: (_error, _input, context) => {
            if (context?.previousList) queryClient.setQueryData(queryKeys.bots, context.previousList)
            if (context?.previousBot) queryClient.setQueryData(queryKeys.bot(context.previousBot.bot.id), context.previousBot)
        },
        onSuccess: (bot) => {
            writeBots(upsertBot(readBots(), bot))
            queryClient.setQueryData(queryKeys.bot(bot.id), { bot })
        },
        onSettled: (_data, _error, input) => invalidateBotSummaries(queryClient, input.botId)
    })

    const createItem = useMutation({
        mutationFn: async (input: { botId: string } & CreateBotItemRequest): Promise<void> => {
            const { botId, ...request } = input
            await requireApi().createBotItem(botId, request)
        },
        onSettled: (_data, _error, input) => invalidateBotLedger(queryClient, input.botId)
    })

    const updateItem = useMutation({
        mutationFn: async (input: { botId: string; itemId: string } & UpdateBotItemRequest): Promise<void> => {
            const { botId, itemId, ...request } = input
            await requireApi().updateBotItem(botId, itemId, request)
        },
        onMutate: async ({ botId, itemId, status, snoozedUntil }) => {
            if (status === undefined && snoozedUntil === undefined) return
            await queryClient.cancelQueries({ queryKey: itemsKey(botId) })
            const previous = queryClient.getQueryData<{ items: BotItem[] }>(itemsKey(botId))
            if (previous) {
                queryClient.setQueryData(itemsKey(botId), (current: { items: BotItem[] } | undefined) => ({
                    items: applyBotItemPatch(current?.items ?? previous.items, itemId, { status, snoozedUntil })
                }))
            }
            return { previous }
        },
        onError: (_error, input, context) => {
            if (context?.previous) queryClient.setQueryData(itemsKey(input.botId), context.previous)
        },
        onSettled: (_data, _error, input) => invalidateBotLedger(queryClient, input.botId, input.itemId)
    })

    const commentItem = useMutation({
        mutationFn: async (input: { botId: string; itemId: string; text: string }): Promise<void> => {
            await requireApi().commentBotItem(input.botId, input.itemId, input.text)
        },
        onSettled: (_data, _error, input) => invalidateBotLedger(queryClient, input.botId, input.itemId)
    })

    const archiveBot = useMutation({
        mutationFn: async (botId: string): Promise<void> => {
            await requireApi().deleteBot(botId)
        },
        onSuccess: (_data, botId) => {
            // The hub stops listing it; take it out of the cached list at once too.
            const cached = queryClient.getQueryData<{ bots: BotSummary[] }>(queryKeys.bots)
            if (cached) writeBots(cached.bots.filter((bot) => bot.id !== botId))
        },
        onSettled: (_data, _error, botId) => invalidateBotSummaries(queryClient, botId)
    })

    return { createBot, setPaused, createItem, updateItem, commentItem, archiveBot }
}

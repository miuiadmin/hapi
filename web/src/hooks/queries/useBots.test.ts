import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { BotItem, BotSummary } from '@hapi/protocol'
import { ApiError } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import {
    applyBotItemPatch,
    applyBotPaused,
    BOT_INVALIDATION_DELAY_MS,
    invalidateBotLedger,
    invalidateBotSummaries,
    isBotNotFound,
    isBotsUnsupported,
    queueBotLedgerInvalidation,
    queueBotSummariesInvalidation,
    upsertBot
} from './useBots'

function bot(id: string, overrides: Partial<BotSummary> = {}): BotSummary {
    return {
        id,
        name: id,
        purpose: '',
        machineId: 'm1',
        homeDir: `~/.hapi/bots/${id}`,
        agent: 'claude',
        model: null,
        permissionMode: 'default',
        homeChatSessionId: `home-${id}`,
        state: 'active',
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        machineOnline: true,
        homeChatActive: false,
        counts: { needsYou: 0, working: 0, workers: 0 },
        ...overrides
    }
}

function item(id: string, overrides: Partial<BotItem> = {}): BotItem {
    return {
        id,
        botId: 'bot-1',
        sessionId: 'home-bot-1',
        number: Number(id),
        title: id,
        status: 'working',
        detail: '',
        ask: null,
        snoozedUntil: null,
        workerSessionId: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

describe('bots query policy', () => {
    it('recognises only a 404 as a hub without bot routes', () => {
        expect(isBotsUnsupported(new ApiError('HTTP 404 Not Found', 404))).toBe(true)
        expect(isBotsUnsupported(new ApiError('HTTP 403 Forbidden', 403))).toBe(false)
        expect(isBotsUnsupported(new Error('HTTP 404 Not Found'))).toBe(false)
    })

    it('tells a bot that is gone from a hub without bot routes by the hub\'s code', () => {
        const gone = new ApiError('HTTP 404 Not Found: {"error":"no such bot","code":"bot_not_found"}', 404, 'bot_not_found', '{"error":"no such bot","code":"bot_not_found"}')
        expect(isBotNotFound(gone)).toBe(true)
        expect(isBotsUnsupported(gone)).toBe(false)
        expect(isBotNotFound(new ApiError('HTTP 404 Not Found', 404))).toBe(false)
    })
})

describe('bots cache edits', () => {
    it('pause flips only the named bot between active and paused', () => {
        const bots = [bot('1'), bot('2', { state: 'paused' }), bot('3', { state: 'creating' })]
        const next = applyBotPaused(bots, '1', true)
        expect(next).not.toBe(bots)
        expect(next.map((entry) => entry.state)).toEqual(['paused', 'paused', 'creating'])
        // Already in that state: the same array comes back, so nothing re-renders.
        expect(applyBotPaused(next, '1', true)).toBe(next)
        expect(applyBotPaused(next, '3', true)).toBe(next)
        expect(applyBotPaused(applyBotPaused(bots, '2', false), 'missing', true).map((entry) => entry.state)).toEqual(['active', 'active', 'creating'])
    })

    it('upsert replaces in place or appends', () => {
        const bots = [bot('1'), bot('2')]
        expect(upsertBot(bots, bot('1', { name: 'renamed' })).map((entry) => entry.name)).toEqual(['renamed', '2'])
        expect(upsertBot(bots, bot('3')).map((entry) => entry.id)).toEqual(['1', '2', '3'])
    })

    it('an item patch touches only status and snooze, and only the named item', () => {
        const items = [item('1'), item('2')]
        const next = applyBotItemPatch(items, '2', { status: 'done' })
        expect(next[0]).toBe(items[0])
        expect(next[1]).toMatchObject({ id: '2', status: 'done', snoozedUntil: null })
        expect(applyBotItemPatch(next, '2', { snoozedUntil: null })).toMatchObject([{ status: 'working' }, { status: 'done', snoozedUntil: null }])
        expect(applyBotItemPatch(items, 'missing', { status: 'done' })).toBe(items)
    })
})

describe('bot invalidation', () => {
    it('summaries: the bot list alone, with the bot when one is named', async () => {
        const queryClient = new QueryClient()
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)

        await invalidateBotSummaries(queryClient)
        expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([queryKeys.bots])

        invalidate.mockClear()
        await invalidateBotSummaries(queryClient, 'bot-1')
        expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([queryKeys.bots, queryKeys.bot('bot-1')])
    })

    it('ledger: the bot\'s three lists and the item log when one is named, never the bot list', async () => {
        const queryClient = new QueryClient()
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)

        await invalidateBotLedger(queryClient, 'bot-1')
        expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([
            queryKeys.botItems('bot-1'),
            queryKeys.botNeedsYou('bot-1'),
            queryKeys.botWorkers('bot-1')
        ])

        invalidate.mockClear()
        await invalidateBotLedger(queryClient, 'bot-1', 'item-9')
        expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toContainEqual(queryKeys.botItemEvents('bot-1', 'item-9'))
    })
})

describe('bot invalidation queue (hub events)', () => {
    it('holds events for a moment and refetches once per key, however many connections deliver them', () => {
        vi.useFakeTimers()
        try {
            const queryClient = new QueryClient()
            const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)

            // Both SSE connections see the same burst; one change also arrives as several events.
            queueBotLedgerInvalidation(queryClient, 'bot-1', 'item-3')
            queueBotLedgerInvalidation(queryClient, 'bot-1', 'item-3')
            queueBotLedgerInvalidation(queryClient, 'bot-1', 'item-4')
            queueBotLedgerInvalidation(queryClient, 'bot-1')
            queueBotSummariesInvalidation(queryClient, 'bot-1')
            queueBotSummariesInvalidation(queryClient, 'bot-1')
            expect(invalidate).not.toHaveBeenCalled()

            vi.advanceTimersByTime(BOT_INVALIDATION_DELAY_MS - 1)
            expect(invalidate).not.toHaveBeenCalled()

            vi.advanceTimersByTime(1)
            const keys = invalidate.mock.calls.map(([arg]) => arg?.queryKey)
            expect(keys).toEqual([
                queryKeys.bots,
                queryKeys.bot('bot-1'),
                queryKeys.botItems('bot-1'),
                queryKeys.botNeedsYou('bot-1'),
                queryKeys.botWorkers('bot-1'),
                queryKeys.botItemEvents('bot-1', 'item-3'),
                queryKeys.botItemEvents('bot-1', 'item-4')
            ])
        } finally {
            vi.useRealTimers()
        }
    })

    it('a ledger event alone does not refetch the bot list: counts are the hub\'s `bots-changed` to announce', () => {
        vi.useFakeTimers()
        try {
            const queryClient = new QueryClient()
            const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
            queueBotLedgerInvalidation(queryClient, 'bot-1', 'item-3')
            vi.advanceTimersByTime(BOT_INVALIDATION_DELAY_MS)
            expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([
                queryKeys.botItems('bot-1'),
                queryKeys.botNeedsYou('bot-1'),
                queryKeys.botWorkers('bot-1'),
                queryKeys.botItemEvents('bot-1', 'item-3')
            ])
        } finally {
            vi.useRealTimers()
        }
    })

    it('events after a flush start a new window', () => {
        vi.useFakeTimers()
        try {
            const queryClient = new QueryClient()
            const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
            queueBotSummariesInvalidation(queryClient, 'bot-1')
            vi.advanceTimersByTime(BOT_INVALIDATION_DELAY_MS)
            expect(invalidate).toHaveBeenCalledTimes(2)
            queueBotSummariesInvalidation(queryClient, 'bot-2')
            expect(invalidate).toHaveBeenCalledTimes(2)
            vi.advanceTimersByTime(BOT_INVALIDATION_DELAY_MS)
            expect(invalidate).toHaveBeenCalledTimes(4)
            expect(invalidate.mock.calls.slice(2).map(([arg]) => arg?.queryKey)).toEqual([queryKeys.bots, queryKeys.bot('bot-2')])
        } finally {
            vi.useRealTimers()
        }
    })
})

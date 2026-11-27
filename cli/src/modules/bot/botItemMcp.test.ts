import { describe, expect, it, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { BotItemEventSchema, BotItemSchema, type BotItem } from '@hapi/protocol'
import { handleBotItemTool } from './botItemMcp'
import { formatBotItemLine } from './items'

type MockResponse = { status: number; data: unknown }
type MockHandler = (url: string, body?: unknown) => MockResponse | Promise<MockResponse>

/** Any URL that reaches http must be absolute: the modules write `/api/...` and the client prefixes the hub. */
function guard(url: string): void {
    if (!url.startsWith('http://hub.test/')) {
        throw new Error(`relative URL reached http: ${url}`)
    }
}

function createHttpMock(handlers: {
    get?: (url: string) => MockResponse
    post?: MockHandler
    patch?: MockHandler
}) {
    const reject = (m: string, url: string) => Promise.reject(new Error(`unexpected ${m} ${url}`))
    return {
        get: vi.fn(async (url: string) => { guard(url); return handlers.get ? handlers.get(url) : reject('GET', url) }),
        post: vi.fn(async (url: string, body?: unknown) => { guard(url); return handlers.post ? handlers.post(url, body) : reject('POST', url) }),
        patch: vi.fn(async (url: string, body?: unknown) => { guard(url); return handlers.patch ? handlers.patch(url, body) : reject('PATCH', url) })
    }
}

const NOW = Date.parse('2026-11-27T10:00:00.000Z')
const auth = { status: 200, data: { token: 'jwt' } }

function item(overrides: Partial<BotItem> = {}): BotItem {
    return BotItemSchema.parse({
        id: 'item-a', botId: 'bot-1', sessionId: 'home-1', number: 12, title: 'Fix the flaky test', status: 'working', detail: '',
        ask: null, snoozedUntil: null, workerSessionId: null, createdAt: 1, updatedAt: 2, ...overrides
    })
}

const ctx = (http: unknown) => ({ botId: 'bot-1', sessionId: 'home-1', http: http as AxiosInstance, apiUrl: 'http://hub.test', accessToken: 'tok', now: () => NOW })

describe('bot_item', () => {
    it('adds an item and reports number and status', async () => {
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return auth
                expect(url).toBe('http://hub.test/api/bots/bot-1/items')
                expect(body).toEqual({ title: 'Fix the flaky test', detail: 'steps', workerSessionId: 'w-1', fromSessionId: 'home-1' })
                return { status: 201, data: { item: item({ workerSessionId: 'w-1' }) } }
            }
        })
        const result = await handleBotItemTool({ action: 'add', title: 'Fix the flaky test', detail: 'steps', workerSessionId: 'w-1' }, ctx(http))
        expect(result.isError).toBe(false)
        expect(result.text).toBe(`Created ${formatBotItemLine(item({ workerSessionId: 'w-1' }), NOW)}`)
        expect(result.text).toContain('#12 [working]')
    })

    it('lists open items by default and all with all=true', async () => {
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
            get: () => ({ status: 200, data: { items: [item({ status: 'done', number: 2 }), item()] } })
        })
        const open = await handleBotItemTool({ action: 'list' }, ctx(http))
        expect(open.text).toBe('1 open item(s):\n  ' + formatBotItemLine(item(), NOW))
        const all = await handleBotItemTool({ action: 'list', all: true }, ctx(http))
        expect(all.text).toContain('2 item(s), 1 open:')
    })

    it('asks with string options, converting them to the contract shape and ending the turn', async () => {
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return auth
                expect(url).toBe('http://hub.test/api/bots/bot-1/items/12/ask')
                expect(body).toEqual({ question: 'Which branch?', options: [{ label: 'main' }, { label: 'release/2.3' }], recommended: 0, fromSessionId: 'home-1' })
                return { status: 200, data: { item: item({ status: 'needs_you', ask: { question: 'Which branch?', options: [{ label: 'main' }, { label: 'release/2.3' }], recommended: 0 } }) } }
            },
            patch: (url, body) => {
                expect(url).toBe('http://hub.test/api/bots/bot-1/items/12')
                expect(body).toEqual({ detail: 'context', fromSessionId: 'home-1' })
                return { status: 200, data: { item: item({ detail: 'context' }) } }
            }
        })
        const result = await handleBotItemTool({
            action: 'ask', itemId: 12, detail: 'context',
            ask: { question: 'Which branch?', options: ['main', 'release/2.3'], recommended: 0 }
        }, ctx(http))
        expect(result.isError).toBe(false)
        expect(result.text).toContain('#12 [needs_you]')
        expect(result.text).toContain('options: (0) main  (1) release/2.3')
        expect(result.text).toContain('recommended: (0) main')
        expect(result.text).toContain('End your turn now.')
    })

    it('sets status and worker, marks done with the result, comments, and shows with events', async () => {
        const events = [BotItemEventSchema.parse({ id: 1, itemId: 'item-a', seq: 1, kind: 'created', actor: 'bot', text: 'Fix the flaky test', createdAt: 1 })]
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
            patch: (_url, body) => {
                const patch = body as { status?: BotItem['status']; workerSessionId?: string | null; detail?: string }
                return { status: 200, data: { item: item({ status: patch.status ?? 'working', workerSessionId: patch.workerSessionId ?? null, detail: patch.detail ?? '' }) } }
            },
            get: (url) => url.endsWith('/events')
                ? { status: 200, data: { events } }
                : { status: 200, data: { items: [item()] } }
        })
        const set = await handleBotItemTool({ action: 'set', itemId: 'item-a', status: 'waiting', workerSessionId: 'w-1' }, ctx(http))
        expect(set.text).toContain('#12 [waiting]')
        const done = await handleBotItemTool({ action: 'done', itemId: 12, detail: 'landed in abc123' }, ctx(http))
        expect(done.text).toContain('#12 [done]')
        const show = await handleBotItemTool({ action: 'show', itemId: 12 }, ctx(http))
        expect(show.text).toContain('id: item-a')
        expect(show.text).toContain('created by bot')
    })

    it('show accepts "#12" the way the tools print it and exchanges one JWT for list + events', async () => {
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
            get: (url) => url.endsWith('/events')
                ? { status: 200, data: { events: [] } }
                : { status: 200, data: { items: [item()] } }
        })
        const result = await handleBotItemTool({ action: 'show', itemId: '#12' }, ctx(http))
        expect(result.isError).toBe(false)
        expect(result.text).toContain('#12 [working] Fix the flaky test')
        expect(http.get).toHaveBeenCalledWith('http://hub.test/api/bots/bot-1/items', expect.anything())
        expect(http.get).toHaveBeenCalledWith('http://hub.test/api/bots/bot-1/items/item-a/events', expect.anything())
        // One auth exchange for the whole tool call, not one per request.
        expect(http.post.mock.calls.filter((call) => String(call[0]).endsWith('/api/auth'))).toHaveLength(1)
    })

    it('validates each action and reports errors as tool errors', async () => {
        const http = createHttpMock({ post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)) })
        const cases: Array<[Parameters<typeof handleBotItemTool>[0], RegExp]> = [
            [{ action: 'add' }, /title is required/],
            [{ action: 'add', title: 'x', status: 'done' }, /planned or working/],
            [{ action: 'add', title: 'x', ask: { question: 'q' } }, /action=add takes/],
            [{ action: 'set' }, /itemId is required/],
            [{ action: 'set', itemId: 1 }, /needs at least one/],
            [{ action: 'set', itemId: 1, status: 'needs_you' }, /needs_you is set by action=ask/],
            [{ action: 'ask', itemId: 1 }, /ask \{ question/],
            [{ action: 'ask', itemId: 1, ask: { question: 'q', options: ['a'], recommended: 3 } }, /out of range/],
            [{ action: 'comment', itemId: 1 }, /text is required/],
            [{ action: 'list', itemId: 1 }, /only accepts all/],
            [{ action: 'show' }, /itemId is required/],
            [{ action: 'done', itemId: 1, status: 'done' }, /optional detail/]
        ]
        for (const [args, message] of cases) {
            const result = await handleBotItemTool(args, ctx(http))
            expect(result.isError, JSON.stringify(args)).toBe(true)
            expect(result.text).toMatch(message)
        }
        // Every case fails before any hub call (not even the auth exchange).
        expect(http.post).not.toHaveBeenCalled()
        expect(http.get).not.toHaveBeenCalled()
    })

    it('surfaces a hub refusal as a tool error', async () => {
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : { status: 403, data: { error: 'not the home chat' } }
        })
        const result = await handleBotItemTool({ action: 'add', title: 'x' }, ctx(http))
        expect(result.isError).toBe(true)
        expect(result.text).toBe('bot_item failed: create item refused: not the home chat')
    })
})

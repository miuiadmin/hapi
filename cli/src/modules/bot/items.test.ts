import { describe, expect, it, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { BotItemEventSchema, BotItemSchema, type BotItem } from '@hapi/protocol'
import {
    askItem,
    commentItem,
    createItem,
    formatAskText,
    formatBotItemDetail,
    formatBotItemList,
    formatBotItemLine,
    isBotItemOpen,
    listItemEvents,
    listItems,
    normalizeAsk,
    updateItem
} from './items'
import { BotClientError } from './botClient'

type MockResponse = { status: number; data: unknown }

/** Any URL that reaches http must be absolute: the modules write `/api/...` and the client prefixes the hub. */
function guard(url: string): void {
    if (!url.startsWith('http://hub.test/')) {
        throw new Error(`relative URL reached http: ${url}`)
    }
}

function createHttpMock(handlers: {
    get?: (url: string) => MockResponse | Promise<MockResponse>
    post?: (url: string, body?: unknown) => MockResponse | Promise<MockResponse>
    patch?: (url: string, body?: unknown) => MockResponse | Promise<MockResponse>
}) {
    return {
        get: vi.fn(async (url: string) => { guard(url); return handlers.get ? handlers.get(url) : Promise.reject(new Error(`unexpected GET ${url}`)) }),
        post: vi.fn(async (url: string, body?: unknown) => { guard(url); return handlers.post ? handlers.post(url, body) : Promise.reject(new Error(`unexpected POST ${url}`)) }),
        patch: vi.fn(async (url: string, body?: unknown) => { guard(url); return handlers.patch ? handlers.patch(url, body) : Promise.reject(new Error(`unexpected PATCH ${url}`)) }),
        delete: vi.fn(async (url: string) => { guard(url); throw new Error(`unexpected DELETE ${url}`) })
    }
}

const auth = { status: 200, data: { token: 'jwt' } }
const BOT = 'bot-1'
const SESSION = 'home-session'
const opts = (http: unknown) => ({ botId: BOT, fromSessionId: SESSION, apiUrl: 'http://hub.test', accessToken: 'tok', http: http as AxiosInstance })

function item(overrides: Partial<BotItem> = {}): BotItem {
    return BotItemSchema.parse({
        id: 'item-a',
        botId: BOT,
        sessionId: SESSION,
        number: 3,
        title: 'Fix the flaky test',
        status: 'working',
        detail: '',
        ask: null,
        snoozedUntil: null,
        workerSessionId: null,
        createdAt: 1,
        updatedAt: 2,
        ...overrides
    })
}

describe('ledger REST calls', () => {
    it('lists items newest-first and sends the bot in the path', async () => {
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
            get: (url) => ({
                status: 200,
                data: { items: [item({ number: 1 }), item({ number: 9 }), item({ number: 4 })] }
            })
        })
        const items = await listItems(opts(http))
        expect(items.map((entry) => entry.number)).toEqual([9, 4, 1])
        expect(http.get).toHaveBeenCalledWith('http://hub.test/api/bots/bot-1/items', expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer jwt' })
        }))
    })

    it('creates an item with fromSessionId so the hub can check the caller', async () => {
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return auth
                expect(url).toBe('http://hub.test/api/bots/bot-1/items')
                expect(body).toEqual({ title: 'Ship it', detail: 'by friday', fromSessionId: SESSION })
                return { status: 201, data: { item: item({ title: 'Ship it' }) } }
            }
        })
        const created = await createItem({ ...opts(http), body: { title: 'Ship it', detail: 'by friday' } })
        expect(created.title).toBe('Ship it')
    })

    it('addresses an item by number or id, as given, and patches', async () => {
        const patched: string[] = []
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
            patch: (url, body) => {
                patched.push(url)
                return { status: 200, data: { item: item({ status: 'done' }) } }
            }
        })
        await updateItem({ ...opts(http), itemId: 3, body: { status: 'done' } })
        await updateItem({ ...opts(http), itemId: 'item-a', body: { workerSessionId: null } })
        expect(patched).toEqual(['http://hub.test/api/bots/bot-1/items/3', 'http://hub.test/api/bots/bot-1/items/item-a'])
    })

    it('asks and comments on the right routes', async () => {
        const urls: string[] = []
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return auth
                urls.push(url)
                expect(body).toMatchObject({ fromSessionId: SESSION })
                if (url.endsWith('/ask')) return { status: 200, data: { item: item({ status: 'needs_you' }) } }
                return { status: 200, data: { item: item({ status: 'working' }), event: { id: 7, itemId: 'item-a', seq: 2, kind: 'comment', actor: 'user', text: 'ok', createdAt: 5 } } }
            }
        })
        const asked = await askItem({ ...opts(http), itemId: 3, body: { question: 'Which?', options: [{ label: 'a' }] } })
        const commented = await commentItem({ ...opts(http), itemId: 3, body: { text: 'do a' } })
        expect(asked.status).toBe('needs_you')
        expect(commented.item?.status).toBe('working')
        expect(commented.event?.id).toBe(7)
        expect(urls).toEqual(['http://hub.test/api/bots/bot-1/items/3/ask', 'http://hub.test/api/bots/bot-1/items/3/comments'])
    })

    it('lists events and formats detail with them in order', async () => {
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
            get: (url) => ({
                status: 200,
                data: {
                    events: [
                        BotItemEventSchema.parse({ id: 2, itemId: 'item-a', seq: 2, kind: 'status', actor: 'bot', text: 'working', createdAt: 20 }),
                        BotItemEventSchema.parse({ id: 1, itemId: 'item-a', seq: 1, kind: 'created', actor: 'bot', text: 'Fix the flaky test', createdAt: 10 })
                    ]
                }
            })
        })
        const events = await listItemEvents({ ...opts(http), itemId: 'item-a' })
        expect(http.get).toHaveBeenCalledWith('http://hub.test/api/bots/bot-1/items/item-a/events', expect.anything())
        const text = formatBotItemDetail(item({ detail: 'steps:\n1. run' }), events, 1000)
        expect(text).toContain('#3 [working] Fix the flaky test')
        expect(text.indexOf('created by bot')).toBeLessThan(text.indexOf('status by bot'))
        expect(text).toContain('    1. run')
    })

    it('maps hub statuses: 404 not_found on an item route, 403 forbidden, 401 auth_failed, other request_failed', async () => {
        const cases: Array<[number, 'get' | 'patch', BotClientError['code']]> = [
            [404, 'patch', 'not_found'], [403, 'get', 'forbidden'], [401, 'get', 'auth_failed'], [500, 'get', 'request_failed']
        ]
        for (const [status, method, code] of cases) {
            const respond = () => ({ status, data: { error: 'nope' } })
            const http = createHttpMock({
                post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
                get: respond,
                patch: respond
            })
            const call = method === 'patch'
                ? updateItem({ ...opts(http), itemId: 3, body: { status: 'done' } })
                : listItems(opts(http))
            await expect(call).rejects.toMatchObject({ code, httpStatus: status })
        }
        // A 404 on a collection route is an unknown route (older hub), not a missing item.
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
            get: () => ({ status: 404, data: { error: 'Not found' } })
        })
        await expect(listItems(opts(http))).rejects.toMatchObject({ code: 'request_failed', httpStatus: 404 })
    })

    it('requires a bot id and refuses an empty list response shape', async () => {
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
            get: () => ({ status: 200, data: { nothing: true } })
        })
        await expect(listItems({ ...opts(http), botId: ' ' })).rejects.toMatchObject({ code: 'bad_args' })
        await expect(listItems(opts(http))).rejects.toBeInstanceOf(Error)
    })
})

describe('normalizeAsk', () => {
    it('turns string options into labels and keeps the recommendation', () => {
        expect(normalizeAsk({ question: '  Which? ', options: [' a ', 'b'], recommended: 1 })).toEqual({
            question: 'Which?', options: [{ label: 'a' }, { label: 'b' }], recommended: 1
        })
        expect(normalizeAsk({ question: 'Free?' })).toEqual({ question: 'Free?' })
    })

    it.each([
        [{ question: '   ' }, /question is required/],
        [{ question: 'q', options: ['a', ''] }, /must not be blank/],
        [{ question: 'q', options: Array.from({ length: 9 }, (_, i) => `o${i}`) }, /at most 8/],
        [{ question: 'q', options: ['a'], recommended: 1 }, /out of range/],
        [{ question: 'q', recommended: 0 }, /needs ask.options/],
        [{ question: 'q', options: ['a'], recommended: -1 }, /zero-based/]
    ] as const)('rejects %j', (input, message) => {
        expect(() => normalizeAsk(input as never)).toThrow(message)
        try {
            normalizeAsk(input as never)
        } catch (error) {
            expect(error).toBeInstanceOf(BotClientError)
            expect((error as BotClientError).code).toBe('bad_args')
        }
    })
})

describe('ledger formatting', () => {
    const now = 1_000_000

    it('marks open items and renders a compact line with number, status, worker and snooze', () => {
        expect(isBotItemOpen(item({ status: 'waiting' }))).toBe(true)
        expect(isBotItemOpen(item({ status: 'done' }))).toBe(false)
        expect(isBotItemOpen(item({ status: 'canceled' }))).toBe(false)
        const line = formatBotItemLine(item({ workerSessionId: '12345678-abcd', snoozedUntil: now + 3_600_000 }), now)
        expect(line).toBe(`#3 [working] Fix the flaky test  (worker=12345678; snoozed until ${new Date(now + 3_600_000).toISOString()} (in 1h))`)
    })

    it('lists only open items by default and names the owner\'s question', () => {
        const items = [
            item({ number: 3, status: 'needs_you', ask: { question: 'Which branch?', options: [{ label: 'main' }, { label: 'release' }], recommended: 0 } }),
            item({ number: 2, status: 'done' }),
            item({ number: 1, status: 'planned' })
        ]
        const open = formatBotItemList(items, { now })
        expect(open.split('\n')).toHaveLength(3)
        expect(open).toContain('2 open item(s):')
        expect(open).not.toContain('#2 ')
        expect(open).toContain('#3 [needs_you] Fix the flaky test  (waiting on owner: Which branch?)')
        const all = formatBotItemList(items, { all: true, now })
        expect(all).toContain('3 item(s), 2 open:')
        expect(all).toContain('#2 [done]')
        expect(formatBotItemList([item({ status: 'done' })], { now })).toContain('use all=true')
        expect(formatBotItemList([], { now })).toBe('No open items.')
    })

    it('renders options with indexes and the recommendation', () => {
        expect(formatAskText({ question: 'Q?', options: [{ label: 'a' }, { label: 'b' }], recommended: 1 }))
            .toBe('ask: Q?\n  options: (0) a  (1) b\n  recommended: (1) b')
        expect(formatAskText(null)).toBe('')
    })
})

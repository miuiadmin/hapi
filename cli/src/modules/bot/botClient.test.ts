import { afterEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { listItems } from './items'
import { BotClientError, botRequest, createBotAuthSource, isHubRejection, resolveBotAuth, withApiUrlPrefix } from './botClient'

/**
 * The mock `http` objects in the other bot tests route on `url.endsWith(...)`
 * and never noticed that the modules passed relative URLs to a raw axios. A
 * real axios against a local server does: a relative URL fails before any
 * request is made. These tests pin that the client prefixes `/api/...` with
 * the hub URL.
 */

describe('withApiUrlPrefix', () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const http = {
        get: async (...args: unknown[]) => { calls.push({ method: 'get', args }); return { status: 200, data: 'get' } },
        delete: async (...args: unknown[]) => { calls.push({ method: 'delete', args }); return { status: 200, data: 'delete' } },
        post: async (...args: unknown[]) => { calls.push({ method: 'post', args }); return { status: 200, data: 'post' } },
        patch: async (...args: unknown[]) => { calls.push({ method: 'patch', args }); return { status: 200, data: 'patch' } },
        put: async (...args: unknown[]) => { calls.push({ method: 'put', args }); return { status: 200, data: 'put' } },
        request: async (...args: unknown[]) => { calls.push({ method: 'request', args }); return { status: 200, data: 'request' } },
        defaults: { timeout: 0 }
    }

    afterEach(() => { calls.length = 0 })

    it('prefixes URLs that start with / on every verb and leaves absolute URLs alone', async () => {
        const wrapped = withApiUrlPrefix(http as never, 'http://hub.test')
        const cfg = { headers: {} }
        await wrapped.get('/api/bots/b1/items', cfg)
        await wrapped.delete('/api/sessions/s1/tasks/t1', cfg)
        await wrapped.post('/api/sessions/s1/tasks', { text: 'x' }, cfg)
        await wrapped.patch('/api/bots/b1/items/2', { status: 'done' }, cfg)
        await wrapped.put('/api/put', {}, cfg)
        await wrapped.request({ url: '/api/request', method: 'get' })
        await wrapped.get('http://elsewhere.test/api/x', cfg)
        await wrapped.get('https://elsewhere.test/api/y', cfg)

        expect(calls.map((call) => [call.method, call.args[0]])).toEqual([
            ['get', 'http://hub.test/api/bots/b1/items'],
            ['delete', 'http://hub.test/api/sessions/s1/tasks/t1'],
            ['post', 'http://hub.test/api/sessions/s1/tasks'],
            ['patch', 'http://hub.test/api/bots/b1/items/2'],
            ['put', 'http://hub.test/api/put'],
            ['request', { url: 'http://hub.test/api/request', method: 'get' }],
            ['get', 'http://elsewhere.test/api/x'],
            ['get', 'https://elsewhere.test/api/y']
        ])
        // Data and config pass through untouched.
        expect(calls[2]!.args.slice(1)).toEqual([{ text: 'x' }, cfg])
        // Non-function properties still resolve through the wrapper.
        expect((wrapped as unknown as { defaults: { timeout: number } }).defaults.timeout).toBe(0)
    })

    it('keeps `this` on the underlying instance', async () => {
        const inner = {
            tag: 'inner',
            async get(this: { tag: string }, _url: string) { return { status: 200, data: this.tag } }
        }
        const wrapped = withApiUrlPrefix(inner as never, 'http://hub.test')
        expect((await (wrapped.get('/api/x') as Promise<{ data: string }>)).data).toBe('inner')
    })
})

describe('isHubRejection', () => {
    it('is true only for refusals that certainly happened', () => {
        expect(isHubRejection(new BotClientError('request_failed', 'x', 404))).toBe(true)
        expect(isHubRejection(new BotClientError('request_failed', 'x', 429))).toBe(true)
        expect(isHubRejection(new BotClientError('forbidden', 'x', 403))).toBe(true)
        expect(isHubRejection(new BotClientError('auth_failed', 'x', 401))).toBe(true)
        expect(isHubRejection(new BotClientError('bad_args', 'x'))).toBe(true)
        expect(isHubRejection(new BotClientError('disabled', 'x'))).toBe(true)
    })

    it('is false for unknown outcomes: no status, 5xx, or not a client error at all', () => {
        expect(isHubRejection(new BotClientError('request_failed', 'timeout'))).toBe(false)
        expect(isHubRejection(new BotClientError('request_failed', 'x', 503))).toBe(false)
        expect(isHubRejection(new BotClientError('not_found', 'x'))).toBe(false)
        expect(isHubRejection(new Error('socket hang up'))).toBe(false)
        expect(isHubRejection(undefined)).toBe(false)
    })
})

describe('bot modules against a real axios', () => {
    let server: Server | null = null
    let apiUrl = ''
    const seen: string[] = []

    afterEach(async () => {
        seen.length = 0
        if (server) {
            await new Promise<void>((resolve) => server!.close(() => resolve()))
            server = null
        }
    })

    async function startHubDouble(): Promise<void> {
        server = createServer((req, res) => {
            seen.push(`${req.method} ${req.url}`)
            req.resume()
            res.setHeader('content-type', 'application/json')
            if (req.url === '/api/auth') {
                res.end(JSON.stringify({ token: 'jwt' }))
                return
            }
            if (req.url === '/api/bots/bot-1/items') {
                res.end(JSON.stringify({ items: [] }))
                return
            }
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'Not found' }))
        })
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
        apiUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    }

    it('is the failure mode: a raw axios refuses a relative URL before any request', async () => {
        await startHubDouble()
        // On the real runner axios reported `"/api/bots/…/items" cannot be parsed
        // as a URL`; Node's URL parser says `Invalid URL`. Either way nothing is sent.
        await expect(axios.get('/api/bots/bot-1/items')).rejects.toThrow(/URL/)
        expect(seen).toEqual([])
    })

    it('listItems reaches the hub through a real axios and the request URL is absolute', async () => {
        await startHubDouble()
        const items = await listItems({ botId: 'bot-1', apiUrl, accessToken: 'tok', http: axios.create() })
        expect(items).toEqual([])
        expect(seen).toEqual(['POST /api/auth', 'GET /api/bots/bot-1/items'])
    })

    it('botRequest and resolveBotAuth hand callers a prefixed http', async () => {
        await startHubDouble()
        await botRequest({ apiUrl, accessToken: 'tok', http: axios.create() }, {
            action: 'probe',
            request: async ({ http }) => http.get('/api/bots/bot-1/items', { validateStatus: () => true }),
            parse: () => 'done'
        })
        const auth = await resolveBotAuth({ apiUrl, accessToken: 'tok', http: axios.create() })
        await auth.http.get('/api/bots/bot-1/items', { validateStatus: () => true })
        expect(seen).toEqual(['POST /api/auth', 'GET /api/bots/bot-1/items', 'POST /api/auth', 'GET /api/bots/bot-1/items'])
        expect(auth.apiUrl).toBe(apiUrl)
    })

    it('a shared auth source exchanges the JWT once for several requests of one command', async () => {
        await startHubDouble()
        const auth = createBotAuthSource({ apiUrl, accessToken: 'tok', http: axios.create() })
        const probe = () => botRequest({ apiUrl, accessToken: 'tok', http: axios.create(), auth }, {
            action: 'probe',
            request: async ({ http }) => http.get('/api/bots/bot-1/items', { validateStatus: () => true }),
            parse: () => 'done'
        })
        await Promise.all([probe(), probe()])
        await probe()
        expect(seen).toEqual([
            'POST /api/auth', 'GET /api/bots/bot-1/items', 'GET /api/bots/bot-1/items', 'GET /api/bots/bot-1/items'
        ])
    })

    it('a failed exchange is not cached: the next get() tries again', async () => {
        let attempts = 0
        const http = {
            post: vi.fn(async (url: string) => {
                if (!url.endsWith('/api/auth')) throw new Error(`unexpected POST ${url}`)
                attempts += 1
                return attempts === 1 ? { status: 503, data: { error: 'down' } } : { status: 200, data: { token: 'jwt' } }
            }),
            get: vi.fn(async () => ({ status: 200, data: {} }))
        } as never
        const auth = createBotAuthSource({ apiUrl: 'http://hub.test', accessToken: 'tok', http })
        await expect(auth.get()).rejects.toMatchObject({ code: 'auth_failed' })
        await expect(auth.get()).resolves.toMatchObject({ jwt: 'jwt' })
        expect(attempts).toBe(2)
    })

    it('still maps hub statuses through the wrapper', async () => {
        await startHubDouble()
        const failure = await botRequest({ apiUrl, accessToken: 'tok', http: axios.create() }, {
            action: 'probe',
            notFoundMessage: 'no such thing',
            // The modules always pass validateStatus so hub statuses reach botStatusError.
            request: async ({ http }) => http.get('/api/nope', { validateStatus: () => true }),
            parse: () => 'done'
        }).catch((error: unknown) => error as BotClientError)
        expect(failure).toBeInstanceOf(BotClientError)
        expect(failure).toMatchObject({ code: 'not_found', httpStatus: 404 })
    })
})

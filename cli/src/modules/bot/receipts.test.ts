import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerReceipt } from './receipts'
import { BotClientError } from './botClient'

type MockResponse = { status: number; data: unknown }

/** Any URL that reaches http must be absolute: the modules write `/api/...` and the client prefixes the hub. */
function guard(url: string): void {
    if (!url.startsWith('http://hub.test/')) {
        throw new Error(`relative URL reached http: ${url}`)
    }
}

function createHttpMock(handler: (method: 'post', url: string, body?: unknown) => MockResponse) {
    return {
        post: vi.fn(async (url: string, body?: unknown) => { guard(url); return handler('post', url, body) }),
        get: vi.fn(async (url: string) => { guard(url); throw new Error(`unexpected GET ${url}`) })
    }
}

const base = { apiUrl: 'http://hub.test', accessToken: 'tok' }

describe('registerReceipt', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('refuses while peer tools are disabled, before any request (same gate as pingPeer / spawnPeer)', async () => {
        vi.stubEnv('HAPI_DISABLE_PEER_TOOLS', '1')
        const http = createHttpMock(() => ({ status: 200, data: { token: 'jwt' } }))
        await expect(registerReceipt('child-1', { ...base, parentSessionId: 'home-1', taskLocalId: 't', http: http as never }))
            .rejects.toMatchObject({ code: 'disabled' })
        expect(http.post).not.toHaveBeenCalled()
    })

    it('posts a turn_end receipt for the delivered task into the parent session', async () => {
        const http = createHttpMock((_m, url, body) => {
            if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            expect(url).toBe('http://hub.test/api/sessions/child-1/receipts')
            expect(body).toEqual({ parentSessionId: 'home-1', taskLocalId: 'ping-peer-abc', kind: 'turn_end' })
            return { status: 201, data: { receipt: { id: 'r1', childSessionId: 'child-1', parentSessionId: 'home-1', taskLocalId: 'ping-peer-abc', kind: 'turn_end', state: 'pending', createdAt: 1, deliveredAt: null } } }
        })
        const receipt = await registerReceipt('child-1', { ...base, parentSessionId: 'home-1', taskLocalId: 'ping-peer-abc', http: http as never })
        expect(receipt.id).toBe('r1')
        expect(receipt.state).toBe('pending')
    })

    it('surfaces an older hub without the route as request_failed (not not_found)', async () => {
        const http = createHttpMock((_, url) => url.endsWith('/api/auth')
            ? { status: 200, data: { token: 'jwt' } }
            : { status: 404, data: { error: 'Not found' } })
        await expect(registerReceipt('child-1', { ...base, parentSessionId: 'home-1', taskLocalId: 't', http: http as never }))
            .rejects.toMatchObject({ code: 'request_failed', httpStatus: 404 })
    })

    it('refuses a missing child or task before any request', async () => {
        const http = createHttpMock(() => ({ status: 200, data: { token: 'jwt' } }))
        await expect(registerReceipt('  ', { ...base, parentSessionId: 'home-1', taskLocalId: 't', http: http as never }))
            .rejects.toMatchObject({ code: 'bad_args' })
        await expect(registerReceipt('child-1', { ...base, parentSessionId: 'home-1', taskLocalId: '', http: http as never }))
            .rejects.toMatchObject({ code: 'bad_args' })
        expect(http.post).not.toHaveBeenCalled()
    })
})

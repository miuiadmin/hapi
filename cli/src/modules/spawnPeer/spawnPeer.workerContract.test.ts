import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parentSectionHasSessionChip } from '@hapi/protocol/peerParentStamp'
import { spawnPeer } from './spawnPeer'
import { HAPI_BOT_ID_ENV, HAPI_BOT_NAME_ENV } from '@/agent/hapiSessionEnv'

type MockResponse = { status: number; data: unknown }

const SESSION_ID = 'cccccccc-1111-1111-1111-111111111111'
const MACHINE_ID = 'machine-abc'
const PARENT_ID = '4bd4d2b9-e114-4e03-af4c-03e9e4f7439e'

/** Hub double that records the delivered remit and echoes it back as the transcript row. */
function hub() {
    const delivered = { text: '' }
    const http = {
        post: vi.fn(async (url: string, body?: unknown): Promise<MockResponse> => {
            if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
            if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                delivered.text = String((body as { text?: string }).text ?? '')
                return { status: 200, data: { ok: true } }
            }
            throw new Error(`unexpected POST ${url}`)
        }),
        get: vi.fn(async (url: string): Promise<MockResponse> => {
            if (url.endsWith('/api/hub-settings')) {
                return { status: 200, data: { peerSpawnDefaults: { agent: 'claude', permissionMode: 'bypassPermissions', models: { claude: 'sonnet' } } } }
            }
            if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                return { status: 200, data: { session: { id: SESSION_ID, active: true, metadata: { name: 'Child', flavor: 'claude' } } } }
            }
            if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                return { status: 200, data: { messages: [{ id: 'msg-1', createdAt: 1, content: { role: 'user', content: { text: delivered.text } } }] } }
            }
            throw new Error(`unexpected GET ${url}`)
        }),
        patch: vi.fn(async (url: string): Promise<MockResponse> => { throw new Error(`unexpected PATCH ${url}`) })
    }
    return { http, delivered }
}

describe('spawnPeer worker contract', () => {
    beforeEach(() => {
        delete process.env.HAPI_SESSION_ID
        delete process.env[HAPI_BOT_ID_ENV]
        delete process.env[HAPI_BOT_NAME_ENV]
        vi.stubEnv('HAPI_DISABLE_PEER_TOOLS', '')
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        delete process.env[HAPI_BOT_ID_ENV]
        delete process.env[HAPI_BOT_NAME_ENV]
    })

    const spawn = (http: unknown, extra: Partial<Parameters<typeof spawnPeer>[0]> = {}) => spawnPeer({
        directory: '/tmp/project',
        message: 'Fix the login tests',
        parent: { sessionId: PARENT_ID, name: 'Ops' },
        machineId: MACHINE_ID,
        accessToken: 'tok',
        apiUrl: 'http://hub.test',
        http: http as never,
        ...extra
    })

    it('leaves an ordinary spawn untouched', async () => {
        const h = hub()
        await spawn(h.http)
        expect(h.delivered.text).toContain('## Parent')
        expect(h.delivered.text).not.toContain('Worker contract')
    })

    it('appends the contract for an explicit bot identity, after the Parent stamp and the remit', async () => {
        const h = hub()
        const onProgress = vi.fn()
        await spawn(h.http, { workerContract: { botId: 'bot-1', botName: 'Ops' } , onProgress })
        const text = h.delivered.text
        expect(text.startsWith('## Parent')).toBe(true)
        expect(parentSectionHasSessionChip(text, PARENT_ID)).toBe(true)
        expect(text.indexOf('Fix the login tests')).toBeGreaterThan(text.indexOf('## Parent'))
        expect(text.indexOf('## Worker contract')).toBeGreaterThan(text.indexOf('Fix the login tests'))
        expect(text).toContain('the HAPI bot "Ops" (id bot-1)')
        expect(text).toContain('force-pushing')
        expect(onProgress).toHaveBeenCalledWith('appended the worker contract for bot bot-1')
    })

    it('resolves the contract from HAPI_BOT_ID for a bot\'s shell, and null opts out', async () => {
        process.env[HAPI_BOT_ID_ENV] = 'bot-env'
        process.env[HAPI_BOT_NAME_ENV] = 'Night Watch'
        const h = hub()
        await spawn(h.http)
        expect(h.delivered.text).toContain('the HAPI bot "Night Watch" (id bot-env)')

        const plain = hub()
        await spawn(plain.http, { workerContract: null })
        expect(plain.delivered.text).not.toContain('Worker contract')
    })
})

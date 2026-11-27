import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'

// `CreateSessionResponseSchema` in the shared contract strips unknown keys, so
// `botId` (added by the hub for a bot's home chat) must be named by the CLI's
// bootstrap schema or it would never reach the session client.

const axiosGetMock = vi.hoisted(() => vi.fn())
const axiosPostMock = vi.hoisted(() => vi.fn())

vi.mock('axios', () => ({
    default: {
        get: axiosGetMock,
        post: axiosPostMock,
        isAxiosError: () => false
    }
}))

vi.mock('@/api/auth', () => ({
    getAuthToken: () => 'cli-token'
}))

import { ApiClient } from './api'

const now = 1_710_000_000_000

function sessionRow() {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        namespace: 'default',
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: { path: '/home/ops/.hapi/bots/ops', host: 'test-host' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: now,
        todos: [],
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null
    }
}

describe('ApiClient bootstrap botId', () => {
    beforeEach(() => {
        configuration._setApiUrl('https://hapi.example.com')
        configuration._setExtraHeaders({})
        axiosGetMock.mockReset()
        axiosPostMock.mockReset()
    })

    it('reads botId from GET /cli/sessions/:id even though the shared schema strips unknown keys', async () => {
        axiosGetMock.mockResolvedValue({ data: { session: sessionRow(), botId: 'bot-1', disablePeerTools: false } })

        const client = await ApiClient.create()
        const session = await client.getSession('11111111-1111-4111-8111-111111111111')

        expect(session.botId).toBe('bot-1')
        expect(session.peerToolsDisabled).toBe(false)
        expect(session.id).toBe('11111111-1111-4111-8111-111111111111')
    })

    it('reads botId from POST /cli/sessions', async () => {
        axiosPostMock.mockResolvedValue({ data: { session: sessionRow(), botId: 'bot-2' } })

        const client = await ApiClient.create()
        const session = await client.getOrCreateSession({
            tag: 'test',
            metadata: { path: '/home/ops/.hapi/bots/ops', host: 'test-host' },
            state: null
        })

        expect(session.botId).toBe('bot-2')
    })

    it('leaves botId absent for an ordinary session and treats blank or null as absent', async () => {
        axiosGetMock.mockResolvedValueOnce({ data: { session: sessionRow() } })
        const client = await ApiClient.create()
        expect((await client.getSession('11111111-1111-4111-8111-111111111111')).botId).toBeUndefined()

        axiosGetMock.mockResolvedValueOnce({ data: { session: sessionRow(), botId: '' } })
        expect((await client.getSession('11111111-1111-4111-8111-111111111111')).botId).toBeUndefined()

        axiosGetMock.mockResolvedValueOnce({ data: { session: sessionRow(), botId: null } })
        expect((await client.getSession('11111111-1111-4111-8111-111111111111')).botId).toBeUndefined()
    })
})

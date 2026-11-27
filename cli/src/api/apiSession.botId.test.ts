import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'
import type { Session } from './types'
import type { SessionBootstrapInfo } from './api'

// The hub marks a bot's home chat with `botId` on the bootstrap row. The
// client keeps that snapshot next to `peerToolsDisabled` so tool registration
// and the wrapped-agent environment read one session-scoped truth.

const ioMock = vi.hoisted(() => vi.fn())

vi.mock('socket.io-client', () => ({
    io: ioMock
}))

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect(): void { }
        onSocketDisconnect(): void { }
        registerHandler(): void { }
        handleRequest(): Promise<string> {
            return Promise.resolve('{}')
        }
    }
}))

vi.mock('../modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: () => { }
}))

vi.mock('@/terminal/TerminalManager', () => ({
    TerminalManager: class {
        closeAll(): void { }
    }
}))

import { ApiSessionClient } from './apiSession'

const now = 1_710_000_000_000

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        namespace: 'default',
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: now,
        todos: [],
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: undefined,
        collaborationMode: undefined,
        ...overrides
    }
}

describe('ApiSessionClient botId snapshot', () => {
    beforeEach(() => {
        configuration._setApiUrl('https://hapi.example.com')
        ioMock.mockReset()
        ioMock.mockReturnValue({
            on: vi.fn(),
            connect: vi.fn(),
            emit: vi.fn(),
            disconnect: vi.fn(),
            volatile: { emit: vi.fn() }
        })
    })

    it('captures botId from the bootstrap row', () => {
        const client = new ApiSessionClient('cli-token', { ...createSession(), botId: 'bot-1' } as SessionBootstrapInfo)
        expect(client.botId).toBe('bot-1')
        client.close()
    })

    it('stays undefined for ordinary sessions and workers', () => {
        const client = new ApiSessionClient('cli-token', createSession())
        expect(client.botId).toBeUndefined()
        client.close()
    })

    it('adopts botId when a pending session lazy-materializes', async () => {
        const materialize = vi.fn(async () => ({ ...createSession({ namespace: 'default' }), botId: 'bot-2' } as SessionBootstrapInfo))
        const client = new ApiSessionClient('cli-token', { ...createSession({ namespace: 'pending', active: false }) }, { materialize })
        client.sendUserMessage('hello')
        expect(await client.materialize()).toBe(true)
        expect(client.botId).toBe('bot-2')
        client.close()
    })

    it('keeps the bootstrap botId when the materialized row omits it', async () => {
        const materialize = vi.fn(async () => createSession({ namespace: 'default' }))
        const client = new ApiSessionClient('cli-token', { ...createSession({ namespace: 'pending', active: false }), botId: 'bot-3' } as SessionBootstrapInfo, { materialize })
        client.sendUserMessage('hello')
        expect(await client.materialize()).toBe(true)
        expect(client.botId).toBe('bot-3')
        client.close()
    })
})

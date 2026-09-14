import { describe, expect, it, mock } from 'bun:test'
import { Store } from '../../../store'
import type { CliSocketWithData } from '../../socketTypes'
import { registerCliHandlers } from './index'

class FakeCliSocket {
    readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()
    readonly emitted: Array<{ event: string; data: unknown }> = []
    readonly rooms: string[] = []
    data: { namespace?: string } = {}
    handshake = { auth: {} as Record<string, unknown> }

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    join(room: string): this {
        this.rooms.push(room)
        return this
    }

    emit(event: string, data: unknown): this {
        this.emitted.push({ event, data })
        return this
    }

    to(): { emit: (event: string, data: unknown) => void } {
        return { emit: () => {} }
    }

    trigger(event: string, data: unknown, ack?: (response: unknown) => void): void {
        this.handlers.get(event)?.(data, ack)
    }
}

const anyRegistry = new Proxy({}, { get: () => () => {} }) as never
const fakeIo = { of: () => ({ to: () => ({ emit: () => {} }) }) } as never

describe('cli handler session-access memo', () => {
    it('serves repeated events for one session from the per-socket cache', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('memo-burst', null, null, 'default')

        let byNamespaceCalls = 0
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = ((sessionId: string, namespace: string) => {
            byNamespaceCalls += 1
            return original(sessionId, namespace)
        }) as typeof store.sessions.getSessionByNamespace

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        const alive = mock()
        registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry,
            onSessionAlive: alive
        })

        // Burst of events against the same session: one store read, many events.
        for (let i = 0; i < 5; i += 1) {
            socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        }
        expect(alive).toHaveBeenCalledTimes(5)
        expect(byNamespaceCalls).toBe(1)

        // A different session id misses the cache.
        socket.trigger('session-alive', { sid: 'other-session', time: Date.now() })
        expect(byNamespaceCalls).toBe(2)
        store.close()
    })

    it('does not cache denials — every denied event re-resolves', () => {
        const store = new Store(':memory:')
        let plainCalls = 0
        const original = store.sessions.getSession.bind(store.sessions)
        store.sessions.getSession = ((sessionId: string) => {
            plainCalls += 1
            return original(sessionId)
        }) as typeof store.sessions.getSession

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry
        })

        socket.trigger('session-alive', { sid: 'missing', time: Date.now() })
        socket.trigger('session-alive', { sid: 'missing', time: Date.now() })
        expect(plainCalls).toBe(2)
        expect(socket.emitted.filter(({ event }) => event === 'error')).toHaveLength(2)
        store.close()
    })

    it('expires the memo after the TTL window', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('memo-ttl', null, null, 'default')

        let byNamespaceCalls = 0
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = ((sessionId: string, namespace: string) => {
            byNamespaceCalls += 1
            return original(sessionId, namespace)
        }) as typeof store.sessions.getSessionByNamespace

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry
        })

        socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(byNamespaceCalls).toBe(1)

        await new Promise((resolve) => setTimeout(resolve, 1100))
        socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(byNamespaceCalls).toBe(2)
        store.close()
    })
})

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

const originalFetch = globalThis.fetch
const titleProviderEnvironment = {
    HAPI_TITLE_PROVIDER_BASE_URL: 'https://provider.example/v1',
    HAPI_TITLE_PROVIDER_API_KEY: 'secret',
    HAPI_TITLE_PROVIDER_MODEL: 'small-model'
} as const

const titleProviderEnvironmentKeys = Object.keys(titleProviderEnvironment) as Array<keyof typeof titleProviderEnvironment>
let restoreTitleProviderEnvironment: (() => void) | undefined

beforeEach(() => {
    const previous = new Map<string, string | undefined>()
    for (const key of titleProviderEnvironmentKeys) {
        previous.set(key, process.env[key])
        process.env[key] = titleProviderEnvironment[key]
    }
    restoreTitleProviderEnvironment = () => {
        for (const key of titleProviderEnvironmentKeys) {
            const value = previous.get(key)
            if (value === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = value
            }
        }
    }
})

afterEach(() => {
    globalThis.fetch = originalFetch
    restoreTitleProviderEnvironment?.()
    restoreTitleProviderEnvironment = undefined
})

describe('automatic first-turn title generation', () => {
    it.each([true, false])('retains a partially answered first turn across restart (thinking heartbeat: %s)', async (thinkingHeartbeat) => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return Response.json({ choices: [{ message: { content: 'Restarted first turn' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        const createEngine = () => new SyncEngine(store,
            { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        let engine = createEngine()
        try {
            const session = engine.getOrCreateSession('partial-first-turn-restart',
                { path: '/project', host: 'test' }, null, 'tenant')
            const now = Date.now()
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Explain deployment' } })
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Checking deployment' } })
            engine.stop()
            engine = createEngine()
            if (thinkingHeartbeat) engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: true })
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Include rollback' } })
            store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Deployment and rollback explained' } })
            if (thinkingHeartbeat) {
                engine.handleSessionAlive({ sid: session.id, time: now + 2, thinking: false })
            } else {
                const ready = store.messages.addMessage(session.id,
                    { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
                engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: ready })
            }
            for (let i = 0; i < 20 && !engine.getSession(session.id)?.metadata?.summary; i++) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
            expect(calls).toBe(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Restarted first turn')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it.each(['batch', 'steer', 'heartbeat-steer'])('generates once for multiple prompts in the first %s turn', async (kind) => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return Response.json({ choices: [{ message: { content: 'Deployment and rollback' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession(`first-turn-${kind}`,
                { path: '/project', host: 'test' }, null, 'tenant')
            const now = Date.now()
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Explain deployment' } }, 'initial')
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.markMessagesInvoked(session.id, ['initial'], now)
            if (kind !== 'batch') {
                store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Checking deployment' } })
            }
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Include rollback' } }, 'additional')
            store.messages.markMessagesInvoked(session.id, ['additional'], now)
            store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Deployment and rollback explained' } })
            if (kind === 'steer') {
                const ready = store.messages.addMessage(session.id,
                    { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
                engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: ready })
            }
            engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: false })
            for (let i = 0; i < 20 && !engine.getSession(session.id)?.metadata?.summary; i++) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
            expect(calls).toBe(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Deployment and rollback')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it.each(['ready', 'idle-without-completion', 'thinking'])('handles the %s completion boundary', async (boundary) => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return Response.json({ choices: [{ message: { content: 'Ready boundary title' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession(`boundary-${boundary}`,
                { path: '/project', host: 'test' }, null, 'tenant')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: boundary === 'thinking' })
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Explain deployment' } })
            const assistant = store.messages.addMessage(session.id,
                { role: 'assistant', content: { type: 'text', text: 'Here is the deployment process' } })
            engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: assistant })
            await new Promise(resolve => setTimeout(resolve, 0))
            expect(calls).toBe(0)
            if (boundary === 'ready') {
                const ready = store.messages.addMessage(session.id,
                    { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
                engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: ready })
                for (let i = 0; i < 20 && !engine.getSession(session.id)?.metadata?.summary; i++) {
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
                expect(calls).toBe(1)
                expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Ready boundary title')
                expect(engine.getSession(session.id)?.namespace).toBe('tenant')
            }
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('runs after the thinking transition and persists the generated summary', async () => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Deployment workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'automatic-first-turn',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            )

            const now = Date.now()
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Explain the deployment workflow' }
            })
            engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: true })
            store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow has three steps.' }
            })
            engine.handleSessionAlive({ sid: session.id, time: now + 2, thinking: false })

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (engine.getSession(session.id)?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect(requests[0]?.url).toBe('https://provider.example/v1/chat/completions')
            expect(engine.getSession(session.id)?.metadata).toMatchObject({
                summary: { text: 'Deployment workflow' },
                titleSuggestionAutoAttemptedAt: expect.any(Number)
            })
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('runs on a completed session end when no false heartbeat was observed', async () => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Completed workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'automatic-session-end',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            )
            const now = Date.now()
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Summarize the completed workflow' }
            })
            store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow completed successfully.' }
            })
            engine.handleSessionEnd({ sid: session.id, time: now + 1, reason: 'completed' })

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (engine.getSession(session.id)?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Completed workflow')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('runs when the first assistant message arrives after the session is already idle', async () => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Idle session workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'automatic-message-arrival',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            )
            const now = Date.now()
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Summarize the idle workflow' }
            })
            engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: true })
            engine.handleSessionAlive({ sid: session.id, time: now + 2, thinking: false })
            const assistant = store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow is complete.' }
            })
            engine.handleRealtimeEvent({
                type: 'message-received',
                sessionId: session.id,
                message: {
                    id: assistant.id,
                    seq: assistant.seq,
                    localId: assistant.localId,
                    content: assistant.content,
                    createdAt: assistant.createdAt,
                    invokedAt: assistant.invokedAt
                }
            } as never)

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (engine.getSession(session.id)?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Idle session workflow')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it.each(['error', 'terminated', 'cleared'])('runs the title fallback when the session ends via %s without a turn boundary', async (reason) => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Interrupted workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                `session-end-${reason}`,
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            )
            const now = Date.now()
            // The thinking-true transition opens the turn; the matching
            // thinking-false transition never arrives (dropped heartbeat), so
            // the session end below is the only remaining turn boundary.
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Summarize the interrupted workflow' }
            })
            store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow was interrupted midway.' }
            })
            engine.handleSessionEnd({ sid: session.id, time: now + 1, reason })

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (engine.getSession(session.id)?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Interrupted workflow')
        } finally {
            engine.stop()
            store.close()
        }
    })
})

// Hermes-style wedge: in a busy long-lived session every turn-completion
// signal (ready event, thinking=false transition, session-ended) can be
// suppressed, leaving the persisted titleSuggestionTurn.completed=false with
// no repair path. An idle keepalive must reconcile the wedged turn.
describe('idle reconciliation of wedged title turns', () => {
    const createEngine = (store: Store) => new SyncEngine(
        store,
        {
            of: () => ({
                to: () => ({ emit() {} }),
                adapter: { rooms: new Map<string, Set<string>>() }
            })
        } as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )

    it('settles a wedged turn from an idle keepalive after every completion signal was lost', async () => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls += 1
            return Response.json({ choices: [{ message: { content: 'Reconciled turn title' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        let engine = createEngine(store)
        try {
            const session = engine.getOrCreateSession(
                'wedged-title-turn',
                { path: '/project', host: 'test' },
                null,
                'tenant'
            )
            const now = Date.now()
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Explain deployment' }
            })
            // The turn opens, but the matching thinking=false transition,
            // ready event, and session end never arrive.
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'Deployment explained.' }
            })
            expect(engine.getSession(session.id)?.metadata?.titleSuggestionTurn)
                .toEqual({ first: true, completed: false })

            // Hub restart: in-memory turn tracking and the cached thinking
            // flag are gone, so the wasThinking fast path can never fire
            // again — before idle reconciliation this session was wedged
            // forever with completed=false.
            engine.stop()
            engine = createEngine(store)
            engine.handleSessionAlive({ sid: session.id, time: now + 1_000, thinking: false })

            for (let attempt = 0; attempt < 20
                && engine.getSession(session.id)?.metadata?.summary?.text === undefined; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(calls).toBe(1)
            expect(engine.getSession(session.id)?.metadata?.titleSuggestionTurn)
                .toEqual({ first: true, completed: true })
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Reconciled turn title')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('does not reconcile while the queued-prompt thinking grace still holds the spinner', async () => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls += 1
            return Response.json({ choices: [{ message: { content: 'Late title' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        let engine = createEngine(store)
        try {
            const session = engine.getOrCreateSession(
                'wedged-title-grace',
                { path: '/project', host: 'test' },
                null,
                'tenant'
            )
            const now = Date.now()
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Explain deployment' }
            })
            // The turn opens; its completion signals never arrive.
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'Deployment explained.' }
            })
            expect(engine.getSession(session.id)?.metadata?.titleSuggestionTurn?.completed).toBe(false)

            // Hub restart drops the cached thinking flag and the in-memory
            // turn tracking. A thinking=true keepalive re-marks the session
            // active, and a queued prompt then arms the 15s queued-thinking
            // grace.
            engine.stop()
            engine = createEngine(store)
            engine.handleSessionAlive({ sid: session.id, time: now + 1_000, thinking: true })
            await engine.sendMessage(session.id, { text: 'Follow-up prompt' })
            expect(engine.getSession(session.id)?.thinking).toBe(true)

            // Keepalives reporting thinking=false must not settle the turn
            // while the grace window is still open.
            engine.handleSessionAlive({ sid: session.id, time: now + 2_000, thinking: false })
            for (let attempt = 0; attempt < 5; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 0))
            }
            expect(engine.getSession(session.id)?.thinking).toBe(true)
            expect(engine.getSession(session.id)?.metadata?.titleSuggestionTurn?.completed).toBe(false)
            expect(calls).toBe(0)

            // Once the grace expires, the idle keepalives settle the turn and
            // the fallback runs.
            const originalNow = Date.now
            Date.now = () => now + 20_000
            try {
                engine.handleSessionAlive({ sid: session.id, time: now + 20_000, thinking: false })
            } finally {
                Date.now = originalNow
            }
            for (let attempt = 0; attempt < 20
                && engine.getSession(session.id)?.metadata?.summary?.text === undefined; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(calls).toBe(1)
            expect(engine.getSession(session.id)?.metadata?.titleSuggestionTurn?.completed).toBe(true)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Late title')
        } finally {
            engine.stop()
            store.close()
        }
    })
})

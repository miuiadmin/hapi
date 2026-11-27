import { afterEach, describe, expect, it } from 'bun:test'
import { MACHINE_CAPABILITIES, SESSION_TASK_MAX_ACTIVE_PER_SESSION, SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX, buildSessionTaskMessageLocalId } from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { StoredSessionTask } from '../store/sessionTasks'
import { SessionCache } from './sessionCache'
import type { EventPublisher } from './eventPublisher'
import { SessionWakeGate } from './sessionWakeGate'
import { setBotWakeRetryDelayForTests, SyncEngine } from './syncEngine'

/**
 * The wiring, not the services (those have their own tests): that the
 * engine tells receipts and bots about the turns, endings and requests it
 * sees, and that what they send lands in the session.
 */

type FakeSession = {
    id: string
    namespace: string
    active: boolean
    /** The wake gate never resumes an archived session. */
    archived: boolean
    thinking: boolean
    name: string
    agentState: { requests?: Record<string, { tool: string; arguments: unknown; createdAt?: number }> } | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function harness() {
    const store = new Store(':memory:')
    const sessions = new Map<string, FakeSession>()
    const events: SyncEvent[] = []
    const engine = Object.create(SyncEngine.prototype) as SyncEngine
    const internals = engine as unknown as Record<string, unknown>
    const historyActionsInFlight = new Set<string>()
    internals.historyActionsInFlight = historyActionsInFlight
    let spawned = 0

    const addSession = (id: string, view: Partial<FakeSession> = {}): FakeSession => {
        store.sessions.getOrCreateSession(id, { path: '/tmp', flavor: 'claude', name: id }, null, 'default', undefined, undefined, undefined, id)
        const session: FakeSession = { id, namespace: 'default', active: true, archived: false, thinking: false, name: id, agentState: null, ...view }
        sessions.set(id, session)
        return session
    }

    const machine = { id: 'mac', namespace: 'default', active: true, metadata: { capabilities: [MACHINE_CAPABILITIES.AgentAvailability] } }
    internals.store = store
    internals.sessionCache = {
        getSession: (id: string) => sessions.get(id),
        getSessions: () => [...sessions.values()],
        handleSessionAlive: (payload: { sid: string; thinking?: boolean }) => {
            const session = sessions.get(payload.sid)
            if (!session) return
            // A heartbeat is proof of life, as in the real cache.
            session.active = true
            if (payload.thinking !== undefined) session.thinking = payload.thinking
        },
        applySessionPatch: (id: string, data: Record<string, unknown>) => {
            const session = sessions.get(id)
            if (!session) return false
            const agentState = data.agentState as { value?: FakeSession['agentState'] } | undefined
            if (agentState?.value !== undefined) session.agentState = agentState.value
            if (data.thinking !== undefined) session.thinking = data.thinking === true
            if (data.active !== undefined) session.active = data.active === true
            return true
        },
        handleSessionEnd: (payload: { sid: string }) => {
            const session = sessions.get(payload.sid)
            if (session) {
                session.active = false
                session.thinking = false
            }
        },
        deleteSession: async (id: string) => {
            sessions.delete(id)
            store.sessions.deleteSession(id, 'default')
        },
        // The store call the real cache makes to name a session.
        renameSession: async (id: string, name: string) => {
            const stored = store.sessions.getSession(id)
            if (!stored) throw new Error('Session not found')
            store.sessions.updateSessionMetadata(
                id, { ...(stored.metadata ?? {}), name, nameLocked: true }, stored.metadataVersion, stored.namespace,
                { touchUpdatedAt: false, allowTitleUpdate: true }
            )
        },
        getQueuedThinkingGraceDeadline: () => null
    }
    internals.machineCache = { getMachine: () => machine, getMachineByNamespace: () => machine }
    internals.rpcGateway = {
        prepareBotHome: async (_machineId: string, request: { path: string }) => ({ path: `/resolved${request.path.replace(/^~\/?/, '/home/me/')}`, seeded: true })
    }
    internals.eventPublisher = { emit: (event: SyncEvent) => { events.push(event) } }
    internals.archivedForkPending = () => false
    internals.openCodeRewindPending = () => false
    internals.automaticTitleSuggestionService = {
        onTurnStarted: () => undefined,
        onTurnCompleted: async () => undefined,
        forgetSession: () => undefined
    }
    internals.titleTurnCompletedIds = new Set<string>()
    internals.messageService = { replayImmediateQueuedMessages: () => 0 }
    internals.pendingAutoBridgeReconcile = new Set<string>()
    internals.reconcileCursorAutoBridgeSetting = async () => undefined
    internals.sessionReadyIds = new Set<string>()
    internals.piResumeQuarantinedIds = new Set<string>()
    internals.piUnexpectedTempOriginalIds = new Set<string>()
    internals.io = {}

    const spawnedDirs: string[] = []
    /** Message localIds (whole or by prefix) whose next store attempt fails the way a broken store does (not a held transcript). */
    const storeRejects = new Set<string>()
    engine.sendMessage = async (id, payload) => {
        // As the real one: a history action (a resume under way) holds the transcript.
        if (historyActionsInFlight.has(id)) throw new Error('Conversation history action already in progress')
        const stored = String(payload.localId ?? '')
        const rejected = [...storeRejects].find((prefix) => stored.startsWith(prefix))
        if (rejected !== undefined) {
            storeRejects.delete(rejected)
            throw new Error('database is locked')
        }
        if (store.messages.lookupQueuedMessage(id, String(payload.localId ?? '')).status !== 'absent') return
        store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: payload.text } }, payload.localId ?? undefined)
    }
    engine.renameSession = async () => undefined
    engine.spawnSession = async (machineId, directory, agent, ...rest) => {
        expect(machineId).toBe('mac')
        expect(agent).toBe('claude')
        // Same order as the machines route: permissionMode is the 11th, namespace the 17th.
        // A bot starts fully automatic unless the owner picks a mode.
        expect(rest[7]).toBe('bypassPermissions')
        expect(rest[13]).toBe('default')
        expect(rest[3]).toBe('simple')
        expect(rest.slice(0, 13).filter((value, index) => index !== 3 && index !== 7)).toEqual(Array(12).fill(undefined))
        spawnedDirs.push(directory)
        const opts = rest[15] as { reservedSessionId?: string; name?: string } | undefined
        const reserved = opts?.reservedSessionId
        expect(reserved).toBeTruthy()
        // The bot's name travels with the launch; the session gets it before the machine starts it (its own test below).
        expect(opts?.name).toBe('Ops')
        addSession(reserved as string)
        return { type: 'success' as const, sessionId: reserved as string }
    }
    /** Whether `resumeSession` succeeds; false stands for a machine that cannot start the session now. */
    let resumable = true
    /** While set, `resumeSession` holds the session's transcript for this long, as a real resume does for its machine round-trip. */
    let resumeHoldsMs = 0
    const resumes: string[] = []
    engine.resumeSession = async (id) => {
        resumes.push(id)
        const session = sessions.get(id)
        if (!session) return { type: 'error' as const, code: 'session_not_found', message: 'gone' }
        if (!resumable) return { type: 'error' as const, code: 'no_machine_online', message: 'machine offline' }
        if (resumeHoldsMs > 0) {
            historyActionsInFlight.add(id)
            await sleep(resumeHoldsMs)
            historyActionsInFlight.delete(id)
        }
        session.active = true
        return { type: 'success' as const, sessionId: id }
    }
    internals.triggerDedupIfNeeded = () => undefined
    internals.markSteerDispatchesUncertain = () => undefined
    internals.reconcileSteerDeliveryOwner = () => undefined
    ;(engine as unknown as Record<string, unknown>).releaseSessionEnumerations = () => undefined

    /** What the hub posted into a session on the bots' behalf. */
    const hubMessages = (sessionId: string) => store.messages
        .getMessages(sessionId)
        .filter((message) => message.localId?.startsWith('hapi-'))
        .map((message) => ({ localId: message.localId as string, text: (message.content as { content: { text: string } }).content.text }))

    return {
        store, sessions, events, engine, addSession, spawnedDirs, hubMessages, resumes,
        setResumable: (value: boolean) => { resumable = value },
        holdResume: (ms: number) => { resumeHoldsMs = ms },
        /** Makes the next call that stores a message whose localId starts with `prefix` fail as a broken store would. */
        failNextStore: (prefix: string) => { storeRejects.add(prefix) },
        internals
    }
}

afterEach(() => setBotWakeRetryDelayForTests(null))

async function settle(): Promise<void> {
    for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** The worker took its task and wrote `replies` after it. */
function workerTakes(store: Store, workerId: string, localId: string, replies: string[]): void {
    store.messages.addMessage(workerId, { role: 'user', content: { type: 'text', text: 'the task' } }, localId, null, 100)
    store.messages.markMessagesInvoked(workerId, [localId], 100)
    for (const [index, reply] of replies.entries()) {
        store.messages.addMessage(workerId, { role: 'agent', content: { type: 'text', text: reply } }, undefined, null, 101 + index)
    }
}

async function createBot(h: ReturnType<typeof harness>): Promise<{ botId: string; home: string }> {
    const bot = await h.engine.botService.create('default', { name: 'Ops', purpose: 'keep CI green', machineId: 'mac' })
    await settle()
    return { botId: bot.id, home: bot.homeChatSessionId as string }
}

describe('SyncEngine: bots and receipts wiring', () => {
    it('creates a bot through the engine: home folder, home chat on the chosen machine, first run queued', async () => {
        const h = harness()
        const { botId, home } = await createBot(h)

        expect(h.spawnedDirs).toEqual(['/resolved/home/me/.hapi/bots/ops'])
        expect(h.sessions.has(home)).toBe(true)
        expect(h.engine.botService.homeChatBot(home)?.id).toBe(botId)
        const first = h.hubMessages(home)
        expect(first).toHaveLength(1)
        expect(first[0].localId).toBe(`hapi-bot-kickoff:${botId}`)
        expect(first[0].text).toContain('Ops')
        // The machine has just been asked to start the home chat: the hub does not ask again.
        expect(h.resumes).toEqual([])
        // A plain session is nobody's home chat.
        expect(h.engine.botService.homeChatBot('nope')).toBeNull()
    })

    it("a worker's turn ending posts the reply into the bot's home chat, once", async () => {
        const h = harness()
        const { home } = await createBot(h)
        h.addSession('worker')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })
        workerTakes(h.store, 'worker', 'task-1', ['Working.'])
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: true })
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: true })
        await settle()
        expect(h.hubMessages(home)).toHaveLength(1) // only the first run so far

        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'Fixed and verified.' } })
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: false })
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: false })
        await settle()

        const receipts = h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-receipt:'))
        expect(receipts).toHaveLength(1)
        expect(receipts[0].text).toContain('Fixed and verified.')
        expect(h.store.sessionReceipts.listUnsettled()).toEqual([])
        // The worker is no longer waited on.
        expect(h.engine.botService.workers('default', h.engine.botService.homeChatBot(home)!.id)).toEqual([])
    })

    it('tells the bot when a worker it waits on raises a request, and lists it under needs-you', async () => {
        const h = harness()
        const { botId, home } = await createBot(h)
        h.addSession('worker')
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })
        const request = { tool: 'Bash', arguments: { command: 'git push --force' }, createdAt: 5 }
        const patch = { agentState: { value: { requests: { r1: request } }, version: 1 } }
        h.engine.handleRealtimeEvent({ type: 'session-updated', sessionId: 'worker', data: patch } as never)
        // A re-sent state (reconnect) adds nothing.
        h.engine.handleRealtimeEvent({ type: 'session-updated', sessionId: 'worker', data: patch } as never)
        await settle()

        const notices = h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-worker-request:'))
        expect(notices.map((message) => message.localId)).toEqual(['hapi-worker-request:worker:r1'])
        expect(notices[0].text).toContain('git push --force')
        expect(h.engine.botService.needsYou('default', botId)).toEqual([
            { kind: 'request', sessionId: 'worker', requestId: 'r1', tool: 'Bash', createdAt: 5 }
        ])
        expect(h.engine.botService.get('default', botId).counts.workers).toBe(1)
    })

    it('a worker session ending settles its receipt from what it wrote', async () => {
        const h = harness()
        const { home } = await createBot(h)
        h.addSession('worker')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })
        workerTakes(h.store, 'worker', 'task-1', ['Done before I go.'])

        h.engine.handleSessionEnd({ sid: 'worker', time: Date.now(), reason: 'completed' })
        await settle()

        const receipts = h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-receipt:'))
        expect(receipts).toHaveLength(1)
        expect(receipts[0].text).toContain('Done before I go.')
    })

    it("the owner's answer reaches the bot's home chat through the engine", async () => {
        const h = harness()
        const { botId, home } = await createBot(h)
        h.engine.botService.createItem('default', botId, { title: 'Ship it' })
        h.engine.botService.ask('default', botId, '1', { question: 'Now?', fromSessionId: home })

        // The bot is not running: delivering wakes it first.
        h.sessions.get(home)!.active = false
        h.engine.botService.comment('default', botId, '1', { text: 'Yes, go.' })
        await settle()

        expect(h.sessions.get(home)!.active).toBe(true)
        const comments = h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-item-comment:'))
        expect(comments).toHaveLength(1)
        expect(comments[0].text).toContain('Yes, go.')
        expect(h.events.filter((event) => event.type === 'bots-changed' || event.type === 'bot-items-changed').length).toBeGreaterThan(0)
    })
})

describe('SyncEngine: the real spawn path for a home chat', () => {
    it('names the preallocated session before the machine is asked to start it, and the name survives the first start', async () => {
        const h = harness()
        // The real session cache on the real store: preallocation, naming and adoption as the hub runs them.
        const cache = new SessionCache(h.store, { emit: () => undefined, subscribe: () => () => undefined } as unknown as EventPublisher)
        const internals = h.engine as unknown as Record<string, unknown>
        internals.sessionCache = {
            ...((h.internals as Record<string, unknown>).sessionCache as Record<string, unknown>),
            getOrCreateSession: cache.getOrCreateSession.bind(cache),
            renameSession: cache.renameSession.bind(cache),
            getSession: cache.getSession.bind(cache),
            refreshSession: cache.refreshSession.bind(cache)
        }
        const sessionId = 'home-named'
        // The machine's side of the launch.
        let started = false
        ;(h.internals.rpcGateway as { spawnSession: (...args: unknown[]) => Promise<unknown> }).spawnSession = async (...args: unknown[]) => {
            started = true
            return { type: 'success', sessionId: args[17] as string }
        }
        const result = await SyncEngine.prototype.spawnSession.call(
            h.engine, 'mac', '/home/me/.hapi/bots/ops', 'claude',
            undefined, undefined, undefined, 'simple', undefined, undefined, undefined, 'acceptEdits',
            undefined, undefined, undefined, undefined, undefined, 'default', undefined,
            { reservedSessionId: sessionId, name: 'Ops' }
        )

        expect(result.type).toBe('success')
        expect(started).toBe(true)
        // Named, and still a stub the CLI's first start can adopt.
        expect(h.store.sessions.getSession(sessionId)?.metadata).toMatchObject({ name: 'Ops', nameLocked: true, startedBy: 'runner' })
        expect(cache.getSession(sessionId)?.metadata?.name).toBe('Ops')

        // The CLI starts and sends its create-time snapshot, which has no name of its own.
        const adopted = h.store.sessions.adoptPreallocatedSession(
            sessionId,
            `cli-${sessionId}`,
            { path: '/home/me/.hapi/bots/ops', host: 'localhost', flavor: 'claude', machineId: 'mac', startedBy: 'runner', startedFromRunner: true, hostPid: 4242 },
            { controlledByUser: false },
            'default'
        )
        expect(adopted.metadata).toMatchObject({ name: 'Ops', nameLocked: true, hostPid: 4242 })
        // What the runner is answered when the session asks the hub about itself on its first run.
        expect((cache.refreshSession(sessionId)?.metadata ?? { name: null }).name).toBe('Ops')
    })

    it('a session that cannot be named still starts', async () => {
        const h = harness()
        let started = false
        const gateway = h.internals.rpcGateway as { spawnSession: (...args: unknown[]) => Promise<unknown> }
        const cache = h.internals.sessionCache as Record<string, unknown>
        gateway.spawnSession = async (...args: unknown[]) => {
            started = true
            return { type: 'success', sessionId: args[17] as string }
        }
        cache.getOrCreateSession = () => undefined
        cache.renameSession = async () => { throw new Error('disk full') }

        const result = await SyncEngine.prototype.spawnSession.call(
            h.engine, 'mac', '/home/me/.hapi/bots/ops', 'claude',
            undefined, undefined, undefined, 'simple', undefined, undefined, undefined, 'acceptEdits',
            undefined, undefined, undefined, undefined, undefined, 'default', undefined,
            { reservedSessionId: 'home-2', name: 'Ops' }
        )
        expect(result.type).toBe('success')
        expect(started).toBe(true)
    })
})

describe('SyncEngine: what the hub sends to a bot', () => {
    /** The engine's wake gate, with backoff short enough for a test. */
    function shortWakeGate(h: ReturnType<typeof harness>): void {
        h.internals.wakeGate = new SessionWakeGate({
            getSession: (id: string) => h.sessions.get(id) ?? null,
            resumeSession: (id: string) => h.engine.resumeSession(id, 'default'),
            baseBackoffMs: 2,
            maxBackoffMs: 2,
            activeTimeoutMs: 2_000
        })
    }

    /** What the hub still owes, by session. */
    function pendingDeliveries(h: ReturnType<typeof harness>): Map<string, { unstored: unknown[]; wakeAttempts: number; timer: unknown }> {
        return (h.engine as unknown as { botWakeRetries: Map<string, { unstored: unknown[]; wakeAttempts: number; timer: unknown }> }).botWakeRetries
    }

    async function askTwo(h: ReturnType<typeof harness>): Promise<{ botId: string; home: string }> {
        const { botId, home } = await createBot(h)
        h.engine.botService.createItem('default', botId, { title: 'Ship it' })
        h.engine.botService.ask('default', botId, '1', { question: 'Now?', fromSessionId: home })
        h.engine.botService.createItem('default', botId, { title: 'Then the notes' })
        h.engine.botService.ask('default', botId, '2', { question: 'Write them?', fromSessionId: home })
        return { botId, home }
    }

    it("the owner's answer is kept when the bot cannot be woken, and the bot is woken by the retry", async () => {
        setBotWakeRetryDelayForTests(5)
        const h = harness()
        shortWakeGate(h)
        const { botId, home } = await createBot(h)
        h.engine.botService.createItem('default', botId, { title: 'Ship it' })
        h.engine.botService.ask('default', botId, '1', { question: 'Now?', fromSessionId: home })

        // The bot is not running and its machine cannot start it right now.
        h.sessions.get(home)!.active = false
        h.setResumable(false)
        h.engine.botService.comment('default', botId, '1', { text: 'Yes, go.' })
        await settle()
        const comments = () => h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-item-comment:'))
        // The answer is in the session whatever happens to the wake.
        expect(comments()).toHaveLength(1)
        expect(comments()[0].text).toContain('Yes, go.')
        expect(h.sessions.get(home)!.active).toBe(false)
        expect(h.resumes.length).toBeGreaterThanOrEqual(1)

        // The machine is back: the pending wake goes out at once.
        h.setResumable(true)
        const internals = h.engine as unknown as { retryBotWakes: () => void }
        internals.retryBotWakes()
        await settle()
        expect(h.sessions.get(home)!.active).toBe(true)
        expect(comments()).toHaveLength(1)
        expect(pendingDeliveries(h).size).toBe(0)
        // A retry that fires after the session is already up does nothing more.
        const asks = h.resumes.length
        await sleep(40)
        expect(h.resumes.length).toBe(asks)
        expect(comments()).toHaveLength(1)
    })

    it('a wake that keeps failing is retried with a delay, and nothing is sent twice', async () => {
        setBotWakeRetryDelayForTests(5)
        const h = harness()
        shortWakeGate(h)
        const { botId, home } = await createBot(h)
        h.engine.botService.createItem('default', botId, { title: 'Ship it' })
        h.engine.botService.ask('default', botId, '1', { question: 'Now?', fromSessionId: home })
        h.sessions.get(home)!.active = false
        h.setResumable(false)
        h.resumes.length = 0

        h.engine.botService.comment('default', botId, '1', { text: 'Yes, go.' })
        await settle()
        expect(h.resumes.length).toBe(1)

        // The retry finds the machine back, and starts the session with the one message waiting in it.
        await sleep(12)
        h.setResumable(true)
        await sleep(12)
        expect(h.resumes.length).toBeGreaterThan(1)
        expect(h.sessions.get(home)!.active).toBe(true)
        const comments = h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-item-comment:'))
        expect(comments).toHaveLength(1)
    })

    it('a wake that keeps failing is given up after a while, and taken up again when the machine reports in', async () => {
        setBotWakeRetryDelayForTests(5)
        const h = harness()
        shortWakeGate(h)
        const { botId, home } = await askTwo(h)
        h.sessions.get(home)!.active = false
        h.setResumable(false)

        h.engine.botService.comment('default', botId, '1', { text: 'Yes, go.' })
        await settle()
        await sleep(260)
        // One message, however many tries.
        const comments = () => h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-item-comment:'))
        expect(comments()).toHaveLength(1)
        // Enough tries: no timer is pending, and what is waiting is kept for when the machine reports in.
        const waiting = pendingDeliveries(h).get(home)
        expect(waiting?.timer).toBeNull()
        expect(waiting?.wakeAttempts).toBeGreaterThan(20)
        const asks = h.resumes.length
        await sleep(40)
        expect(h.resumes.length).toBe(asks)

        h.setResumable(true)
        ;(h.engine as unknown as { retryBotWakes: () => void }).retryBotWakes()
        await settle()
        expect(h.sessions.get(home)!.active).toBe(true)
        expect(comments()).toHaveLength(1)
        expect(pendingDeliveries(h).size).toBe(0)
    })

    it('a session that came up by itself is not started again, and one with nothing waiting is never started', async () => {
        setBotWakeRetryDelayForTests(5)
        const h = harness()
        shortWakeGate(h)
        const { botId, home } = await createBot(h)
        h.engine.botService.createItem('default', botId, { title: 'Ship it' })
        h.engine.botService.ask('default', botId, '1', { question: 'Now?', fromSessionId: home })
        h.sessions.get(home)!.active = false
        h.setResumable(false)
        h.engine.botService.comment('default', botId, '1', { text: 'Yes, go.' })
        await settle()
        expect(pendingDeliveries(h).has(home)).toBe(true)

        // It comes up by itself (the owner opened it, its runner re-attached) and takes the message.
        h.sessions.get(home)!.active = true
        const comment = h.hubMessages(home).find((message) => message.localId.startsWith('hapi-item-comment:'))
        h.store.messages.markMessagesInvoked(home, [comment!.localId], Date.now())
        await sleep(60)
        expect(pendingDeliveries(h).size).toBe(0)

        // The owner stops it again: there is nothing waiting, so nothing starts it.
        h.sessions.get(home)!.active = false
        h.resumes.length = 0
        await sleep(60)
        expect(h.resumes).toEqual([])
        expect(h.sessions.get(home)!.active).toBe(false)
    })

    it('a second answer that arrives while the first one is starting the bot is kept too', async () => {
        setBotWakeRetryDelayForTests(5)
        const h = harness()
        shortWakeGate(h)
        // A real resume holds the transcript for as long as its machine round-trip takes.
        h.holdResume(40)
        const { botId, home } = await askTwo(h)
        h.sessions.get(home)!.active = false

        h.engine.botService.comment('default', botId, '1', { text: 'Yes, go.' })
        // Within the resume's round-trip, the owner answers the other question.
        await sleep(10)
        h.engine.botService.comment('default', botId, '2', { text: 'Write them.' })
        await settle()
        const comments = () => h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-item-comment:'))
        expect(comments()).toHaveLength(1)

        await sleep(200)
        expect(comments().map((message) => message.text.includes('Yes, go.') && !message.text.includes('Write them.') ? 'first' : 'second').sort())
            .toEqual(['first', 'second'])
        expect(h.sessions.get(home)!.active).toBe(true)
        expect(pendingDeliveries(h).size).toBe(0)
    })

    it('an answer the store refuses is kept and stored on a later try, not dropped — also when a retry is refused again', async () => {
        setBotWakeRetryDelayForTests(5)
        const h = harness()
        const { botId, home } = await createBot(h)
        h.engine.botService.createItem('default', botId, { title: 'Ship it' })
        h.engine.botService.ask('default', botId, '1', { question: 'Now?', fromSessionId: home })
        // The comment's own event gives its message an id, so the refusals are keyed by the kind of message:
        // the first store attempt and the first retry both fail.
        h.failNextStore('hapi-item-comment:')
        h.failNextStore('hapi-item')
        const warned: string[] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => { warned.push(String(args[0])); originalWarn(...args) }
        try {
            h.engine.botService.comment('default', botId, '1', { text: 'Yes, go.' })
            await settle()
            // Not stored yet, and not lost: it is owed.
            const comments = () => h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-item-comment:'))
            expect(comments()).toEqual([])
            const owed = pendingDeliveries(h).get(home)?.unstored ?? []
            expect(owed).toHaveLength(1)
            expect((owed[0] as { localId: string }).localId).toMatch(/^hapi-item-comment:\d+$/)
            expect((owed[0] as { text: string }).text).toContain('Yes, go.')

            await sleep(40)
            // Stored on the try after that.
            expect(comments()).toHaveLength(1)
            expect(comments()[0].text).toContain('Yes, go.')
            expect(pendingDeliveries(h).size).toBe(0)
        } finally {
            console.warn = originalWarn
        }
        expect(warned.filter((line) => line.includes('could not be stored, will retry'))).toHaveLength(1)
        expect(warned.filter((line) => line.includes('could not be stored, still trying'))).toHaveLength(1)
    })

    it('nothing reports a worker whose heartbeat has not been heard yet', async () => {
        const h = harness()
        const { home } = await createBot(h)
        h.addSession('worker')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })
        // The worker has taken the task and said something on the way; it is mid-turn.
        workerTakes(h.store, 'worker', 'task-1', ['Let me check the file first.'])
        // What a restart leaves in the hub's cache: "not thinking" about every session, whoever is still working.
        h.sessions.get('worker')!.thinking = false
        const receipts = () => h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-receipt:'))

        h.engine.sessionReceipts.retryPending()
        // The look a retry schedules runs on a timer of its own: let it run before judging it.
        await sleep(5)
        expect(receipts()).toEqual([])

        // Its heartbeat says it is still working; the end of that turn reports the real reply.
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: true })
        expect(receipts()).toEqual([])
        h.store.messages.addMessage('worker', { role: 'agent', content: { type: 'text', text: 'Fixed for real.' } })
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: false })
        await settle()
        expect(receipts()).toHaveLength(1)
        expect(receipts()[0].text).toContain('Fixed for real.')
        expect(receipts()[0].text).not.toContain('Let me check the file first.')
    })

    it('a worker that is merely not heard from is given time to come back; one that says it ended is believed', async () => {
        const h = harness()
        const { home } = await createBot(h)
        const receipts = () => h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-receipt:'))

        // The worker's own runtime reports that its session ended: that is final, and reported at once.
        h.addSession('worker')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })
        workerTakes(h.store, 'worker', 'task-1', [])
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: true })
        h.engine.handleSessionEnd({ sid: 'worker', time: Date.now(), reason: 'error' })
        await settle()
        expect(receipts()).toHaveLength(1)
        expect(receipts()[0].text).toContain('it stopped before replying')

        // Another one is lost mid-turn: no end is reported, and the inactivity sweep is the only thing that sees it go.
        h.addSession('worker-2')
        h.engine.sessionReceipts.register('worker-2', { parentSessionId: home, taskLocalId: 'task-2', kind: 'turn_end' })
        workerTakes(h.store, 'worker-2', 'task-2', [])
        h.engine.handleSessionAlive({ sid: 'worker-2', time: Date.now(), thinking: true })
        h.sessions.get('worker-2')!.active = false
        // What `expireInactive` does: the cached session goes inactive, and receipts are told it is gone.
        h.sessions.get('worker-2')!.thinking = false
        h.engine.sessionReceipts.onExpired('worker-2')
        await settle()
        expect(receipts()).toHaveLength(1)
        expect(h.store.sessionReceipts.listUnsettled().map((receipt) => receipt.childSessionId)).toEqual(['worker-2'])

        // It comes back and finishes: that is the reply the bot gets, not a report of its silence.
        h.store.messages.addMessage('worker-2', { role: 'agent', content: { type: 'text', text: 'Network died; all done now.' } })
        h.engine.handleSessionAlive({ sid: 'worker-2', time: Date.now(), thinking: true })
        h.engine.handleSessionAlive({ sid: 'worker-2', time: Date.now(), thinking: false })
        await settle()
        expect(receipts()).toHaveLength(2)
        expect(receipts()[1].text).toContain('Network died; all done now.')
    })
})

describe('SyncEngine: sessions that move or disappear', () => {
    it('a paused bot still holds receipts after the hub restarted (the bot service is rebuilt on demand)', async () => {
        const h = harness()
        const { botId, home } = await createBot(h)
        await h.engine.botService.update('default', botId, { paused: true })
        h.addSession('worker')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })

        // What a restart leaves in a test: no service object until something asks for one, and the first
        // thing a hub start does is load the receipts a previous process left.
        h.internals.receiptService = null
        h.internals.botServiceInstance = null
        h.engine.sessionReceipts.sweep()

        workerTakes(h.store, 'worker', 'task-1', ['Done while you were paused.'])
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: true })
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: false })
        await settle()
        const receipts = () => h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-receipt:'))
        expect(receipts()).toEqual([])
        expect(h.store.sessionReceipts.listUnsettled()).toHaveLength(1)

        await h.engine.botService.update('default', botId, { paused: false })
        await settle()
        expect(receipts()).toHaveLength(1)
        expect(receipts()[0].text).toContain('Done while you were paused.')
    })

    it('archiving a paused bot lets its held receipts go', async () => {
        const h = harness()
        const { botId, home } = await createBot(h)
        await h.engine.botService.update('default', botId, { paused: true })
        h.addSession('worker')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })
        workerTakes(h.store, 'worker', 'task-1', ['Done while you were paused.'])
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: true })
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: false })
        await settle()
        const receipts = () => h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-receipt:'))
        expect(receipts()).toEqual([])

        h.engine.botService.archive('default', botId)
        await settle()
        expect(receipts()).toHaveLength(1)
        expect(h.store.sessionReceipts.listUnsettled()).toEqual([])
    })

    it('receipts follow a worker that was merged into another session', async () => {
        const h = harness()
        const { home } = await createBot(h)
        h.addSession('worker')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: true })

        // Both halves of the merge, as the session cache and the engine hook do them.
        h.store.sessionReceipts.transfer('worker', 'worker-2')
        const internals = h.engine as unknown as { onSessionMergedAway: (oldId: string, newId: string) => void }
        internals.onSessionMergedAway('worker', 'worker-2')
        h.addSession('worker-2')
        expect(h.engine.botService.workers('default', h.engine.botService.homeChatBot(home)!.id).map((worker) => worker.sessionId)).toEqual(['worker-2'])

        workerTakes(h.store, 'worker-2', 'task-1', ['Done under my new id.'])
        // The turn it was on when merged ends under the new id.
        h.engine.handleSessionAlive({ sid: 'worker-2', time: Date.now(), thinking: true })
        h.engine.handleSessionAlive({ sid: 'worker-2', time: Date.now(), thinking: false })
        await settle()
        const receipts = h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-receipt:'))
        expect(receipts).toHaveLength(1)
        expect(receipts[0].text).toContain('Done under my new id.')
    })

    it('deleting the home chat marks the bot failed and fails the receipts around it', async () => {
        const h = harness()
        const { botId, home } = await createBot(h)
        h.addSession('worker')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })

        await h.engine.deleteSession(home)
        expect(h.engine.botService.get('default', botId)).toMatchObject({ state: 'failed' })
        expect(h.engine.botService.get('default', botId).lastError).toContain('home chat was deleted')
        // From then on that conversation is nobody's home chat: no bot tools on its next start.
        expect(h.engine.botService.botIdForHomeChat(home)).toBeUndefined()
        expect(h.engine.botService.peerToolsDisabledFor(home, true, true)).toBe(true)
        expect(h.store.sessionReceipts.listUnsettled()).toEqual([])
        // The worker finishing now posts nothing anywhere.
        workerTakes(h.store, 'worker', 'task-1', ['Too late.'])
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: true })
        h.engine.handleSessionAlive({ sid: 'worker', time: Date.now(), thinking: false })
        await settle()
        expect(h.store.messages.getMessages(home)).toEqual([])
    })

    it('one request answered and another raised in the same update still tells the bot', async () => {
        const h = harness()
        const { home } = await createBot(h)
        h.addSession('worker')
        h.store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        h.engine.sessionReceipts.register('worker', { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' })
        const request = { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 5 }
        const send = (requests: Record<string, unknown>) =>
            h.engine.handleRealtimeEvent({ type: 'session-updated', sessionId: 'worker', data: { agentState: { value: { requests }, version: 1 } } } as never)
        send({ r1: request })
        await settle()
        const notices = () => h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-worker-request:')).map((message) => message.localId)
        expect(notices()).toEqual(['hapi-worker-request:worker:r1'])

        // Same count, different request.
        send({ r2: request })
        await settle()
        expect(notices()).toEqual(['hapi-worker-request:worker:r1', 'hapi-worker-request:worker:r2'])

        // Answered: the owner's lists are told, the bot is not told twice.
        h.events.length = 0
        send({})
        await settle()
        expect(notices()).toHaveLength(2)
        expect(h.events.filter((event) => event.type === 'bots-changed' || event.type === 'bot-items-changed').length).toBe(2)
    })

    it('a schedule stopped by pausing the bot goes back on its time when the bot resumes; it is not run at once', async () => {
        const h = harness()
        const { botId, home } = await createBot(h)
        // A round due in six hours.
        const at = Date.now() + 6 * 60 * 60_000
        const task = h.store.sessionTasks.create({
            sessionId: home, kind: 'repeat', items: ['Tick.'], intervalMs: 24 * 60 * 60_000, maxRuns: null, startAt: at, nextRunAt: at
        })
        await h.engine.botService.update('default', botId, { paused: true })
        expect(h.store.sessionTasks.get(home, task.id)).toMatchObject({ state: 'paused', nextRunAt: null })

        await h.engine.botService.update('default', botId, { paused: false })
        // Resuming a task by hand would run it now; this is where it was.
        expect(h.store.sessionTasks.get(home, task.id)).toMatchObject({ state: 'active', nextRunAt: at })
        expect(h.hubMessages(home).filter((message) => message.localId.startsWith('hapi-task:'))).toEqual([])
    })

    it('a schedule that fell due while the bot was paused is handed back with its own time, so the runner keeps its grid', async () => {
        const h = harness()
        const { botId, home } = await createBot(h)
        // An hourly round that fell due seven minutes ago.
        const overdue = Date.now() - 7 * 60_000
        const task = h.store.sessionTasks.create({
            sessionId: home, kind: 'repeat', items: ['Round.'], intervalMs: 60 * 60_000, maxRuns: null, startAt: overdue - 53 * 60_000, nextRunAt: overdue
        })
        await h.engine.botService.update('default', botId, { paused: true })
        // The runner's tick is not this test's subject; what the bot's resume hands to the store is.
        ;(h.engine as unknown as { runSessionTaskTick: () => void }).runSessionTaskTick = () => undefined
        await h.engine.botService.update('default', botId, { paused: false })
        const resumed = h.store.sessionTasks.get(home, task.id)
        expect(resumed?.state).toBe('active')
        // Not "now": with its own time the runner sends it once and puts the next one on the original grid.
        expect(resumed?.nextRunAt).toBe(overdue)
    })

    describe('pausing with the scheduler at work', () => {
        /**
         * The real task runner on the real store, with the message service's
         * cancel standing in for the agent's process: it answers at once,
         * either that it dropped the prompt (the row goes) or, once `taken`
         * was called, that the agent had taken the prompt already.
         */
        function agentAnswers(h: ReturnType<typeof harness>) {
            const internals = h.engine as unknown as {
                cancelQueuedMessage: (sessionId: string, localId: string) => Promise<unknown>
                runSessionTaskTick: () => void
                sessionTaskRunner: { tick: () => Promise<void> }
                followUpCancels: () => Promise<void>
                messageService: { hasCliSocket: (sessionId: string) => boolean; requestCliCancelAck: () => Promise<unknown> }
                eventPublisher: { sendToast: () => Promise<number> }
            }
            /** Every prompt the hub asked to have dropped. */
            const cancels: string[] = []
            let takenAlready = false
            /** Whether the agent's process is in the room for the hub to ask, and what it answers about a prompt it may hold. */
            const cli = { present: true, answer: 'removed' as 'removed' | 'consumed' | 'timeout' }
            internals.messageService.hasCliSocket = () => cli.present
            internals.messageService.requestCliCancelAck = async () => ({ result: cli.answer, responderId: null })
            internals.eventPublisher.sendToast = async () => 1
            internals.cancelQueuedMessage = async (sessionId, localId) => {
                cancels.push(localId)
                if (!cli.present) {
                    // Nobody to ask, as when the home chat's process is not running: the row goes, but nobody confirmed the copy.
                    h.store.messages.deleteQueuedMessageById(sessionId, localId)
                    return { status: 'cancelled', localId, unconfirmed: true }
                }
                if (takenAlready) {
                    h.store.messages.markMessagesInvoked(sessionId, [localId], Date.now())
                    const lookup = h.store.messages.lookupQueuedMessage(sessionId, localId)
                    return lookup.status === 'invoked' ? { status: 'invoked', message: lookup.message } : { status: 'busy', localId }
                }
                h.store.messages.deleteQueuedMessageById(sessionId, localId)
                return { status: 'cancelled', localId }
            }
            /** The ticks the engine starts, so a test can wait for them instead of guessing. */
            const ticks: Promise<void>[] = []
            internals.runSessionTaskTick = () => { ticks.push(internals.sessionTaskRunner.tick()) }
            /** One tick of the scheduler now (the hub's timer, which these tests do not run). */
            const tick = () => ticks.push(internals.sessionTaskRunner.tick())
            /** The hub's follow-up of cancelled prompts nobody confirmed (on the same timer): asks whichever CLI is in the room now. */
            const followUp = async () => { await internals.followUpCancels(); await Promise.all(ticks) }
            return { cancels, tick, ticks, followUp, cli, taken: () => { takenAlready = true } }
        }

        const HOUR = 60 * 60_000
        const taskIn = (h: ReturnType<typeof harness>, home: string, id: string) => h.store.sessionTasks.get(home, id) as StoredSessionTask
        /** The prompts of a task that are in the session (queued or taken). */
        const prompts = (h: ReturnType<typeof harness>, home: string, id: string) => h.store.messages.getMessages(home)
            .map((message) => ({ localId: message.localId ?? '', text: (message.content as { content: { text: string } }).content.text }))
            .filter((message) => message.localId.startsWith(`${SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX}${id}:`))

        it('a prompt the pause took back goes out again when the bot resumes, and is counted once', async () => {
            const h = harness()
            const { botId, home } = await createBot(h)
            const agent = agentAnswers(h)
            // A queue of two prompts; the first is out and waiting for the agent.
            const created = h.engine.createSessionTask(home, { kind: 'queue', items: [{ text: 'First.' }, { text: 'Second.' }], intervalMs: HOUR })
            if (created.type !== 'created') throw new Error(created.type)
            const id = created.task.id
            await Promise.all(agent.ticks)
            const waiting = taskIn(h, home, id)
            expect(waiting).toMatchObject({ state: 'active', runCount: 1, pendingLocalId: buildSessionTaskMessageLocalId(id, 1) })
            expect(prompts(h, home, id).map((message) => message.text)).toEqual(['First.'])

            // The pause asks for the waiting prompt back before it answers: the task is as before that send.
            await h.engine.botService.update('default', botId, { paused: true })
            expect(agent.cancels).toEqual([waiting.pendingLocalId as string])
            expect(taskIn(h, home, id)).toMatchObject({ state: 'paused', runCount: 0, pendingLocalId: null, nextRunAt: null })
            expect(prompts(h, home, id)).toEqual([])

            // Resumed a moment later: the prompt goes out again, as the same run, and nothing else does.
            await h.engine.botService.update('default', botId, { paused: false })
            await Promise.all(agent.ticks)
            expect(taskIn(h, home, id)).toMatchObject({ state: 'active', runCount: 1, pendingLocalId: waiting.pendingLocalId })
            expect(prompts(h, home, id).map((message) => message.text)).toEqual(['First.'])
        })

        it('a round whose prompt the pause took back goes back on its grid when the bot resumes; it is not sent at once', async () => {
            const h = harness()
            const { botId, home } = await createBot(h)
            const agent = agentAnswers(h)
            const before = Date.now()
            const created = h.engine.createSessionTask(home, { kind: 'repeat', text: 'Round.', intervalMs: HOUR })
            if (created.type !== 'created') throw new Error(created.type)
            const id = created.task.id
            await Promise.all(agent.ticks)
            const sent = taskIn(h, home, id)
            // An hour after it went out: the next slot of its grid.
            const nextSlot = sent.nextRunAt as number
            expect(nextSlot).toBeGreaterThanOrEqual(before + HOUR)

            await h.engine.botService.update('default', botId, { paused: true })
            expect(taskIn(h, home, id)).toMatchObject({ state: 'paused', runCount: 0 })

            await h.engine.botService.update('default', botId, { paused: false })
            expect(taskIn(h, home, id)).toMatchObject({ state: 'active', runCount: 0, nextRunAt: nextSlot })
            await Promise.all(agent.ticks)
            expect(prompts(h, home, id)).toEqual([])
        })

        it('a prompt the agent had taken already is not sent again: the task goes on from after it, at its spacing', async () => {
            const h = harness()
            const { botId, home } = await createBot(h)
            const agent = agentAnswers(h)
            const created = h.engine.createSessionTask(home, { kind: 'queue', items: [{ text: 'First.' }, { text: 'Second.' }], intervalMs: HOUR })
            if (created.type !== 'created') throw new Error(created.type)
            const id = created.task.id
            await Promise.all(agent.ticks)

            // The agent takes the first prompt just as the pause asks for it back.
            agent.taken()
            await h.engine.botService.update('default', botId, { paused: true })
            // The scheduler's next look settles it: the prompt was taken, so the run counts.
            agent.tick()
            await Promise.all(agent.ticks)
            const paused = taskIn(h, home, id)
            expect(paused).toMatchObject({ state: 'paused', runCount: 1, pendingLocalId: null, nextRunAt: null })

            await h.engine.botService.update('default', botId, { paused: false })
            const resumed = taskIn(h, home, id)
            // With nothing pending and nothing scheduled the task would never run again; it is given what a
            // resume by hand gives it: the next prompt an hour after the take, not now.
            expect(resumed).toMatchObject({ state: 'active', runCount: 1, pendingLocalId: null })
            expect(resumed.nextRunAt).toBeGreaterThanOrEqual((resumed.lastConsumedAt as number) + HOUR)
            await Promise.all(agent.ticks)
            expect(prompts(h, home, id).map((message) => message.text)).toEqual(['First.'])
        })

        it('a schedule the owner edited while the bot was paused stays paused when the bot resumes', async () => {
            const h = harness()
            const { botId, home } = await createBot(h)
            const agent = agentAnswers(h)
            const created = h.engine.createSessionTask(home, { kind: 'repeat', text: 'Round.', intervalMs: HOUR })
            if (created.type !== 'created') throw new Error(created.type)
            const id = created.task.id
            await Promise.all(agent.ticks)

            await h.engine.botService.update('default', botId, { paused: true })
            // An edit alone never resumes a task.
            expect(await h.engine.updateSessionTask(home, id, { intervalMs: 2 * HOUR })).toMatchObject({ type: 'updated' })
            await h.engine.botService.update('default', botId, { paused: false })
            expect(taskIn(h, home, id)).toMatchObject({ state: 'paused', intervalMs: 2 * HOUR })
            await Promise.all(agent.ticks)
            expect(prompts(h, home, id)).toEqual([])
        })

        it("what does not fit the session's cap on active tasks when the bot resumes stays paused", async () => {
            const h = harness()
            const { botId, home } = await createBot(h)
            const agent = agentAnswers(h)
            const far = Date.now() + 30 * 24 * HOUR
            const make = (text: string) => h.store.sessionTasks.create({
                sessionId: home, kind: 'repeat', items: [text], intervalMs: 24 * HOUR, maxRuns: null, startAt: far, nextRunAt: far
            })
            const mine = [make('a'), make('b'), make('c')]
            await h.engine.botService.update('default', botId, { paused: true })

            // While the bot is paused the owner fills the session up to two below its cap.
            for (let index = 0; index < SESSION_TASK_MAX_ACTIVE_PER_SESSION - 2; index++) make(`owner-${index}`)
            await h.engine.botService.update('default', botId, { paused: false })
            // Which two of the three is not fixed (they tie on their times); how many is.
            expect(mine.map((task) => taskIn(h, home, task.id).state).sort()).toEqual(['active', 'active', 'paused'])
            expect(h.store.sessionTasks.countActive(home)).toBe(SESSION_TASK_MAX_ACTIVE_PER_SESSION)
            // The one left behind stays on record with the (running) bot, so that it is not forgotten.
            const left = mine.filter((task) => taskIn(h, home, task.id).state === 'paused')
            expect(h.store.bots.get(botId)).toMatchObject({ state: 'active', pausedTasks: left.map((task) => ({ id: task.id, fingerprint: expect.any(String), nextRunAt: far })) })

            // Room made, and the bot paused and resumed once more: it starts with the rest.
            h.store.sessionTasks.delete(h.store.sessionTasks.list(home).find((task) => task.items[0] === 'owner-0')!.id)
            await h.engine.botService.update('default', botId, { paused: true })
            await h.engine.botService.update('default', botId, { paused: false })
            expect(mine.map((task) => taskIn(h, home, task.id).state)).toEqual(['active', 'active', 'active'])
            expect(h.store.bots.get(botId)?.pausedTasks).toEqual([])
            expect(h.store.sessionTasks.countActive(home)).toBe(SESSION_TASK_MAX_ACTIVE_PER_SESSION)
            await Promise.all(agent.ticks)
        })

        it('nobody was there to confirm the pause took the prompt back: it is not sent again until the agent\'s process has said it dropped it', async () => {
            const h = harness()
            const { botId, home } = await createBot(h)
            const agent = agentAnswers(h)
            const created = h.engine.createSessionTask(home, { kind: 'queue', items: [{ text: 'First.' }, { text: 'Second.' }], intervalMs: HOUR })
            if (created.type !== 'created') throw new Error(created.type)
            const id = created.task.id
            await Promise.all(agent.ticks)
            const waiting = taskIn(h, home, id)

            // The home chat's process is gone (the machine asleep, the session not running), so the prompt waits in the hub.
            agent.cli.present = false
            await h.engine.botService.update('default', botId, { paused: true })
            expect(taskIn(h, home, id)).toMatchObject({ state: 'paused', runCount: 0, pendingLocalId: null })

            // Resumed with the process still away: the task is due, but the hub keeps that prompt back until a process answers for it.
            await h.engine.botService.update('default', botId, { paused: false })
            await Promise.all(agent.ticks)
            expect(taskIn(h, home, id)).toMatchObject({ state: 'active', runCount: 0 })
            expect(prompts(h, home, id)).toEqual([])

            // The process is back and says it holds nothing: the prompt goes out, once.
            agent.cli.present = true
            agent.cli.answer = 'removed'
            await agent.followUp()
            expect(taskIn(h, home, id)).toMatchObject({ state: 'active', runCount: 1, pendingLocalId: waiting.pendingLocalId })
            expect(prompts(h, home, id).map((message) => message.text)).toEqual(['First.'])
        })

        it('the process reports the agent had taken the prompt after all: a round that has run its limit is over when the bot resumes', async () => {
            const h = harness()
            const { botId, home } = await createBot(h)
            const agent = agentAnswers(h)
            const created = h.engine.createSessionTask(home, { kind: 'repeat', text: 'Round.', intervalMs: HOUR, maxRuns: 1 })
            if (created.type !== 'created') throw new Error(created.type)
            const id = created.task.id
            await Promise.all(agent.ticks)

            agent.cli.present = false
            await h.engine.botService.update('default', botId, { paused: true })
            // Back, and it says the agent took the prompt: the run counts again. (The task is paused, so the hub leaves it there.)
            agent.cli.present = true
            agent.cli.answer = 'consumed'
            await agent.followUp()
            expect(taskIn(h, home, id)).toMatchObject({ state: 'paused', runCount: 1, pendingLocalId: null })

            // Nothing is left to send: the task ends, as it does after a resume by hand, instead of sending a second round.
            await h.engine.botService.update('default', botId, { paused: false })
            expect(h.store.sessionTasks.get(home, id)).toBeNull()
            expect(h.store.bots.get(botId)).toMatchObject({ state: 'active', pausedTasks: [] })
            // (The hub's own row of the first prompt went with the cancel; what the agent holds is its own transcript.)
            // Nothing else goes out.
            await Promise.all(agent.ticks)
            expect(prompts(h, home, id)).toEqual([])
            expect(h.hubMessages(home).filter((message) => message.localId.startsWith(SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX))).toEqual([])
        })
    })

    it('a creation interrupted by a restart goes stale on the tick, not only at the next start', async () => {
        const h = harness()
        const { botId } = await createBot(h)
        // A restart that came too soon for the start-up sweep to see it as stale.
        h.store.bots.update(botId, { state: 'creating' }, Date.now() - 11 * 60_000)
        void h.engine.botService
        const internals = h.engine as unknown as { botSweepTick: number; sweepStaleBots: () => void }
        internals.botSweepTick = 11
        internals.sweepStaleBots()
        expect(h.store.bots.get(botId)?.state).toBe('failed')

        // Once a minute, not on every tick.
        h.store.bots.update(botId, { state: 'creating' }, Date.now() - 11 * 60_000)
        internals.sweepStaleBots()
        expect(h.store.bots.get(botId)?.state).toBe('creating')
        internals.botSweepTick = 11
        internals.sweepStaleBots()
        expect(h.store.bots.get(botId)?.state).toBe('failed')
    })
})

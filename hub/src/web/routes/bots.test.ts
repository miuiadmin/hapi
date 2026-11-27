import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { BotSessionView } from '../../bots/botService'
import { BotService } from '../../bots/botService'
import { Store } from '../../store'
import { SessionReceiptService } from '../../sync/sessionReceiptService'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createBotRoutes } from './bots'

function setup(options: { machineOnline?: boolean } = {}) {
    const store = new Store(':memory:')
    const sessions = new Map<string, BotSessionView>()
    let spawned = 0
    const receipts = new SessionReceiptService({
        store,
        getSession: (sessionId) => sessions.get(sessionId) ?? null,
        wake: async () => true,
        sendMessage: async (sessionId, payload) => {
            if (store.messages.lookupQueuedMessage(sessionId, payload.localId).status !== 'absent') return
            store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: payload.text } }, payload.localId)
        },
        setTimer: () => 0,
        clearTimer: () => undefined
    })
    // The engine's namespace-aware session lookup, as the real one answers for stored rows.
    const resolveSessionAccess = (sessionId: string, namespace: string) => {
        const stored = store.sessions.getSession(sessionId)
        return stored && stored.namespace === namespace
            ? { ok: true as const, sessionId, session: { id: sessionId } }
            : { ok: false as const, reason: 'not-found' as const }
    }
    const bots = new BotService({
        store,
        getSession: (sessionId) => sessions.get(sessionId) ?? null,
        sessionInNamespace: (sessionId, namespace) => resolveSessionAccess(sessionId, namespace).ok,
        getMachine: (machineId) => machineId === 'mac' ? { id: machineId, namespace: 'default' } : null,
        isMachineOnline: () => options.machineOnline ?? true,
        receiptChildrenOf: (parentSessionId) => receipts.watchedChildrenOf(parentSessionId),
        prepareHome: async (_machineId, request) => ({ path: `/resolved${request.path.replace(/^~\/?/, '/home/me/')}`, seeded: true }),
        spawnHomeChat: async (input) => {
            const sessionId = input.sessionId
            store.sessions.getOrCreateSession(sessionId, { path: '/tmp', flavor: 'claude' }, null, 'default', undefined, undefined, undefined, sessionId)
            sessions.set(sessionId, { id: sessionId, name: 'Ops', active: true, thinking: false })
            return { sessionId }
        },
        deliver: async (sessionId, text, localId) => {
            if (store.messages.lookupQueuedMessage(sessionId, localId).status !== 'absent') return
            store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text } }, localId)
        },
        queueMessage: async (sessionId, text, localId) => {
            if (store.messages.lookupQueuedMessage(sessionId, localId).status !== 'absent') return
            store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text } }, localId)
        },
        hasMessage: (sessionId, localId) => store.messages.lookupQueuedMessage(sessionId, localId).status !== 'absent',
        permissionModesFor: () => ['default', 'bypassPermissions'],
        listTasks: () => [],
        setTasksPaused: async () => undefined,
        resumeTasksAt: () => [],
        releaseReceipts: () => undefined,
        emit: () => undefined
    })
    const engine = {
        botService: bots,
        sessionReceipts: receipts,
        getSession: (sessionId: string) => sessions.get(sessionId) ?? null,
        resolveSessionAccess,
        sessionHasMessage: (sessionId: string, localId: string) =>
            store.messages.lookupQueuedMessage(sessionId, localId).status !== 'absent'
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createBotRoutes(() => engine))
    return { app, store, bots, base: 'http://localhost/api' }
}

async function call(app: Hono<WebAppEnv>, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
    const res = await app.request(`http://localhost/api${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }
    })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function createBot(app: Hono<WebAppEnv>) {
    const created = await call(app, 'POST', '/bots', { name: 'Ops', purpose: 'keeps CI green', machineId: 'mac' })
    return { bot: created.body.bot as { id: string; homeChatSessionId: string }, created }
}

describe('bot routes: bots', () => {
    it('starts with no bots and creates one', async () => {
        const { app } = setup()
        expect(await call(app, 'GET', '/bots')).toEqual({ status: 200, body: { bots: [] } })

        const { bot, created } = await createBot(app)
        expect(created.status).toBe(201)
        expect(created.body.bot).toMatchObject({ id: bot.id, name: 'Ops', state: 'active', homeChatSessionId: bot.homeChatSessionId })

        const listed = await call(app, 'GET', '/bots')
        expect((listed.body.bots as Array<{ id: string }>).map((entry) => entry.id)).toEqual([bot.id])
        expect(await call(app, 'GET', `/bots/${bot.id}`)).toMatchObject({ status: 200, body: { bot: { id: bot.id } } })
    })

    it('answers a refused creation with its code', async () => {
        const { app } = setup()
        expect((await call(app, 'POST', '/bots', { name: '   ', machineId: 'mac' })).status).toBe(400)
        expect((await call(app, 'POST', '/bots', { name: 'Ops', machineId: 'mac', colour: 'red' })).status).toBe(400)
        await createBot(app)
        expect(await call(app, 'POST', '/bots', { name: 'ops', machineId: 'mac' })).toMatchObject({ status: 409, body: { code: 'name_taken' } })
        expect(await call(app, 'POST', '/bots', { name: 'Two', machineId: 'mac', agent: 'nope' })).toMatchObject({ status: 400, body: { code: 'unknown_agent' } })
        expect(await call(app, 'POST', '/bots', { name: 'Two', machineId: 'elsewhere' })).toMatchObject({ status: 404, body: { code: 'machine_not_found' } })
    })

    it('refuses to create a bot on a machine that is offline', async () => {
        const { app } = setup({ machineOnline: false })
        expect(await call(app, 'POST', '/bots', { name: 'Ops', machineId: 'mac' })).toMatchObject({ status: 503, body: { code: 'machine_offline' } })
        expect(await call(app, 'GET', '/bots')).toEqual({ status: 200, body: { bots: [] } })
    })

    it('updates and archives, and hides another namespace\'s bot', async () => {
        const { app } = setup()
        const { bot } = await createBot(app)

        expect(await call(app, 'PATCH', `/bots/${bot.id}`, { paused: true })).toMatchObject({ status: 200, body: { bot: { state: 'paused' } } })
        expect((await call(app, 'PATCH', `/bots/${bot.id}`, { paused: false })).body.bot).toMatchObject({ state: 'active' })
        expect((await call(app, 'PATCH', `/bots/${bot.id}`, { colour: 'red' })).status).toBe(400)
        expect(await call(app, 'GET', '/bots/nope')).toMatchObject({ status: 404, body: { code: 'bot_not_found' } })

        expect(await call(app, 'DELETE', `/bots/${bot.id}`)).toEqual({ status: 200, body: { ok: true } })
        expect(await call(app, 'GET', `/bots/${bot.id}`)).toMatchObject({ status: 404 })
        expect(await call(app, 'GET', '/bots')).toEqual({ status: 200, body: { bots: [] } })
    })
})

describe('bot routes: ledger', () => {
    it('walks an item from creation to the owner\'s answer', async () => {
        const { app } = setup()
        const { bot } = await createBot(app)
        const home = bot.homeChatSessionId

        const created = await call(app, 'POST', `/bots/${bot.id}/items`, { title: 'Ship the release', detail: 'after CI', status: 'working' })
        expect(created.status).toBe(200)
        expect(created.body.item).toMatchObject({ number: 1, status: 'working', sessionId: home })
        expect(created.body.event).toMatchObject({ kind: 'created', actor: 'user' })
        expect((await call(app, 'POST', `/bots/${bot.id}/items`, { title: '  ' })).status).toBe(400)

        // Only the bot's home chat may put the item to the owner.
        expect(await call(app, 'POST', `/bots/${bot.id}/items/1/ask`, { question: 'Ship today?' })).toMatchObject({ status: 403, body: { code: 'bot_only' } })
        expect(await call(app, 'POST', `/bots/${bot.id}/items/1/ask`, { question: 'Ship today?', fromSessionId: 'impostor' })).toMatchObject({ status: 403, body: { code: 'not_bot_home_chat' } })
        const asked = await call(app, 'POST', `/bots/${bot.id}/items/#1/ask`, {
            question: 'Ship today?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 0, fromSessionId: home
        })
        expect(asked).toMatchObject({ status: 200, body: { item: { status: 'needs_you', ask: { question: 'Ship today?' } } } })

        expect(await call(app, 'GET', `/bots/${bot.id}/needs-you`)).toMatchObject({
            status: 200,
            body: { entries: [{ kind: 'question', number: 1, title: 'Ship the release', ask: { question: 'Ship today?' } }] }
        })
        expect(await call(app, 'GET', `/bots/${bot.id}/workers`)).toEqual({ status: 200, body: { workers: [] } })

        const answered = await call(app, 'POST', `/bots/${bot.id}/items/1/comments`, { text: 'No, CI is red.' })
        expect(answered.status).toBe(200)
        expect(answered.body.item).toMatchObject({ status: 'working', ask: null })
        expect(answered.body.event).toMatchObject({ kind: 'answered', actor: 'user', text: 'No, CI is red.' })
        expect((await call(app, 'POST', `/bots/${bot.id}/items/1/comments`, { text: '   ' })).status).toBe(400)

        expect(await call(app, 'PATCH', `/bots/${bot.id}/items/1`, { status: 'done' })).toMatchObject({ status: 200, body: { item: { status: 'done' } } })
        expect(await call(app, 'PATCH', `/bots/${bot.id}/items/1`, { status: 'needs_you' })).toMatchObject({ status: 400, body: { code: 'invalid_status' } })
        expect(await call(app, 'GET', `/bots/${bot.id}/items`)).toMatchObject({ status: 200, body: { items: [{ number: 1, status: 'done' }] } })
        const events = await call(app, 'GET', `/bots/${bot.id}/items/1/events`)
        expect((events.body.events as Array<{ kind: string }>).map((event) => event.kind)).toEqual(['created', 'ask', 'answered', 'status'])
        expect(await call(app, 'GET', `/bots/${bot.id}/items/9/events`)).toMatchObject({ status: 404, body: { code: 'item_not_found' } })
    })
})

describe('bot routes: receipts', () => {
    it('registers one receipt per message for a session the caller may reach', async () => {
        const { app, store } = setup()
        const home = (await createBot(app)).bot.homeChatSessionId
        store.sessions.getOrCreateSession('worker', { path: '/tmp', flavor: 'claude' }, null, 'default', undefined, undefined, undefined, 'worker')
        store.sessions.getOrCreateSession('tenant-worker', { path: '/tmp', flavor: 'claude' }, null, 'tenant', undefined, undefined, undefined, 'tenant-worker')
        store.sessions.getOrCreateSession('tenant-bot', { path: '/tmp', flavor: 'claude' }, null, 'tenant', undefined, undefined, undefined, 'tenant-bot')

        const body = { parentSessionId: home, taskLocalId: 'task-1', kind: 'turn_end' }
        // A registration answers a message the caller sent first; one that was never sent names nothing.
        expect(await call(app, 'POST', '/sessions/worker/receipts', body)).toMatchObject({ status: 404, body: { code: 'task_not_found' } })
        // The reply would be posted into the parent and would wake it: it has to be this namespace's session.
        expect(await call(app, 'POST', '/sessions/worker/receipts', { ...body, parentSessionId: 'tenant-bot' })).toMatchObject({ status: 404, body: { code: 'parent_not_found' } })
        expect(store.sessionReceipts.listUnsettled()).toEqual([])

        store.messages.addMessage('worker', { role: 'user', content: { type: 'text', text: 'the task' } }, 'task-1')
        const first = await call(app, 'POST', '/sessions/worker/receipts', body)
        expect(first.status).toBe(201)
        expect(first.body.receipt).toMatchObject({ childSessionId: 'worker', parentSessionId: home, taskLocalId: 'task-1', state: 'pending' })
        const again = await call(app, 'POST', '/sessions/worker/receipts', body)
        expect(again.status).toBe(201)
        expect((again.body.receipt as { id: string }).id).toBe((first.body.receipt as { id: string }).id)
        expect(store.sessionReceipts.listUnsettled()).toHaveLength(1)

        expect((await call(app, 'POST', '/sessions/worker/receipts', { ...body, kind: 'request' })).status).toBe(400)
        expect((await call(app, 'POST', '/sessions/worker/receipts', { parentSessionId: home, kind: 'turn_end' })).status).toBe(400)
        expect(await call(app, 'POST', '/sessions/worker/receipts', { ...body, parentSessionId: 'no-such-session' })).toMatchObject({ status: 404, body: { code: 'parent_not_found' } })
        expect(await call(app, 'POST', '/sessions/no-such-worker/receipts', body)).toMatchObject({ status: 404 })
        // Another namespace's worker is not this caller's to register a receipt for, existing or not.
        expect(await call(app, 'POST', '/sessions/tenant-worker/receipts', body)).toMatchObject({ status: 404 })
    })

    it('does not let a bot link its ledger to a session of another namespace', async () => {
        const { app, store } = setup()
        const { bot } = await createBot(app)
        store.sessions.getOrCreateSession('tenant-worker', { path: '/tmp', flavor: 'claude' }, null, 'tenant', undefined, undefined, undefined, 'tenant-worker')

        expect(await call(app, 'POST', `/bots/${bot.id}/items`, { title: 'No', workerSessionId: 'tenant-worker' })).toMatchObject({ status: 404, body: { code: 'worker_not_found' } })
        const created = await call(app, 'POST', `/bots/${bot.id}/items`, { title: 'Mine' })
        expect(created.status).toBe(200)
        expect(await call(app, 'PATCH', `/bots/${bot.id}/items/1`, { workerSessionId: 'tenant-worker' })).toMatchObject({ status: 404, body: { code: 'worker_not_found' } })
        expect((store.bots.listItems(bot.id)[0]?.workerSessionId)).toBeNull()
    })
})

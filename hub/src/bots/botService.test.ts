import { describe, expect, it } from 'bun:test'
import type { AgentStateRequest } from '@hapi/protocol'
import { buildBotItemCommentMessageLocalId, buildBotKickoffMessageLocalId, buildBotRequestNoticeMessageLocalId } from '@hapi/protocol'
import { Store } from '../store'
import { BOT_CREATION_STALE_MS, BotError, BotService, type BotEvent, type BotSessionView } from './botService'

type FakeTask = { id: string; state: string; nextRunAt: number | null; pendingLocalId: string | null; fingerprint: string }

type Harness = {
    store: Store
    sessions: Map<string, BotSessionView>
    /** The namespace each fake session belongs to. */
    namespaces: Map<string, string>
    machines: Map<string, { id: string; namespace: string; online: boolean }>
    receiptChildren: Map<string, string[]>
    prepared: Array<{ machineId: string; path: string; name: string }>
    /** For each launch: the id the bot was recorded under, and the id asked of the machine. */
    homeChatIds: Array<[string | null | undefined, string]>
    spawned: Array<Parameters<BotServiceDeps['spawnHomeChat']>[0]>
    delivered: Array<{ sessionId: string; text: string; localId: string }>
    /** First runs, stored without a wake. */
    queued: Array<{ sessionId: string; text: string; localId: string }>
    deliverError: Error | null
    events: BotEvent[]
    /** The home chats' tasks, as the task store would report them. */
    tasks: Map<string, FakeTask[]>
    taskPauseCalls: Array<[string, string[], boolean]>
    /**
     * Run while a pause is under way. The hub takes a waiting prompt back
     * before it answers, so a pause is not over when it is called.
     */
    whilePausing: (() => Promise<void>) | null
    /** Tasks the fake hub fails to change when asked to pause them. */
    unstoppable: string[]
    /** Schedules put back by a resume: session, task, and when it is due next. */
    taskResumes: Array<[string, string, number | null]>
    /** Tasks the fake hub leaves paused on a resume (the session is at its cap of active tasks). */
    leftPaused: string[]
    receiptReleases: string[]
    /** The permission modes the fake agent offers. */
    modes: string[]
    service: BotService
    spawnResult: (input: Parameters<BotServiceDeps['spawnHomeChat']>[0]) => { sessionId: string } | { error: string }
    /** What the machine reports as the prepared folder; the default is an absolute path. */
    preparedPath: ((request: { path: string; name: string }) => string) | null
    prepareError: Error | null
    storedSessions: Set<string>
    now: number
}

type BotServiceDeps = ConstructorParameters<typeof BotService>[0]

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve()
}

function makeHarness(): Harness {
    const store = new Store(':memory:')
    const h: Harness = {
        store,
        sessions: new Map(),
        namespaces: new Map(),
        machines: new Map(),
        receiptChildren: new Map(),
        prepared: [],
        homeChatIds: [],
        spawned: [],
        delivered: [],
        queued: [],
        deliverError: null,
        events: [],
        tasks: new Map(),
        taskPauseCalls: [],
        whilePausing: null,
        unstoppable: [],
        taskResumes: [],
        leftPaused: [],
        receiptReleases: [],
        modes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
        spawnResult: () => ({ error: 'spawnResult not configured' }),
        preparedPath: null,
        prepareError: null,
        storedSessions: new Set(),
        service: null as unknown as BotService,
        now: 5_000_000
    }
    const remember = (sessionId: string) => {
        if (!h.storedSessions.has(sessionId)) {
            store.sessions.getOrCreateSession(sessionId, { path: '/tmp', flavor: 'claude' }, null, 'default', undefined, undefined, undefined, sessionId)
            h.storedSessions.add(sessionId)
        }
    }
    h.service = new BotService({
        store,
        getSession: (sessionId) => h.sessions.get(sessionId) ?? null,
        sessionInNamespace: (sessionId, namespace) => h.namespaces.get(sessionId) === namespace,
        getMachine: (machineId) => h.machines.get(machineId) ?? null,
        isMachineOnline: (machineId) => h.machines.get(machineId)?.online ?? false,
        receiptChildrenOf: (parentSessionId) => h.receiptChildren.get(parentSessionId) ?? [],
        prepareHome: async (machineId, request) => {
            if (h.prepareError) throw h.prepareError
            h.prepared.push({ machineId, path: request.path, name: request.name })
            return { path: h.preparedPath ? h.preparedPath(request) : `/resolved${request.path.replace(/^~\/?/, '/home/me/')}`, seeded: true }
        },
        spawnHomeChat: async (input) => {
            h.spawned.push(input)
            const recorded = store.bots.list('default').find((candidate) => candidate.homeChatSessionId === input.sessionId)
            h.homeChatIds.push([recorded?.homeChatSessionId ?? null, input.sessionId])
            return h.spawnResult(input)
        },
        deliver: async (sessionId, text, localId) => {
            if (h.deliverError) throw h.deliverError
            remember(sessionId)
            if (store.messages.lookupQueuedMessage(sessionId, localId).status !== 'absent') return
            store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text } }, localId)
            h.delivered.push({ sessionId, text, localId })
        },
        queueMessage: async (sessionId, text, localId) => {
            remember(sessionId)
            if (store.messages.lookupQueuedMessage(sessionId, localId).status !== 'absent') return
            store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text } }, localId)
            h.queued.push({ sessionId, text, localId })
        },
        hasMessage: (sessionId, localId) => store.messages.lookupQueuedMessage(sessionId, localId).status !== 'absent',
        permissionModesFor: () => h.modes,
        listTasks: (sessionId) => (h.tasks.get(sessionId) ?? []).map((task) => ({ ...task })),
        setTasksPaused: async (sessionId, taskIds, paused) => {
            h.taskPauseCalls.push([sessionId, taskIds, paused])
            const changes = (task: FakeTask) => taskIds.includes(task.id) && !h.unstoppable.includes(task.id)
            // Like the task store: the pause itself lands at once and clears the schedule.
            h.tasks.set(sessionId, (h.tasks.get(sessionId) ?? []).map((task) => (
                changes(task) ? { ...task, state: paused ? 'paused' : 'active', nextRunAt: paused ? null : task.nextRunAt } : task
            )))
            if (h.whilePausing) await h.whilePausing()
            // A waiting prompt is taken back while the pause is under way: the row changes again (no prompt,
            // and the run is not counted any more).
            h.tasks.set(sessionId, (h.tasks.get(sessionId) ?? []).map((task) => (
                changes(task) && paused ? { ...task, pendingLocalId: null } : task
            )))
        },
        resumeTasksAt: (sessionId, tasks) => {
            for (const entry of tasks) h.taskResumes.push([sessionId, entry.id, entry.nextRunAt])
            h.tasks.set(sessionId, (h.tasks.get(sessionId) ?? []).map((task) => {
                const resumed = tasks.find((entry) => entry.id === task.id)
                // Like the engine: a task whose waiting prompt the pause took back has neither a prompt nor a
                // time, and is given what a resume by hand gives it (now).
                if (!resumed) return task
                if (h.leftPaused.includes(resumed.id)) return task
                const nextRunAt = resumed.nextRunAt ?? h.now
                return { ...task, state: 'active', nextRunAt }
            }))
            return tasks.filter((entry) => h.leftPaused.includes(entry.id)).map((entry) => entry.id)
        },
        releaseReceipts: (sessionId) => { h.receiptReleases.push(sessionId) },
        emit: (event) => { h.events.push(event) },
        now: () => h.now
    })
    return h
}

function machine(h: Harness, id: string, options: { namespace?: string; online?: boolean } = {}): void {
    h.machines.set(id, { id, namespace: options.namespace ?? 'default', online: options.online ?? true })
}

function session(h: Harness, id: string, view: Partial<BotSessionView> = {}, namespace = 'default'): void {
    h.sessions.set(id, { id, name: id, active: true, thinking: false, ...view })
    h.namespaces.set(id, namespace)
}

/** Create a bot through the service, with a home chat that exists and is running. */
async function makeBot(h: Harness, overrides: { name?: string; purpose?: string } = {}): Promise<{ id: string; home: string }> {
    machine(h, 'mac')
    h.spawnResult = (input) => {
        session(h, input.sessionId)
        return { sessionId: input.sessionId }
    }
    const bot = await h.service.create('default', { name: overrides.name ?? 'Ops', purpose: overrides.purpose, machineId: 'mac' })
    return { id: bot.id, home: bot.homeChatSessionId as string }
}

const code = (error: unknown): string => (error instanceof BotError ? `${error.status} ${error.code}` : `not a BotError: ${String(error)}`)
const running = (...ids: string[]): FakeTask[] => ids.map((id, index) => ({ id, state: 'active', nextRunAt: 9_000_000 + index, pendingLocalId: null, fingerprint: `as-paused-${id}` }))
/** A task paused, by the bot or by hand: no schedule until it is resumed. */
const pausedTask = (id: string): FakeTask => ({ id, state: 'paused', nextRunAt: null, pendingLocalId: null, fingerprint: `as-paused-${id}` })
/** A task whose waiting prompt the hub is still holding for the agent. */
const waiting = (id: string): FakeTask => ({ id, state: 'active', nextRunAt: null, pendingLocalId: `hapi-task:${id}:1`, fingerprint: `as-paused-${id}` })

describe('BotService.create', () => {
    it('prepares the home folder on the chosen machine, opens the home chat there under the bot\'s name and sends the first run', async () => {
        const h = makeHarness()
        machine(h, 'mac')
        h.spawnResult = (input) => { session(h, input.sessionId); return { sessionId: input.sessionId } }

        const bot = await h.service.create('default', { name: '  Release Captain ', purpose: 'Keep CI green.', machineId: 'mac' })
        const home = bot.homeChatSessionId as string
        // The bot was recorded under the id the machine was asked to start the session with.
        expect(h.homeChatIds).toEqual([[home, home]])
        expect(h.spawned[0].sessionId).toBe(home)

        expect(h.prepared).toEqual([{ machineId: 'mac', path: '~/.hapi/bots/release-captain', name: 'Release Captain' }])
        // The name travels with the launch: the session is named before anything runs under it.
        expect(h.spawned[0]).toEqual({
            sessionId: home, name: 'Release Captain', machineId: 'mac', homeDir: '/resolved/home/me/.hapi/bots/release-captain', agent: 'claude',
            model: undefined, permissionMode: 'bypassPermissions', namespace: 'default'
        })
        expect(bot).toMatchObject({
            name: 'Release Captain', purpose: 'Keep CI green.', machineId: 'mac', agent: 'claude', permissionMode: 'bypassPermissions',
            homeChatSessionId: home, state: 'active', machineOnline: true, homeChatActive: true
        })
        expect(bot.homeDir).toBe('/resolved/home/me/.hapi/bots/release-captain')
        await settle()
        expect(h.delivered).toEqual([])
        expect(h.queued).toHaveLength(1)
        expect(h.queued[0]).toMatchObject({ sessionId: home, localId: buildBotKickoffMessageLocalId(bot.id) })
        expect(h.queued[0].text).toContain('Release Captain')
        expect(h.queued[0].text).toContain('Keep CI green.')
        expect(h.service.homeChatBot(home)?.id).toBe(bot.id)
        expect(h.events.map((event) => event.type)).toEqual(['bots-changed', 'bots-changed'])
    })

    it('refuses what it cannot make a bot from, and leaves no row behind', async () => {
        const h = makeHarness()
        await makeBot(h)
        const before = h.store.bots.list('default').length

        await expect(h.service.create('default', { name: 'ops', machineId: 'mac' })).rejects.toMatchObject({ status: 409, code: 'name_taken' })
        await expect(h.service.create('default', { name: 'Two', machineId: 'nope' })).rejects.toMatchObject({ status: 404, code: 'machine_not_found' })
        machine(h, 'tenant-mac', { namespace: 'tenant' })
        await expect(h.service.create('default', { name: 'Two', machineId: 'tenant-mac' })).rejects.toMatchObject({ status: 404 })
        machine(h, 'asleep', { online: false })
        await expect(h.service.create('default', { name: 'Two', machineId: 'asleep' })).rejects.toMatchObject({ status: 503, code: 'machine_offline' })
        await expect(h.service.create('default', { name: 'Two', machineId: 'mac', agent: 'no-such-agent' })).rejects.toMatchObject({ status: 400, code: 'unknown_agent' })
        // An agent that exists but has not been run as a bot's brain is refused by name.
        await expect(h.service.create('default', { name: 'Two', machineId: 'mac', agent: 'codex' })).rejects.toMatchObject({ status: 400, code: 'unknown_agent' })
        await expect(h.service.create('default', { name: 'Two', machineId: 'mac', permissionMode: 'yolo' })).rejects.toMatchObject({ status: 400, code: 'invalid_permission_mode' })
        await expect(h.service.create('default', { name: '***', machineId: 'mac' })).rejects.toMatchObject({ status: 400, code: 'unusable_name' })
        h.prepareError = new Error('runner said no')
        await expect(h.service.create('default', { name: 'Two', machineId: 'mac' })).rejects.toMatchObject({ status: 502, code: 'home_prepare_failed' })
        expect(h.store.bots.list('default')).toHaveLength(before)
    })

    it('refuses a home folder the machine reports as relative or malformed, instead of starting a session in it', async () => {
        const h = makeHarness()
        machine(h, 'mac')
        h.spawnResult = (input) => { session(h, input.sessionId); return { sessionId: input.sessionId } }
        for (const path of ['bots/ops', '~/bots/ops', '', '/home/me/\u0007bots', `/${'x'.repeat(5000)}`]) {
            h.preparedPath = () => path
            await expect(h.service.create('default', { name: 'Ops', machineId: 'mac' }), JSON.stringify(path))
                .rejects.toMatchObject({ status: 502, code: 'home_prepare_failed' })
        }
        expect(h.spawned).toEqual([])
        expect(h.store.bots.list('default')).toEqual([])
    })

    it('keeps the row, marked failed, when the home chat cannot be opened, and does not hold the name', async () => {
        const h = makeHarness()
        machine(h, 'mac')
        h.spawnResult = () => ({ error: 'claude not installed' })
        await expect(h.service.create('default', { name: 'Ops', machineId: 'mac' })).rejects.toMatchObject({ status: 502, code: 'home_chat_spawn_failed' })
        const [failed] = h.store.bots.list('default')
        expect(failed).toMatchObject({ state: 'failed', lastError: 'claude not installed' })
        await settle()
        expect(h.queued).toEqual([])
        expect(h.events.at(-1)).toEqual({ type: 'bots-changed', namespace: 'default', botId: failed.id })

        // The machine may have started the session under the reserved id after all: that id stays recorded,
        // so the session, if it exists, is still known as this bot's.
        expect(failed.homeChatSessionId).toBe(h.homeChatIds[0][1])

        // Trying again under the same name is what the owner will do next.
        h.spawnResult = (input) => { session(h, input.sessionId); return { sessionId: input.sessionId } }
        const again = await h.service.create('default', { name: 'ops', machineId: 'mac' })
        expect(again).toMatchObject({ state: 'active', name: 'ops' })
        expect(h.store.bots.list('default').map((bot) => [bot.name, bot.state]).sort()).toEqual([['Ops', 'failed'], ['ops', 'active']])
    })

    it('a spawn that throws is the same as one that reports an error', async () => {
        const h = makeHarness()
        machine(h, 'mac')
        h.spawnResult = () => { throw new Error('socket hung up') }
        await expect(h.service.create('default', { name: 'Ops', machineId: 'mac' })).rejects.toMatchObject({ status: 502, code: 'home_chat_spawn_failed' })
        expect(h.store.bots.list('default')[0]).toMatchObject({ state: 'failed', lastError: 'socket hung up' })
    })

    it('starts a bot in its agent\'s fully automatic mode when the owner does not pick one, and in whatever it picks otherwise', async () => {
        const h = makeHarness()
        machine(h, 'mac')
        h.spawnResult = (input) => { session(h, input.sessionId); return { sessionId: input.sessionId } }
        // Claude names its full-auto mode "bypassPermissions".
        const claude = await h.service.create('default', { name: 'Auto', machineId: 'mac' })
        expect(claude.permissionMode).toBe('bypassPermissions')
        // Another agent may only know "yolo".
        h.modes = ['default', 'read-only', 'yolo']
        const other = await h.service.create('default', { name: 'Other', machineId: 'mac' })
        expect(other.permissionMode).toBe('yolo')
        // An agent that has no modes gets none, as before.
        h.modes = []
        expect((await h.service.create('default', { name: 'Plain', machineId: 'mac' })).permissionMode).toBeNull()
        // The owner's choice wins over the default.
        h.modes = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
        const held = await h.service.create('default', { name: 'Held', machineId: 'mac', permissionMode: 'plan' })
        expect(held.permissionMode).toBe('plan')
    })

    it('honours an explicit home folder, model and permission mode', async () => {
        const h = makeHarness()
        machine(h, 'mac')
        h.spawnResult = (input) => { session(h, input.sessionId); return { sessionId: input.sessionId } }
        await h.service.create('default', { name: 'Writer', machineId: 'mac', homeDir: '~/bots/writer', agent: 'claude', permissionMode: 'plan', model: 'opus' })
        expect(h.prepared.map((call) => call.path)).toEqual(['~/bots/writer'])
        expect(h.spawned[0]).toMatchObject({ agent: 'claude', model: 'opus', permissionMode: 'plan' })
        expect(h.store.bots.list('default')[0]?.permissionMode).toBe('plan')
    })

    it('a first run that cannot be delivered does not fail the bot', async () => {
        const h = makeHarness()
        machine(h, 'mac')
        h.spawnResult = (input) => { session(h, input.sessionId); return { sessionId: input.sessionId } }
        h.deliverError = new Error('disk full')
        const bot = await h.service.create('default', { name: 'Ops', machineId: 'mac' })
        await settle()
        expect(bot.state).toBe('active')
        expect(h.store.bots.get(bot.id)?.state).toBe('active')
    })
})

describe('BotService.sweep', () => {
    it('marks a creation the previous hub process did not finish as failed; a fresh one is left alone', async () => {
        const h = makeHarness()
        machine(h, 'mac')
        h.spawnResult = () => ({ error: 'boom' })
        await h.service.create('default', { name: 'Stale', machineId: 'mac' }).catch(() => undefined)
        await h.service.create('default', { name: 'Fresh', machineId: 'mac' }).catch(() => undefined)
        const byName = (name: string) => h.store.bots.list('default').find((bot) => bot.name === name) as { id: string }
        const stale = byName('Stale')
        const fresh = byName('Fresh')
        // What a crash mid-creation leaves behind: still `creating`, last touched long ago.
        h.store.bots.update(stale.id, { state: 'creating', lastError: null, homeChatSessionId: 'reserved' }, h.now - BOT_CREATION_STALE_MS - 1)
        h.store.bots.update(fresh.id, { state: 'creating', lastError: null }, h.now - 1_000)
        h.events.length = 0

        h.service.sweep()
        expect(h.store.bots.get(stale.id)).toMatchObject({ name: 'Stale', state: 'failed', homeChatSessionId: 'reserved' })
        expect(h.store.bots.get(stale.id)?.lastError).toContain('did not finish')
        expect(h.store.bots.get(fresh.id)).toMatchObject({ name: 'Fresh', state: 'creating', lastError: null })
        expect(h.events).toEqual([{ type: 'bots-changed', namespace: 'default', botId: stale.id }])

        // Nothing is repeated, and the name can be used again.
        h.events.length = 0
        h.service.sweep()
        expect(h.events).toEqual([])
        h.spawnResult = (input) => { session(h, input.sessionId); return { sessionId: input.sessionId } }
        await expect(h.service.create('default', { name: 'stale', machineId: 'mac' })).resolves.toMatchObject({ state: 'active' })
    })
})

describe('BotService.update and archive', () => {
    it('pauses and resumes, trims the purpose, and refuses to pause a bot that is not up', async () => {
        const h = makeHarness()
        const { id } = await makeBot(h)
        expect((await h.service.update('default', id, { paused: true })).state).toBe('paused')
        expect((await h.service.update('default', id, { purpose: '  ship things  ' })).purpose).toBe('ship things')
        expect(h.store.bots.get(id)?.state).toBe('paused')
        expect((await h.service.update('default', id, { paused: false })).state).toBe('active')

        machine(h, 'mac')
        h.spawnResult = () => ({ error: 'boom' })
        await h.service.create('default', { name: 'Stuck', machineId: 'mac' }).catch(() => undefined)
        const stuck = h.store.bots.list('default').find((bot) => bot.name === 'Stuck') as { id: string }
        h.store.bots.update(stuck.id, { state: 'creating' }, h.now)
        await expect(h.service.update('default', stuck.id, { paused: true })).rejects.toMatchObject({ status: 409, code: 'bot_not_pausable' })
        await expect(h.service.update('default', stuck.id, { paused: false })).rejects.toMatchObject({ status: 409, code: 'bot_not_pausable' })
    })

    it('pausing again does not lose what has to be resumed, and picks up what started in the meantime', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, running('task-a', 'task-b'))

        await h.service.update('default', id, { paused: true })
        expect(h.taskPauseCalls).toEqual([[home, ['task-a', 'task-b'], true]])
        expect(h.store.bots.get(id)?.pausedTasks.map((entry) => entry.id)).toEqual(['task-a', 'task-b'])

        // Paused twice: nothing is running now, and recomputing the list would have emptied it.
        await h.service.update('default', id, { paused: true })
        expect(h.store.bots.get(id)?.pausedTasks.map((entry) => entry.id)).toEqual(['task-a', 'task-b'])

        // The owner starts one task by hand while the bot is paused; pausing again stops it too, and it joins the list.
        h.tasks.set(home, h.tasks.get(home)!.map((task) => (task.id === 'task-b' ? { ...task, state: 'active' } : task)))
        await h.service.update('default', id, { paused: true })
        expect(h.taskPauseCalls.at(-1)).toEqual([home, ['task-b'], true])

        expect((await h.service.update('default', id, { paused: false })).state).toBe('active')
        expect(h.taskPauseCalls.filter((call) => !call[2])).toEqual([])
        expect(h.taskResumes.map(([session, task]) => [session, task])).toEqual([[home, 'task-a'], [home, 'task-b']])
        expect(h.store.bots.get(id)?.pausedTasks).toEqual([])
        expect(h.tasks.get(home)!.every((task) => task.state === 'active')).toBe(true)
    })

    it('resuming puts the schedules back where they were; it does not run them at once', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        // A daily round due tomorrow morning, and a queue prompt waiting for its turn.
        const tomorrow = h.now + 20 * 60 * 60_000
        h.tasks.set(home, [
            { ...running('daily')[0], nextRunAt: tomorrow },
            waiting('queued')
        ])
        await h.service.update('default', id, { paused: true })
        expect(h.tasks.get(home)!.map((task) => [task.id, task.state, task.nextRunAt, task.pendingLocalId]))
            .toEqual([['daily', 'paused', null, null], ['queued', 'paused', null, null]])
        expect(h.store.bots.get(id)?.pausedTasks).toEqual([
            { id: 'daily', fingerprint: 'as-paused-daily', nextRunAt: tomorrow },
            { id: 'queued', fingerprint: 'as-paused-queued', nextRunAt: null }
        ])

        // Paused for a while, then resumed the same evening: the round waits for tomorrow, and the queue prompt
        // the pause took back is the engine's to send again (it is given "now" there, not here).
        await h.service.update('default', id, { paused: false })
        expect(h.taskResumes).toEqual([[home, 'daily', tomorrow], [home, 'queued', null]])
        expect(h.tasks.get(home)!.map((task) => [task.id, task.state, task.nextRunAt])).toEqual([['daily', 'active', tomorrow], ['queued', 'active', h.now]])
    })

    it('a task that fell due while the bot was paused runs once when it resumes, not at once on every resume', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        const due = h.now - 3 * 60 * 60_000
        h.tasks.set(home, [{ ...running('hourly')[0], nextRunAt: due }])
        await h.service.update('default', id, { paused: true })
        await h.service.update('default', id, { paused: false })
        // Handed back with its original time; the engine moves a past one to now, so it runs once and goes on from there.
        expect(h.taskResumes).toEqual([[home, 'hourly', due]])
    })

    it('resuming starts what the owner left alone, and only that: an edited schedule and one running by hand are not touched', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, [...running('mine', 'theirs', 'edited'), waiting('waiting'), pausedTask('already-paused')])
        await h.service.update('default', id, { paused: true })
        expect(h.taskPauseCalls).toEqual([[home, ['mine', 'theirs', 'edited', 'waiting'], true]])

        // While the bot is paused: the owner resumes "theirs" by hand, and changes the interval of "edited"
        // (which stays paused: an edit alone never resumes a task).
        h.tasks.set(home, h.tasks.get(home)!.map((task) => {
            if (task.id === 'theirs') return { ...task, state: 'active', nextRunAt: h.now }
            if (task.id === 'edited') return { ...task, fingerprint: 'changed-by-the-owner' }
            return task
        }))
        await h.service.update('default', id, { paused: false })
        // "theirs" is running already; "edited" and "already-paused" are the owner's to resume.
        expect(h.taskResumes.map(([, task]) => task)).toEqual(['mine', 'waiting'])
        const after = new Map(h.tasks.get(home)!.map((task) => [task.id, task.state]))
        expect(Object.fromEntries(after)).toEqual({ mine: 'active', theirs: 'active', edited: 'paused', waiting: 'active', 'already-paused': 'paused' })
    })

    it('a schedule whose waiting prompt the pause took back is resumed with the bot', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        // A queue task waiting on its first prompt, and a round with a prompt out.
        h.tasks.set(home, [waiting('queue'), waiting('round')])
        await h.service.update('default', id, { paused: true })
        expect(h.tasks.get(home)!.map((task) => [task.state, task.pendingLocalId])).toEqual([['paused', null], ['paused', null]])

        // The rows are not what they were when the pause was called, and that was the hub's doing, not the owner's.
        await h.service.update('default', id, { paused: false })
        expect(h.taskResumes).toEqual([[home, 'queue', null], [home, 'round', null]])
        expect(h.tasks.get(home)!.every((task) => task.state === 'active')).toBe(true)
    })

    it('pausing shows the bot paused and its schedules on record at once, and answers only once the hub is through with them', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, running('nightly'))
        let letItFinish: () => void = () => undefined
        h.whilePausing = () => new Promise<void>((resolve) => { letItFinish = resolve })
        let answered = false
        const pausing = h.service.update('default', id, { paused: true }).then((bot) => { answered = true; return bot })

        await settle()
        // The hub is still taking a waiting prompt back: the owner's request is not answered yet. The bot is
        // paused already and its schedule is on record, so a hub that stops now leaves nothing behind.
        expect(answered).toBe(false)
        expect(h.store.bots.get(id)).toMatchObject({
            state: 'paused', pausedTasks: [{ id: 'nightly', fingerprint: 'as-paused-nightly', nextRunAt: 9_000_000 }]
        })

        letItFinish()
        expect((await pausing).state).toBe('paused')
        expect(h.tasks.get(home)![0].state).toBe('paused')
    })

    it('a resume asked for while the pause is still under way waits for it, and is the one that stands', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, running('nightly'))
        let letItFinish: () => void = () => undefined
        h.whilePausing = () => new Promise<void>((resolve) => { letItFinish = resolve })
        const pausing = h.service.update('default', id, { paused: true })
        await settle()
        let resumed = false
        const resuming = h.service.update('default', id, { paused: false }).then((bot) => { resumed = true; return bot })
        await settle()
        // Answered now, it would find the schedules paused and nothing on record to start again.
        expect(resumed).toBe(false)
        expect(h.taskResumes).toEqual([])

        letItFinish()
        await pausing
        expect((await resuming).state).toBe('active')
        expect(h.taskResumes).toEqual([[home, 'nightly', 9_000_000]])
        expect(h.tasks.get(home)![0].state).toBe('active')
        expect(h.store.bots.get(id)).toMatchObject({ state: 'active', pausedTasks: [] })
    })

    it('a home chat merged into another session while the pause is under way keeps its schedules on record', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, running('nightly'))
        h.whilePausing = async () => {
            // The home chat's id rotates (a resume that merges the old row away); its tasks move with it.
            h.tasks.set('home-2', h.tasks.get(home) ?? [])
            h.tasks.delete(home)
            h.store.bots.update(id, { homeChatSessionId: 'home-2' }, h.now)
        }
        await h.service.update('default', id, { paused: true })
        expect(h.store.bots.get(id)).toMatchObject({
            homeChatSessionId: 'home-2', state: 'paused', pausedTasks: [{ id: 'nightly', fingerprint: 'as-paused-nightly', nextRunAt: 9_000_000 }]
        })
    })

    it('a schedule the session had no room for stays on record with the bot, and the next resume tries it again', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, running('first', 'second'))
        await h.service.update('default', id, { paused: true })
        // The session is at its cap of active tasks except for one place.
        h.leftPaused.push('second')
        expect((await h.service.update('default', id, { paused: false })).state).toBe('active')
        expect(h.taskResumes).toEqual([[home, 'first', 9_000_000], [home, 'second', 9_000_001]])
        expect(h.store.bots.get(id)?.pausedTasks.map((entry) => entry.id)).toEqual(['second'])
        expect(h.tasks.get(home)!.map((task) => task.state)).toEqual(['active', 'paused'])

        // Room made: resuming again (the bot was not paused in between) starts it.
        h.leftPaused.length = 0
        await h.service.update('default', id, { paused: false })
        expect(h.taskResumes.slice(2)).toEqual([[home, 'second', 9_000_001]])
        expect(h.store.bots.get(id)?.pausedTasks).toEqual([])
        expect(h.tasks.get(home)!.every((task) => task.state === 'active')).toBe(true)
    })

    it('a schedule the hub could not stop is not recorded as paused: it was never stopped for the bot', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, running('nightly', 'wild'))
        // "wild" stays as it was: the hub could not change it.
        h.unstoppable.push('wild')
        await h.service.update('default', id, { paused: true })
        expect(h.taskPauseCalls).toEqual([[home, ['nightly', 'wild'], true]])
        expect(h.store.bots.get(id)?.pausedTasks.map((entry) => entry.id)).toEqual(['nightly'])
        expect(h.tasks.get(home)!.find((task) => task.id === 'wild')?.state).toBe('active')
    })

    it('a bot archived while its schedules were being paused is not brought back as paused', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, running('nightly'))
        // (Archiving pauses what is running too: that inner pause is not held.)
        h.whilePausing = async () => { h.whilePausing = null; h.service.archive('default', id) }
        // An archived bot is gone as far as the API is concerned; it does not come back as a paused one.
        await expect(h.service.update('default', id, { paused: true })).rejects.toMatchObject({ status: 404, code: 'bot_not_found' })
        expect(h.store.bots.get(id)).toMatchObject({ state: 'archived', pausedTasks: [] })
    })

    it("records a schedule as it was when the owner paused the bot, so an edit made during the pause still counts as the owner's", async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, running('nightly'))
        h.whilePausing = async () => {
            h.tasks.set(home, h.tasks.get(home)!.map((task) => ({ ...task, fingerprint: 'edited-meanwhile' })))
        }
        await h.service.update('default', id, { paused: true })
        await h.service.update('default', id, { paused: false })
        expect(h.taskResumes).toEqual([])
        expect(h.tasks.get(home)![0].state).toBe('paused')
    })

    it('resuming lets held replies through, once', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        await h.service.update('default', id, { paused: true })
        expect(h.receiptReleases).toEqual([])
        await h.service.update('default', id, { paused: false })
        expect(h.receiptReleases).toEqual([home])
    })

    it('archiving stops the home chat\'s schedules; the bot is gone from every list', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.tasks.set(home, running('nightly'))
        h.events.length = 0

        h.receiptReleases.push('marker')
        h.service.archive('default', id)
        expect(h.taskPauseCalls).toEqual([[home, ['nightly'], true]])
        // Receipts held for it while it was paused are let go: an archived bot is not held.
        expect(h.receiptReleases).toEqual(['marker', home])
        expect(h.events).toEqual([{ type: 'bots-changed', namespace: 'default', botId: id }])
        expect(h.service.list('default')).toEqual([])
        expect(h.service.homeChatBot(home)).toBeNull()
        expect(() => h.service.get('default', id)).toThrow(expect.objectContaining({ status: 404, code: 'bot_not_found' }))
        // The name is free again.
        machine(h, 'mac')
        h.spawnResult = (input) => { session(h, input.sessionId); return { sessionId: input.sessionId } }
        await expect(h.service.create('default', { name: 'OPS', machineId: 'mac' })).resolves.toBeTruthy()
    })

    it('marks a bot failed when its home chat is deleted, and says so', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.events.length = 0
        h.service.onHomeChatGone('some-other-session')
        expect(h.events).toEqual([])

        h.service.onHomeChatGone(home)
        const bot = h.store.bots.get(id)
        expect(bot?.state).toBe('failed')
        expect(bot?.lastError).toContain('home chat was deleted')
        expect(h.events).toEqual([{ type: 'bots-changed', namespace: 'default', botId: id }])
        // Already settled: nothing more to say.
        h.events.length = 0
        h.service.onHomeChatGone(home)
        expect(h.events).toEqual([])
    })

    it('is scoped to the namespace', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        await expect(h.service.update('tenant', id, { paused: true })).rejects.toMatchObject({ status: 404 })
        expect(h.service.list('tenant')).toEqual([])
        expect(h.events.every((event) => event.namespace === 'default')).toBe(true)
        expect(home).toBeTruthy()
    })

    it('lets only a bot\'s home chat through when the peer tools are bots-only', async () => {
        const h = makeHarness()
        const { home } = await makeBot(h)
        session(h, 'plain')
        expect(h.service.peerToolsDisabledFor(home, false, false)).toBe(false)
        expect(h.service.peerToolsDisabledFor('plain', false, false)).toBe(false)
        expect(h.service.peerToolsDisabledFor(home, true, true)).toBe(false)
        expect(h.service.peerToolsDisabledFor('plain', true, true)).toBe(true)
        expect(h.service.peerToolsDisabledFor(home, true, false)).toBe(true)
        expect(h.service.botIdForHomeChat(home)).toBe(h.service.list('default')[0]?.id)
        expect(h.service.botIdForHomeChat('plain')).toBeUndefined()
    })

    it('a bot that can no longer run has no home chat with bot powers: its conversation is an ordinary session again', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        await h.service.update('default', id, { paused: true })
        // Paused is still a bot.
        expect(h.service.botIdForHomeChat(home)).toBe(id)
        expect(h.service.peerToolsDisabledFor(home, true, true)).toBe(false)

        h.service.onHomeChatGone(home)
        expect(h.store.bots.get(id)?.state).toBe('failed')
        expect(h.service.botIdForHomeChat(home)).toBeUndefined()
        expect(h.service.peerToolsDisabledFor(home, true, true)).toBe(true)
        // The record keeps the link, for the history.
        expect(h.service.homeChatBot(home)?.id).toBe(id)

        h.service.archive('default', id)
        expect(h.service.botIdForHomeChat(home)).toBeUndefined()
    })
})

describe('BotService ledger', () => {
    it('records who created an item and refuses a session pretending to be the bot', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        session(h, 'worker')

        const mine = h.service.createItem('default', id, { title: 'Fix flaky test', detail: 'sessionTasks ordering', status: 'working', workerSessionId: 'worker' })
        expect(mine.item).toMatchObject({ botId: id, sessionId: home, number: 1, status: 'working', workerSessionId: 'worker', detail: 'sessionTasks ordering' })
        expect(h.service.listEvents('default', id, '1').map((event) => [event.kind, event.actor, event.text])).toEqual([
            ['created', 'user', ''], ['linked', 'user', 'worker']
        ])

        const theirs = h.service.createItem('default', id, { title: 'Review PR', fromSessionId: home })
        expect(theirs.item).toMatchObject({ number: 2, status: 'planned' })
        expect(h.service.listEvents('default', id, theirs.item.id)[0].actor).toBe('bot')
        expect(() => h.service.createItem('default', id, { title: 'Sneaky', fromSessionId: 'worker' })).toThrow(expect.objectContaining({ code: 'not_bot_home_chat' }))
        expect(() => h.service.createItem('tenant', id, { title: 'Elsewhere' })).toThrow(expect.objectContaining({ status: 404 }))
    })

    it('links an item only to a session of the bot\'s own namespace, so another tenant\'s session never reaches it', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        session(h, 'worker')
        session(h, 'outsider', {}, 'tenant')
        const request: AgentStateRequest = { tool: 'Bash', arguments: { command: 'cat /etc/passwd' } }

        h.service.createItem('default', id, { title: 'Mine' })
        // A session that does not exist, and one of another namespace.
        for (const workerSessionId of ['nobody', 'outsider']) {
            expect(() => h.service.createItem('default', id, { title: 'No', workerSessionId })).toThrow(expect.objectContaining({ status: 404, code: 'worker_not_found' }))
            expect(() => h.service.updateItem('default', id, '1', { workerSessionId })).toThrow(expect.objectContaining({ status: 404, code: 'worker_not_found' }))
        }
        expect(h.store.bots.listItems(id).map((item) => [item.title, item.workerSessionId])).toEqual([['Mine', null]])

        // Once refused, nothing about that session is shown or forwarded for this bot.
        session(h, 'outsider', { agentState: { requests: { r1: request } } }, 'tenant')
        h.service.onRequestsChanged('outsider', [{ requestId: 'r1', request }])
        await settle()
        expect(h.delivered.filter((entry) => entry.sessionId === home && entry.localId.startsWith('hapi-worker-request:'))).toEqual([])
        expect(h.service.needsYou('default', id)).toEqual([])
        expect(h.service.workers('default', id)).toEqual([])
    })

    it('moves an item, drops its question when it leaves needs_you, and keeps a closed item closed', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        const item = h.service.createItem('default', id, { title: 'Migrate the db', status: 'working' }).item
        h.service.ask('default', id, '1', { question: 'Which storage?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], recommended: 0, fromSessionId: home })

        const done = h.service.updateItem('default', id, '#1', { status: 'done', detail: 'went with SQLite' })
        expect(done).toMatchObject({ status: 'done', ask: null, detail: 'went with SQLite' })
        expect(h.service.listEvents('default', id, item.id).map((event) => [event.kind, event.text])).toEqual([
            ['created', ''], ['ask', 'Which storage?'], ['status', 'done'], ['updated', 'detail']
        ])
        expect(() => h.service.updateItem('default', id, '1', { status: 'working' })).toThrow(expect.objectContaining({ code: 'item_closed' }))
        expect(() => h.service.updateItem('default', id, '1', { status: 'needs_you' })).toThrow(expect.objectContaining({ code: 'invalid_status' }))
        // A no-op patch writes no event and announces nothing.
        h.events.length = 0
        expect(h.service.updateItem('default', id, '1', { detail: 'went with SQLite' })).toEqual(done)
        expect(h.service.listEvents('default', id, item.id)).toHaveLength(4)
        expect(h.events).toEqual([])
    })

    it('announces both the bot and its items whenever an item changes, because the counts move with it', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.events.length = 0
        const { item } = h.service.createItem('default', id, { title: 'One' })
        expect(h.events).toEqual([
            { type: 'bots-changed', namespace: 'default', botId: id },
            { type: 'bot-items-changed', namespace: 'default', sessionId: home, botId: id, itemId: item.id }
        ])
    })

    it('lets only the bot ask, with a recommendation that names one of the options', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        h.service.createItem('default', id, { title: 'Ship it' })
        expect(() => h.service.ask('default', id, '1', { question: 'Now?' })).toThrow(expect.objectContaining({ code: 'bot_only' }))
        expect(() => h.service.ask('default', id, '1', { question: 'Now?', options: [{ label: 'Yes' }], recommended: 1, fromSessionId: home }))
            .toThrow(expect.objectContaining({ code: 'invalid_recommended' }))

        const asked = h.service.ask('default', id, '1', { question: 'Ship today or Monday?', options: [{ label: 'Today' }, { label: 'Monday' }], recommended: 1, fromSessionId: home })
        expect(asked).toMatchObject({ status: 'needs_you' })
        expect(asked.ask).toEqual({ question: 'Ship today or Monday?', options: [{ label: 'Today' }, { label: 'Monday' }], recommended: 1 })

        h.service.updateItem('default', id, '1', { status: 'canceled' })
        expect(() => h.service.ask('default', id, '1', { question: 'Again?', fromSessionId: home })).toThrow(expect.objectContaining({ code: 'item_closed' }))
    })

    it("the owner's answer puts the item back to working and wakes the bot with it", async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        await settle()
        // Not counting the first run, which is already in.
        h.delivered.length = 0
        h.service.createItem('default', id, { title: 'Ship it', status: 'working', fromSessionId: home })
        h.service.ask('default', id, '1', { question: 'Ship today or Monday?', options: [{ label: 'Today' }, { label: 'Monday' }], recommended: 0, fromSessionId: home })

        const { item, event } = h.service.comment('default', id, '1', { text: 'Monday, CI is red.' })
        expect(item).toMatchObject({ status: 'working', ask: null })
        expect(event).toMatchObject({ kind: 'answered', actor: 'user', text: 'Monday, CI is red.' })
        await settle()
        expect(h.delivered).toHaveLength(1)
        expect(h.delivered[0]).toMatchObject({ sessionId: home, localId: buildBotItemCommentMessageLocalId(event.id) })
        expect(h.delivered[0].text).toContain('This answers your question: "Ship today or Monday?"')
        expect(h.delivered[0].text).toContain('The item is back to "working".')
        expect(h.delivered[0].text).toContain('Monday, CI is red.')
        expect(h.events.at(-1)).toEqual({ type: 'bot-items-changed', namespace: 'default', sessionId: home, botId: id, itemId: item.id })

        // A comment that merely waits on something else reopens too; a bot's own note does not wake it.
        h.service.createItem('default', id, { title: 'Wait for CI', status: 'waiting' })
        h.service.comment('default', id, '2', { text: 'CI is green now.' })
        h.service.comment('default', id, '2', { text: 'noted, checking', fromSessionId: home })
        await settle()
        expect(h.delivered).toHaveLength(2)
        expect(h.store.bots.getItem(id, '2')?.status).toBe('working')
    })

    it('a comment on an item that was never waiting does not tell the bot that it reopened', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        await settle()
        h.delivered.length = 0
        h.service.createItem('default', id, { title: 'A "quoted] title', status: 'working' })

        h.service.comment('default', id, '1', { text: 'Also check Windows.' })
        await settle()
        expect(h.delivered).toHaveLength(1)
        const text = h.delivered[0].text
        expect(text).not.toContain('back to "working"')
        // The title is quoted as data: a quote or bracket in it cannot reshape the header.
        expect(text).toContain('[hapi item #1 "A \\"quoted] title"] Your owner commented.')
    })

    it("delivers the owner's answer even to a paused bot: the owner started it", async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        await h.service.update('default', id, { paused: true })
        await settle()
        h.delivered.length = 0
        h.service.createItem('default', id, { title: 'Ship it' })
        h.service.ask('default', id, '1', { question: 'Now?', fromSessionId: home })
        const { item } = h.service.comment('default', id, '1', { text: 'yes' })
        expect(item.status).toBe('working')
        await settle()
        expect(h.delivered).toHaveLength(1)
        expect(h.delivered[0]).toMatchObject({ sessionId: home })
    })
})

describe('BotService views', () => {
    it('lists unanswered requests first, then the bot\'s questions, and skips a snoozed one', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        const request: AgentStateRequest = { tool: 'Bash', arguments: { command: 'rm -rf build' } }
        session(h, home, { agentState: { requests: { r0: { ...request, tool: 'Write', createdAt: 9 } } } })
        session(h, 'worker-a', { agentState: { requests: { r1: { ...request, createdAt: 10 }, r2: { ...request, tool: 'AskUserQuestion', createdAt: 11 } } } })
        session(h, 'worker-b')
        h.service.createItem('default', id, { title: 'Refactor', status: 'working', workerSessionId: 'worker-a' })
        h.service.createItem('default', id, { title: 'Ship', status: 'working', workerSessionId: 'worker-b' })
        h.receiptChildren.set(home, ['worker-c'])
        session(h, 'worker-c', { agentState: { requests: { r3: { ...request, createdAt: 12 } } } })
        h.service.ask('default', id, '2', { question: 'Android too?', options: [{ label: 'Yes' }], recommended: 0, fromSessionId: home })
        h.service.createItem('default', id, { title: 'Later', fromSessionId: home })
        h.service.ask('default', id, '3', { question: 'Someday?', fromSessionId: home })
        h.service.updateItem('default', id, '3', { snoozedUntil: 6_000_000 })

        const entries = h.service.needsYou('default', id)
        expect(entries.map((entry) => entry.kind === 'request' ? `request ${entry.sessionId} ${entry.requestId}` : `question #${entry.number}`))
            .toEqual([`request ${home} r0`, 'request worker-a r1', 'request worker-a r2', 'request worker-c r3', 'question #2'])

        expect(h.service.workers('default', id)).toEqual([
            { sessionId: 'worker-a', name: 'worker-a', active: true, thinking: false, pendingRequests: 2, itemNumber: 1 },
            { sessionId: 'worker-b', name: 'worker-b', active: true, thinking: false, pendingRequests: 0, itemNumber: 2 },
            { sessionId: 'worker-c', name: 'worker-c', active: true, thinking: false, pendingRequests: 1, itemNumber: null }
        ])
        expect(h.service.get('default', id).counts).toEqual({ needsYou: 5, working: 1, workers: 3 })

        // Once the work is done its worker is history, not someone the bot waits on.
        h.service.updateItem('default', id, '1', { status: 'done' })
        h.service.updateItem('default', id, '2', { status: 'done' })
        h.service.updateItem('default', id, '3', { status: 'done' })
        // worker-c is still waited on by a receipt; the two attached to finished items are not.
        expect(h.service.get('default', id).counts).toEqual({ needsYou: 2, working: 0, workers: 1 })
        expect(h.service.workers('default', id).map((worker) => worker.sessionId)).toEqual(['worker-c'])
        expect(h.store.bots.getItem(id, '1')?.workerSessionId).toBe('worker-a')
    })

    it('tells a bot once when one of its workers is stuck on a request, and only that bot', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h, { name: 'Ops' })
        machine(h, 'mac')
        h.spawnResult = (input) => { session(h, input.sessionId); return { sessionId: input.sessionId } }
        await h.service.create('default', { name: 'Other', machineId: 'mac' })
        await settle()
        // Both bots' first runs are delivered; what follows is only about requests.
        h.delivered.length = 0
        session(h, 'worker', { name: 'Refactor worker' })
        session(h, 'by-receipt', { name: 'Nightly worker' })
        session(h, 'stranger')
        h.service.createItem('default', id, { title: 'Refactor', status: 'working', workerSessionId: 'worker' })
        h.receiptChildren.set(home, ['by-receipt'])
        const request: AgentStateRequest = { tool: 'Bash', arguments: { command: 'git push --force' } }

        h.service.onRequestsChanged('stranger', [{ requestId: 'r9', request }])
        h.service.onRequestsChanged('worker', [])
        expect(h.delivered).toEqual([])

        h.service.onRequestsChanged('worker', [{ requestId: 'r1', request }, { requestId: 'r2', request: { ...request, tool: 'AskUserQuestion' } }])
        h.service.onRequestsChanged('worker', [{ requestId: 'r1', request }])
        // A worker the bot only waits on a receipt from is told as well.
        session(h, 'by-receipt', { name: 'Nightly worker', agentState: { requests: { r5: request } } })
        h.service.onRequestsChanged('by-receipt', [{ requestId: 'r5', request }])
        await settle()
        expect(h.delivered.map((entry) => entry.localId)).toEqual([
            buildBotRequestNoticeMessageLocalId('worker', 'r1'),
            buildBotRequestNoticeMessageLocalId('worker', 'r2'),
            buildBotRequestNoticeMessageLocalId('by-receipt', 'r5')
        ])
        expect(h.delivered[0]).toMatchObject({ sessionId: home })
        expect(h.delivered[0].text).toContain('Refactor worker')
        expect(h.delivered[0].text).toContain('git push --force')
        expect(h.delivered[0].text).toContain('hapi peer-answer')
        expect(h.delivered[2].text).toContain('Nightly worker')

        // A paused bot is not disturbed; the request still shows under "needs you".
        await h.service.update('default', id, { paused: true })
        session(h, 'worker', {
            name: 'Refactor worker',
            agentState: { requests: { r1: request, r2: { ...request, tool: 'AskUserQuestion' }, r3: request } }
        })
        h.service.onRequestsChanged('worker', [{ requestId: 'r3', request }])
        await settle()
        expect(h.delivered).toHaveLength(3)
        expect(h.service.needsYou('default', id).filter((entry) => entry.kind === 'request')).toHaveLength(4)
        expect(h.service.workers('default', id).find((worker) => worker.sessionId === 'worker')?.pendingRequests).toBe(3)
    })

    it('does not carry credentials from a worker\'s command into the bot\'s chat', async () => {
        const h = makeHarness()
        const { id } = await makeBot(h)
        session(h, 'worker')
        h.service.createItem('default', id, { title: 'Deploy', status: 'working', workerSessionId: 'worker' })
        const request: AgentStateRequest = {
            tool: 'Bash',
            arguments: { command: 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI; curl -H "Authorization: Bearer sk-live-123456" https://x.example', file_path: '/deploy.sh' }
        }
        h.service.onRequestsChanged('worker', [{ requestId: 'r1', request }])
        await settle()
        const text = h.delivered.at(-1)!.text
        expect(text).not.toContain('wJalrXUtnFEMI')
        expect(text).not.toContain('sk-live-123456')
        expect(text).toContain('[redacted]')
    })

    it('announces a change in a session\'s requests to every bot that shows them, raised or answered', async () => {
        const h = makeHarness()
        const { id, home } = await makeBot(h)
        session(h, 'worker')
        h.service.createItem('default', id, { title: 'Refactor', status: 'working', workerSessionId: 'worker' })
        const request: AgentStateRequest = { tool: 'Bash', arguments: { command: 'ls' } }
        await settle()
        // Not counting the first run, which is already in.
        h.delivered.length = 0
        h.events.length = 0

        // Requests of the bot's own home chat count too: they are its owner's to answer.
        h.service.onRequestsChanged(home, [{ requestId: 'own', request }])
        h.service.onRequestsChanged('worker', [{ requestId: 'r1', request }])
        await settle()
        expect(h.events.filter((event) => event.type === 'bots-changed').map((event) => event.botId)).toEqual([id, id])
        // Every ledger event names the bot's home chat, whichever session's requests moved.
        expect(h.events.filter((event) => event.type === 'bot-items-changed').map((event) => [event.botId, event.sessionId])).toEqual([
            [id, home], [id, home]
        ])
        // The bot is not told about its own prompt as if a worker had raised it.
        expect(h.delivered).toHaveLength(1)

        // Answered: nothing new to tell the bot, but the owner's lists change.
        h.events.length = 0
        h.delivered.length = 0
        h.service.onRequestsChanged('worker', [])
        expect(h.events.map((event) => event.type)).toEqual(['bots-changed', 'bot-items-changed'])
        await settle()
        expect(h.delivered).toEqual([])
    })
})

describe('BotError', () => {
    it('carries an HTTP status and a code', () => {
        expect(code(new BotError(409, 'name_taken', 'taken'))).toBe('409 name_taken')
    })
})

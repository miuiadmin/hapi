import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Store } from './index'
import { BOTS_TABLE_SQL, taskFingerprint } from './bots'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string): string {
    return store.sessions.getOrCreateSession(tag, { path: '/tmp', flavor: 'claude' }, null, 'default').id
}

let botCounter = 0

/** A bot with a spare session to use as its home chat. */
function makeBot(store: Store, overrides: Partial<Parameters<Store['bots']['insert']>[0]> = {}): { id: string; home: string } {
    const home = makeSession(store, `home-${++botCounter}`)
    const bot = store.bots.insert({
        namespace: 'default',
        name: 'Ops',
        purpose: 'keeps CI green',
        machineId: 'mac-1',
        homeDir: '/Users/me/.hapi/bots/ops',
        agent: 'claude',
        model: null,
        permissionMode: 'default',
        state: 'active',
        now: 1000,
        ...overrides
    })
    return { id: bot.id, home }
}

describe('BotStore: bots', () => {
    it('inserts, lists by namespace and hides archived bots', () => {
        const store = makeStore()
        const { id: a } = makeBot(store)
        makeBot(store, { namespace: 'tenant', name: 'Other' })
        expect(store.bots.list('default').map((bot) => bot.id)).toEqual([a])
        expect(store.bots.list('tenant')).toHaveLength(1)
        store.bots.update(a, { state: 'archived' }, 2000)
        expect(store.bots.list('default')).toEqual([])
        expect(store.bots.get(a)?.state).toBe('archived')
    })

    it('finds the bot whose home chat a session is', () => {
        const store = makeStore()
        const { id, home } = makeBot(store)
        store.bots.update(id, { homeChatSessionId: home }, 2000)
        expect(store.bots.getByHomeChat(home)?.id).toBe(id)
        expect(store.bots.getByHomeChat('nope')).toBeNull()
        store.bots.update(id, { state: 'archived' }, 3000)
        expect(store.bots.getByHomeChat(home)).toBeNull()
    })

    it('patches only the named fields and bumps updated_at', () => {
        const store = makeStore()
        const { id } = makeBot(store)
        const updated = store.bots.update(id, { purpose: 'new job', state: 'failed', lastError: 'machine offline' }, 5000)
        expect(updated).toMatchObject({ purpose: 'new job', state: 'failed', lastError: 'machine offline', name: 'Ops', updatedAt: 5000 })
        expect(store.bots.update('missing', { purpose: 'x' }, 1)).toBeNull()
    })

    it('a name is unique among live bots whatever the case, but a failed or archived bot does not hold it', () => {
        const store = makeStore()
        const { id } = makeBot(store)
        expect(() => makeBot(store, { name: 'ops' })).toThrow(/UNIQUE constraint/)

        // The owner has to be able to try a failed creation again under the same name.
        store.bots.update(id, { state: 'failed' }, 2000)
        const second = makeBot(store, { name: 'ops' })
        expect(store.bots.list('default').map((bot) => [bot.name, bot.state]).sort()).toEqual([['Ops', 'failed'], ['ops', 'active']])
        // The live one holds the name now.
        expect(() => makeBot(store, { name: 'OPS' })).toThrow(/UNIQUE constraint/)
        store.bots.update(second.id, { state: 'archived' }, 3000)
        expect(() => makeBot(store, { name: 'OPS' })).not.toThrow()
    })

    it('replaces an older definition of the name index instead of keeping it', () => {
        const store = makeStore()
        const db = (store as unknown as { db: Database }).db
        // What an earlier build of this schema left behind: the same index name, holding failed bots to their name.
        db.exec(`
            DROP INDEX idx_bots_live_name;
            CREATE UNIQUE INDEX idx_bots_live_name ON bots(namespace, name COLLATE NOCASE) WHERE state != 'archived';
        `)
        const { id } = makeBot(store)
        store.bots.update(id, { state: 'failed' }, 2000)
        expect(() => makeBot(store, { name: 'ops' })).toThrow(/UNIQUE constraint/)

        // The schema step runs again (a database that stopped mid-upgrade): the index is rebuilt as defined now.
        db.exec(BOTS_TABLE_SQL)
        expect(() => makeBot(store, { name: 'ops' })).not.toThrow()
        // And it is still unique among live bots.
        expect(() => makeBot(store, { name: 'OPS' })).toThrow(/UNIQUE constraint/)
    })

    it('keeps the tasks a pause stopped, each with what to compare against on resume', () => {
        const store = makeStore()
        const { id } = makeBot(store)
        store.bots.update(id, { pausedTasks: [{ id: 'task-a', fingerprint: 'aaaa', nextRunAt: 900 }, { id: 'task-b', fingerprint: 'bbbb', nextRunAt: null }] }, 2000)
        expect(store.bots.get(id)?.pausedTasks).toEqual([{ id: 'task-a', fingerprint: 'aaaa', nextRunAt: 900 }, { id: 'task-b', fingerprint: 'bbbb', nextRunAt: null }])
        // A malformed row reads as nothing to resume; it must not stop the hub from starting.
        ;(store as unknown as { db: Database }).db.prepare('UPDATE bots SET paused_tasks = ? WHERE id = ?')
            .run('[{"id":"x"},{"id":"y","fingerprint":7},{"id":"no-time","fingerprint":"f"},3,"z",{"id":"ok","fingerprint":"ffff","nextRunAt":null}]', id)
        expect(store.bots.get(id)?.pausedTasks).toEqual([{ id: 'ok', fingerprint: 'ffff', nextRunAt: null }])
    })

    describe('taskFingerprint', () => {
        const task = { kind: 'repeat' as const, items: ['Round.'], intervalMs: 60_000, maxRuns: 3 }

        it('moves with what an edit by hand changes', () => {
            expect(taskFingerprint(task)).toBe(taskFingerprint({ ...task }))
            expect(taskFingerprint({ ...task, items: ['Other.'] })).not.toBe(taskFingerprint(task))
            expect(taskFingerprint({ ...task, intervalMs: 120_000 })).not.toBe(taskFingerprint(task))
            expect(taskFingerprint({ ...task, maxRuns: 5 })).not.toBe(taskFingerprint(task))
            expect(taskFingerprint({ ...task, kind: 'queue' })).not.toBe(taskFingerprint(task))
        })

        it('is a short plain string, and the order of a queue is part of it', () => {
            expect(taskFingerprint(task)).toMatch(/^[0-9a-f]{16}$/)
            expect(taskFingerprint({ ...task, kind: 'queue', maxRuns: null, items: ['a', 'b'] }))
                .not.toBe(taskFingerprint({ ...task, kind: 'queue', maxRuns: null, items: ['b', 'a'] }))
        })
    })

    it('fails the creations a previous process left behind, and only those', () => {
        const store = makeStore()
        const { id: stale } = makeBot(store, { name: 'Stale', state: 'creating' })
        const { id: fresh } = makeBot(store, { name: 'Fresh', state: 'creating' })
        const { id: live } = makeBot(store, { name: 'Live' })
        const reserved = makeSession(store, 'reserved')
        store.bots.update(stale, { homeChatSessionId: reserved }, 100)

        const failed = store.bots.failStaleCreating(1_000, 'did not finish', 9_000)
        expect(failed.map((bot) => bot.id)).toEqual([stale])
        expect(store.bots.get(stale)).toMatchObject({ state: 'failed', lastError: 'did not finish', updatedAt: 9_000, homeChatSessionId: reserved })
        expect(store.bots.get(fresh)?.state).toBe('creating')
        expect(store.bots.get(live)?.state).toBe('active')
        // Nothing is repeated, and the name can be used again.
        expect(store.bots.failStaleCreating(1_000, 'did not finish', 9_500)).toEqual([])
        expect(() => makeBot(store, { name: 'stale' })).not.toThrow()

        expect(store.bots.failStaleCreating(10_000, 'did not finish', 10_000).map((bot) => bot.id)).toEqual([fresh])
    })
})

describe('BotStore: items', () => {
    it('numbers items per bot and logs who created them', () => {
        const store = makeStore()
        const { id: botId, home } = makeBot(store)
        const first = store.bots.createItem({ botId, sessionId: home, title: 'Fix flaky test', detail: '', status: 'planned', workerSessionId: null, actor: 'user', now: 10 })
        const second = store.bots.createItem({ botId, sessionId: home, title: 'Review PR', detail: '', status: 'working', workerSessionId: null, actor: 'bot', now: 11 })
        expect(first.number).toBe(1)
        expect(second.number).toBe(2)
        expect(store.bots.listEvents(first.id)).toEqual([
            { id: expect.any(Number), itemId: first.id, seq: 1, kind: 'created', actor: 'user', text: '', createdAt: 10 }
        ])
    })

    it('resolves an item by id or by number, only inside its bot', () => {
        const store = makeStore()
        const { id: botId } = makeBot(store)
        const other = makeBot(store, { name: 'Second' })
        const item = store.bots.createItem({ botId, sessionId: 's', title: 'a', detail: '', status: 'planned', workerSessionId: null, actor: 'bot', now: 1 })
        expect(store.bots.getItem(botId, item.id)?.id).toBe(item.id)
        expect(store.bots.getItem(botId, '1')?.id).toBe(item.id)
        expect(store.bots.getItem(botId, '#1')?.id).toBe(item.id)
        expect(store.bots.getItem(other.id, '1')).toBeNull()
        expect(store.bots.getItem(botId, '9')).toBeNull()
    })

    it('changes status and records the event in one step, keeping ask as JSON', () => {
        const store = makeStore()
        const { id: botId } = makeBot(store)
        const item = store.bots.createItem({ botId, sessionId: 's', title: 'a', detail: '', status: 'working', workerSessionId: null, actor: 'bot', now: 1 })
        const asked = store.bots.mutateItem(item.id, {
            status: 'needs_you',
            ask: { question: 'Android too?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 1 }
        }, { kind: 'ask', actor: 'bot', text: 'Android too?' }, 20)
        expect(asked).toMatchObject({ status: 'needs_you', updatedAt: 20 })
        expect(asked?.ask).toEqual({ question: 'Android too?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 1 })
        const answered = store.bots.mutateItem(item.id, { status: 'working', ask: null }, { kind: 'answered', actor: 'user', text: 'No' }, 30)
        expect(answered?.ask).toBeNull()
        expect(answered?.status).toBe('working')
        const kinds = store.bots.listEvents(item.id).map((event) => [event.seq, event.kind, event.actor])
        expect(kinds).toEqual([[1, 'created', 'bot'], [2, 'ask', 'bot'], [3, 'answered', 'user']])
        expect(store.bots.mutateItem('missing', { status: 'done' }, { kind: 'status', actor: 'bot', text: '' }, 1)).toBeNull()
    })

    it('lists open items, items for a worker, and the needs-you count', () => {
        const store = makeStore()
        const { id: botId } = makeBot(store)
        const worker = makeSession(store, 'worker')
        const a = store.bots.createItem({ botId, sessionId: 's', title: 'a', detail: '', status: 'working', workerSessionId: worker, actor: 'bot', now: 1 })
        store.bots.createItem({ botId, sessionId: 's', title: 'b', detail: '', status: 'done', workerSessionId: null, actor: 'bot', now: 2 })
        expect(store.bots.listOpenItems(botId).map((item) => item.title)).toEqual(['a'])
        expect(store.bots.listItems(botId).map((item) => item.title)).toEqual(['a', 'b'])
        expect(store.bots.listItemsForWorker(worker).map((item) => item.id)).toEqual([a.id])
        store.bots.mutateItem(a.id, { status: 'done', workerSessionId: null }, { kind: 'status', actor: 'bot', text: '' }, 3)
        expect(store.bots.listItemsForWorker(worker)).toEqual([])
        expect(store.bots.countOpenItems(botId)).toBe(0)
    })

    it('caps the event listing at the most recent events', () => {
        const store = makeStore()
        const { id: botId } = makeBot(store)
        const item = store.bots.createItem({ botId, sessionId: 's', title: 'a', detail: '', status: 'planned', workerSessionId: null, actor: 'bot', now: 1 })
        for (let i = 0; i < 5; i++) {
            store.bots.appendEvent(item.id, { kind: 'comment', actor: 'user', text: `note ${i}` }, 10 + i)
        }
        const events = store.bots.listEvents(item.id, 3)
        expect(events.map((event) => event.seq)).toEqual([4, 5, 6])
    })
})

describe('BotStore: session merge', () => {
    it('moves the home chat, the owning chat and attached workers to the surviving session', () => {
        const store = makeStore()
        const { id: botId, home } = makeBot(store)
        store.bots.update(botId, { homeChatSessionId: home }, 5)
        const worker = makeSession(store, 'worker')
        store.bots.createItem({ botId, sessionId: home, title: 'a', detail: '', status: 'working', workerSessionId: worker, actor: 'bot', now: 1 })
        const survivor = makeSession(store, 'survivor')
        store.bots.followMergedSession(home, survivor, 50)
        store.bots.followMergedSession(worker, survivor, 50)
        expect(store.bots.getByHomeChat(survivor)?.id).toBe(botId)
        const item = store.bots.listItems(botId)[0]
        expect(item.sessionId).toBe(survivor)
        expect(item.workerSessionId).toBe(survivor)
    })

    it('leaves the bot alone when the survivor is already a home chat', () => {
        const store = makeStore()
        const { id: first, home: firstHome } = makeBot(store)
        const { id: second, home: secondHome } = makeBot(store, { name: 'Second' })
        store.bots.update(first, { homeChatSessionId: firstHome }, 5)
        store.bots.update(second, { homeChatSessionId: secondHome }, 5)
        expect(() => store.bots.followMergedSession(firstHome, secondHome, 50)).not.toThrow()
        expect(store.bots.getByHomeChat(secondHome)?.id).toBe(second)
    })
})

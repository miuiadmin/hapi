import { describe, expect, it, vi } from 'vitest'
import { SESSION_TASK_MIN_INTERVAL_MS, SessionTaskSchema, type SessionTask } from '@hapi/protocol'
import {
    addTask,
    buildTaskSpec,
    createTask,
    deleteTask,
    formatNextRun,
    formatTaskCreated,
    formatTaskLine,
    isOnceTask,
    listTasks,
    resolveTaskId,
    updateTask
} from './tasks'
import { humanizeDuration, parseDurationMs, parsePointInTime } from './time'
import { BotClientError } from './botClient'

type MockResponse = { status: number; data: unknown }

/** Any URL that reaches http must be absolute: the modules write `/api/...` and the client prefixes the hub. */
function guard(url: string): void {
    if (!url.startsWith('http://hub.test/')) {
        throw new Error(`relative URL reached http: ${url}`)
    }
}

function createHttpMock(handlers: {
    get?: (url: string) => MockResponse
    post?: (url: string, body?: unknown) => MockResponse
    patch?: (url: string, body?: unknown) => MockResponse
    delete?: (url: string) => MockResponse
}) {
    const reject = (m: string, url: string) => Promise.reject(new Error(`unexpected ${m} ${url}`))
    return {
        get: vi.fn(async (url: string) => { guard(url); return handlers.get ? handlers.get(url) : reject('GET', url) }),
        post: vi.fn(async (url: string, body?: unknown) => { guard(url); return handlers.post ? handlers.post(url, body) : reject('POST', url) }),
        patch: vi.fn(async (url: string, body?: unknown) => { guard(url); return handlers.patch ? handlers.patch(url, body) : reject('PATCH', url) }),
        delete: vi.fn(async (url: string) => { guard(url); return handlers.delete ? handlers.delete(url) : reject('DELETE', url) })
    }
}

const auth = { status: 200, data: { token: 'jwt' } }
const SESSION = 'home-1'
const opts = (http: unknown) => ({ sessionId: SESSION, apiUrl: 'http://hub.test', accessToken: 'tok', http: http as never })
const NOW = Date.parse('2026-11-27T10:00:00.000Z')

function task(overrides: Partial<SessionTask> = {}): SessionTask {
    return SessionTaskSchema.parse({
        id: 'task-1',
        sessionId: SESSION,
        kind: 'repeat',
        state: 'active',
        items: [{ text: 'Check CI' }],
        intervalMs: 2 * 3600_000,
        maxRuns: null,
        runCount: 0,
        totalRuns: null,
        startAt: NOW,
        nextRunAt: NOW + 2 * 3600_000,
        pending: false,
        lastRunAt: null,
        lastError: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides
    })
}

describe('time shorthands', () => {
    it('parses durations with units and refuses bare numbers', () => {
        expect(parseDurationMs('90m')).toBe(90 * 60_000)
        expect(parseDurationMs('2h')).toBe(7_200_000)
        expect(parseDurationMs('1d')).toBe(86_400_000)
        expect(parseDurationMs('1h30m')).toBe(5_400_000)
        expect(parseDurationMs('45s')).toBe(45_000)
        expect(parseDurationMs('30')).toBeNull()
        expect(parseDurationMs('soon')).toBeNull()
        expect(parseDurationMs('')).toBeNull()
    })

    it('parses points in time: ISO, "in 30m", "+1h", relative durations; refuses bare digits', () => {
        expect(parsePointInTime('2026-11-28T09:00:00+08:00', NOW)).toBe(Date.parse('2026-11-28T09:00:00+08:00'))
        // A bare date is local midnight, not UTC midnight.
        expect(parsePointInTime('2026-11-28', NOW)).toBe(new Date(2026, 10, 28).getTime())
        expect(parsePointInTime('2026-02-30', NOW)).toBeNull()
        expect(parsePointInTime('in 30m', NOW)).toBe(NOW + 30 * 60_000)
        expect(parsePointInTime('+1h', NOW)).toBe(NOW + 3_600_000)
        expect(parsePointInTime('2d', NOW)).toBe(NOW + 2 * 86_400_000)
        expect(parsePointInTime('1764235200000', NOW)).toBeNull()
        expect(parsePointInTime('tomorrow', NOW)).toBeNull()
    })

    it('humanizes durations', () => {
        expect(humanizeDuration(7_200_000)).toBe('2h')
        expect(humanizeDuration(5_400_000)).toBe('1h30m')
        expect(humanizeDuration(500)).toBe('1s')
        expect(humanizeDuration(-90_000)).toBe('-1m30s')
    })
})

describe('buildTaskSpec', () => {
    it('builds a repeating task, a queue, and a one-shot as one repeat task with a single run', () => {
        expect(buildTaskSpec({ every: '2h', text: 'Check CI', maxRuns: 5 }, NOW)).toEqual({
            kind: 'repeat', text: 'Check CI', intervalMs: 7_200_000, maxRuns: 5
        })
        expect(buildTaskSpec({ every: '30m', prompts: ['a', ' b '], startAt: 'in 1h' }, NOW)).toEqual({
            kind: 'queue', prompts: ['a', 'b'], intervalMs: 1_800_000, startAt: NOW + 3_600_000
        })
        // Not a scheduled message: a task with an id, so list / pause / delete work on it.
        expect(buildTaskSpec({ at: 'in 30m', text: 'Stand-up' }, NOW)).toEqual({
            kind: 'repeat', text: 'Stand-up', intervalMs: 60_000, startAt: NOW + 1_800_000, maxRuns: 1
        })
        expect(buildTaskSpec({ at: '2026-11-28T09:00:00+08:00', text: 'Stand-up' }, NOW)).toMatchObject({
            kind: 'repeat', intervalMs: SESSION_TASK_MIN_INTERVAL_MS, maxRuns: 1, startAt: Date.parse('2026-11-28T09:00:00+08:00')
        })
        // Up to the hub's 366-day window for a first run.
        expect(buildTaskSpec({ at: 'in 300d', text: 'later' }, NOW)).toMatchObject({ kind: 'repeat', maxRuns: 1 })
    })

    it.each([
        [{ every: '2h', at: 'in 1h', text: 'x' }, /not both/],
        [{ text: 'x' }, /give every|or at/],
        [{ every: '2h' }, /text is required/],
        [{ every: '30m', prompts: ['a'], maxRuns: 2 }, /maxRuns only applies to a repeating task.*not a queue/],
        [{ at: 'in 1h', text: 'x', maxRuns: 1 }, /maxRuns only applies to a repeating task/],
        [{ at: 'in 1h', prompts: ['a'] }, /one-shot takes text, not prompts/],
        [{ every: '30m', prompts: ['a'], text: 'b' }, /prompts \(a queue\) or text, not both/],
        [{ at: 'in 1h' }, /text is required/],
        [{ at: '2020-01-01T00:00:00Z', text: 'x' }, /at="2020-01-01T00:00:00Z" is in the past/],
        [{ at: 'in 400d', text: 'x' }, /more than a year ahead/],
        [{ at: 'soon', text: 'x' }, /cannot parse at/],
        [{ at: 'in 1h', text: 'x', startAt: 'in 1h' }, /a one-shot takes at, not startAt/],
        [{ every: '30s', text: 'x' }, /shorter than the hub minimum/],
        [{ every: '31d', text: 'x' }, /longer than the hub maximum/],
        [{ every: '2h', text: 'x', maxRuns: 0 }, /maxRuns must be an integer/],
        [{ every: '2h', text: 'x', startAt: '2020-01-01T00:00:00Z' }, /in the past/],
        [{ every: 'soon', text: 'x' }, /cannot parse every/]
    ] as const)('rejects %j', (input, message) => {
        expect(() => buildTaskSpec(input as never, NOW)).toThrow(message)
    })

    it('accepts the hub minimum interval and strips nothing from text', () => {
        expect(buildTaskSpec({ every: '1m', text: ' x ' }, NOW)).toMatchObject({ kind: 'repeat', intervalMs: SESSION_TASK_MIN_INTERVAL_MS, text: 'x' })
    })
})

describe('task REST calls', () => {
    it('creates a repeat task with the contract body and reports the next run', async () => {
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return auth
                expect(url).toBe('http://hub.test/api/sessions/home-1/tasks')
                expect(body).toEqual({ kind: 'repeat', text: 'Check CI', intervalMs: 7_200_000, maxRuns: 3 })
                return { status: 201, data: { task: task() } }
            }
        })
        const created = await addTask({ ...opts(http), spec: { kind: 'repeat', text: 'Check CI', intervalMs: 7_200_000, maxRuns: 3 } })
        expect(created.id).toBe('task-1')
        expect(formatTaskCreated(created, NOW)).toContain(`created task task-1 [active] repeat every 2h, until deleted; next run: ${new Date(NOW + 7_200_000).toISOString()} (in 2h); runs: 0`)
    })

    it('creates a queue task with items', async () => {
        const http = createHttpMock({
            post: (url, body) => url.endsWith('/api/auth')
                ? auth
                : (expect(body).toEqual({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 1_800_000 }), { status: 201, data: { task: task({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }] }) } })
        })
        const created = await addTask({ ...opts(http), spec: { kind: 'queue', prompts: ['a', 'b'], intervalMs: 1_800_000 } })
        expect(created.kind).toBe('queue')
    })

    it('creates a one-shot through POST /tasks — never as a scheduled message — and lists it as "once"', async () => {
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return auth
                // Same route as every other task, so it has an id and can be paused or deleted.
                expect(url).toBe('http://hub.test/api/sessions/home-1/tasks')
                expect(body).toEqual({ kind: 'repeat', text: 'Stand-up', intervalMs: 60_000, startAt: NOW + 1_800_000, maxRuns: 1 })
                return { status: 201, data: { task: task({ items: [{ text: 'Stand-up' }], intervalMs: 60_000, maxRuns: 1, totalRuns: 1, nextRunAt: NOW + 1_800_000 }) } }
            }
        })
        const created = await addTask({ ...opts(http), spec: buildTaskSpec({ at: 'in 30m', text: 'Stand-up' }, NOW) })
        expect(isOnceTask(created)).toBe(true)
        expect(isOnceTask(task({ totalRuns: 3 }))).toBe(false)
        expect(isOnceTask(task({ kind: 'queue', totalRuns: 1 }))).toBe(false)
        expect(http.post).toHaveBeenCalledTimes(2) // auth + create; nothing to /messages
        expect(formatTaskCreated(created, NOW)).toBe(`created task task-1 [active] once; next run: 2026-11-27T10:30:00.000Z (in 30m); runs: 0/1; "Stand-up"; id: task-1`)
        expect(formatTaskLine(task({ items: [{ text: 'Stand-up' }], maxRuns: 1, totalRuns: 1, state: 'paused', nextRunAt: null }), NOW)).toContain('[paused] once; next run: (paused); runs: 0/1')
    })

    it('lists, pauses, resumes and deletes by id or unique prefix', async () => {
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : { status: 500, data: {} },
            get: (url) => ({ status: 200, data: { tasks: [task({ id: 'aaaaaaaa-1' }), task({ id: 'bbbbbbbb-2', state: 'paused', nextRunAt: null })] } }),
            patch: (url, body) => {
                expect(url).toBe('http://hub.test/api/sessions/home-1/tasks/aaaaaaaa-1')
                expect(body).toEqual({ paused: true })
                return { status: 200, data: { task: task({ state: 'paused', nextRunAt: null }) } }
            },
            delete: (url) => {
                expect(url).toBe('http://hub.test/api/sessions/home-1/tasks/bbbbbbbb-2')
                return { status: 200, data: { ok: true } }
            }
        })
        const tasks = await listTasks(opts(http))
        expect(resolveTaskId(tasks, 'aaaa')).toBe('aaaaaaaa-1')
        expect(() => resolveTaskId(tasks, 'zz')).toThrow(BotClientError)
        const paused = await updateTask({ ...opts(http), taskId: 'aaaaaaaa-1', paused: true })
        expect(paused.state).toBe('paused')
        expect(formatNextRun(paused, NOW)).toBe('next run: (paused)')
        await expect(deleteTask({ ...opts(http), taskId: 'bbbbbbbb-2' })).resolves.toBeUndefined()
    })

    it('refuses a missing session id before any request', async () => {
        const http = createHttpMock({})
        await expect(listTasks({ apiUrl: 'http://hub.test', accessToken: 'tok', sessionId: ' ', http: http as never }))
            .rejects.toMatchObject({ code: 'bad_args' })
        expect(http.post).not.toHaveBeenCalled()
    })

    it('reports an ambiguous prefix and a missing task', async () => {
        const tasks = [task({ id: 'task-a1' }), task({ id: 'task-a2' })]
        expect(() => resolveTaskId(tasks, 'task-a')).toThrow(/matches 2 tasks/)
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : { status: 500, data: {} },
            get: () => ({ status: 200, data: { tasks: [] } }),
            delete: () => ({ status: 404, data: { error: 'Task not found' } })
        })
        await expect(deleteTask({ ...opts(http), taskId: 'gone' })).rejects.toMatchObject({ code: 'not_found' })
    })
})

describe('task formatting', () => {
    it('always names the next run and explains a queue waiting on the agent', () => {
        const line = formatTaskLine(task(), NOW)
        expect(line).toContain('task task-1 [active] repeat every 2h')
        expect(line).toContain(`next run: ${new Date(NOW + 7_200_000).toISOString()} (in 2h)`)
        expect(line).toContain('"Check CI"')
        const queue = task({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], runCount: 1, nextRunAt: null, pending: true, intervalMs: 1_800_000 })
        expect(formatNextRun(queue, NOW)).toBe('next run: after the agent takes the previous prompt')
        expect(formatTaskLine(queue, NOW)).toContain('queue of 2 prompts every 30m (1 left)')
        expect(formatNextRun(task({ nextRunAt: null, pending: false }), NOW)).toBe('next run: (none scheduled)')
        // A one-shot right after it fired: the hub still lists it until the prompt is taken, with a "next run" that will not happen.
        expect(formatTaskLine(task({ items: [{ text: 'Ping' }], intervalMs: 60_000, maxRuns: 1, totalRuns: 1, runCount: 1, nextRunAt: NOW + 60_000, pending: true }), NOW))
            .toContain('finished: all 1 run done; it leaves the list once the last prompt is taken; runs: 1/1')
        expect(formatNextRun(task({ maxRuns: 3, totalRuns: 3, runCount: 3, nextRunAt: NOW + 60_000 }), NOW)).toContain('finished: all 3 runs done')
        expect(formatTaskLine(task({ lastError: 'machine_offline' }), NOW)).toContain('last error: machine_offline')
    })

})

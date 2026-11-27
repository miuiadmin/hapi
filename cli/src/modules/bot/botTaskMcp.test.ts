import { describe, expect, it, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { SessionTaskSchema, type SessionTask } from '@hapi/protocol'
import { handleBotTaskTool } from './botTaskMcp'

type MockResponse = { status: number; data: unknown }
type MockHandler = (url: string, body?: unknown) => MockResponse | Promise<MockResponse>

/** Any URL that reaches http must be absolute: the modules write `/api/...` and the client prefixes the hub. */
function guard(url: string): void {
    if (!url.startsWith('http://hub.test/')) {
        throw new Error(`relative URL reached http: ${url}`)
    }
}

function createHttpMock(handlers: {
    get?: (url: string) => MockResponse
    post?: MockHandler
    patch?: MockHandler
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

const NOW = Date.parse('2026-11-27T10:00:00.000Z')
const auth = { status: 200, data: { token: 'jwt' } }

function task(overrides: Partial<SessionTask> = {}): SessionTask {
    return SessionTaskSchema.parse({
        id: 'task-1', sessionId: 'home-1', kind: 'repeat', state: 'active', items: [{ text: 'Check CI' }], intervalMs: 7_200_000,
        maxRuns: null, runCount: 0, totalRuns: null, startAt: NOW, nextRunAt: NOW + 7_200_000, pending: false, lastRunAt: null, lastError: null,
        createdAt: NOW, updatedAt: NOW, ...overrides
    })
}

const ctx = (http: unknown) => ({ botId: 'bot-1', sessionId: 'home-1', http: http as AxiosInstance, apiUrl: 'http://hub.test', accessToken: 'tok', now: () => NOW })

describe('bot_task', () => {
    it('adds a repeating task and names the next run', async () => {
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return auth
                expect(url).toBe('http://hub.test/api/sessions/home-1/tasks')
                expect(body).toEqual({ kind: 'repeat', text: 'Check CI', intervalMs: 7_200_000, maxRuns: 3 })
                return { status: 201, data: { task: task({ maxRuns: 3, totalRuns: 3 }) } }
            }
        })
        const result = await handleBotTaskTool({ action: 'add', every: '2h', text: 'Check CI', maxRuns: 3 }, ctx(http))
        expect(result.isError).toBe(false)
        expect(result.text).toContain('created task task-1 [active] repeat every 2h, 3 runs in total')
        expect(result.text).toContain(`next run: ${new Date(NOW + 7_200_000).toISOString()} (in 2h)`)
    })

    it('adds a queue of prompts, and a one-shot as a single-run task on the tasks route', async () => {
        const bodies: unknown[] = []
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return auth
                expect(url).toBe('http://hub.test/api/sessions/home-1/tasks')
                bodies.push(body)
                const request = body as { kind: string; text?: string; startAt?: number }
                if (request.kind === 'queue') {
                    return { status: 201, data: { task: task({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 1_800_000, nextRunAt: NOW + 3_600_000 }) } }
                }
                // A one-shot is a task (id, pausable, deletable), not a scheduled message.
                return { status: 201, data: { task: task({ items: [{ text: request.text ?? '' }], intervalMs: 60_000, maxRuns: 1, totalRuns: 1, nextRunAt: request.startAt ?? NOW }) } }
            }
        })
        const queue = await handleBotTaskTool({ action: 'add', every: '30m', prompts: ['a', 'b'], startAt: 'in 1h' }, ctx(http))
        expect(queue.text).toContain('queue of 2 prompts every 30m (2 left)')
        expect(queue.text).toContain(`next run: ${new Date(NOW + 3_600_000).toISOString()} (in 1h)`)
        expect(bodies[0]).toEqual({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 1_800_000, startAt: NOW + 3_600_000 })

        const once = await handleBotTaskTool({ action: 'add', at: 'in 30m', text: 'Stand-up' }, ctx(http))
        expect(once.isError).toBe(false)
        expect(bodies[1]).toEqual({ kind: 'repeat', text: 'Stand-up', intervalMs: 60_000, startAt: NOW + 1_800_000, maxRuns: 1 })
        expect(once.text).toBe('created task task-1 [active] once; next run: 2026-11-27T10:30:00.000Z (in 30m); runs: 0/1; "Stand-up"; id: task-1')

        // Far-ahead one-shots are fine now (the hub's 366-day first-run window).
        const later = await handleBotTaskTool({ action: 'add', at: 'in 30d', text: 'monthly' }, ctx(http))
        expect(later.isError).toBe(false)
        expect(bodies[2]).toEqual({ kind: 'repeat', text: 'monthly', intervalMs: 60_000, startAt: NOW + 30 * 86_400_000, maxRuns: 1 })
        expect(later.text).toContain('[active] once;')
        // Nothing was ever posted to /messages.
        expect(http.post.mock.calls.map((call) => call[0]).filter((url) => String(url).includes('/messages'))).toEqual([])
    })

    it('lists, pauses, resumes and deletes by id or prefix', async () => {
        const http = createHttpMock({
            post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)),
            get: () => ({ status: 200, data: { tasks: [task()] } }),
            patch: (_url, body) => {
                const paused = (body as { paused: boolean }).paused
                return { status: 200, data: { task: task({ state: paused ? 'paused' : 'active', nextRunAt: paused ? null : NOW + 7_200_000 }) } }
            },
            delete: (url) => { expect(url).toBe('http://hub.test/api/sessions/home-1/tasks/task-1'); return { status: 200, data: { ok: true } } }
        })
        const list = await handleBotTaskTool({ action: 'list' }, ctx(http))
        expect(list.text.split('\n')).toHaveLength(2)
        expect(list.text.split('\n')[1]).toMatch(/^  task task-1 \[active\] repeat every 2h/)
        expect(list.text).toContain(`next run: ${new Date(NOW + 7_200_000).toISOString()} (in 2h)`)
        const paused = await handleBotTaskTool({ action: 'pause', taskId: 'task' }, ctx(http))
        expect(paused.text).toContain('[paused]')
        expect(paused.text).toContain('next run: (paused)')
        const resumed = await handleBotTaskTool({ action: 'resume', taskId: 'task-1' }, ctx(http))
        expect(resumed.isError).toBe(false)
        expect(resumed.text).toContain('[active]')
        expect(resumed.text).toContain('next run: 2026-11-27T12:00:00.000Z (in 2h)')
        const deleted = await handleBotTaskTool({ action: 'delete', taskId: 'task-1' }, ctx(http))
        expect(deleted.text).toBe('Deleted task task-1')
        // One auth exchange per tool call (four calls: list, pause, resume, delete), not one per request.
        expect(http.post.mock.calls.filter((call) => String(call[0]).endsWith('/api/auth'))).toHaveLength(4)
    })

    it('validates its input and surfaces build errors as tool errors', async () => {
        const http = createHttpMock({ post: (url) => url.endsWith('/api/auth') ? auth : Promise.reject(new Error(`unexpected POST ${url}`)) })
        const cases: Array<[Parameters<typeof handleBotTaskTool>[0], RegExp]> = [
            [{ action: 'add', text: 'x' }, /action=add needs every|or at/],
            [{ action: 'add', every: '2h', at: 'in 1h', text: 'x' }, /not both/],
            [{ action: 'add', every: 'soon', text: 'x' }, /cannot parse every/],
            [{ action: 'add', at: '2020-01-01T00:00:00Z', text: 'x' }, /in the past/],
            [{ action: 'add', at: 'in 400d', text: 'x' }, /more than a year ahead/],
            [{ action: 'add', at: 'in 1h', text: 'x', maxRuns: 2 }, /maxRuns only applies/],
            [{ action: 'add', every: '2h', text: 'x', taskId: 't' }, /taskId is not accepted/],
            [{ action: 'pause' }, /taskId is required/],
            [{ action: 'pause', taskId: 't', every: '2h' }, /takes taskId only/],
            [{ action: 'list', text: 'x' }, /takes no other fields/]
        ]
        for (const [args, message] of cases) {
            const result = await handleBotTaskTool(args, ctx(http))
            expect(result.isError, JSON.stringify(args)).toBe(true)
            expect(result.text).toMatch(message)
        }
        expect(http.post).not.toHaveBeenCalled()
    })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tokenInit from '@/ui/tokenInit'
import * as tasksModule from '@/modules/bot/tasks'
import { BotClientError } from '@/modules/bot/botClient'
import { handleTaskCommand, handleTaskHelpOrUsage, parseTaskArgs } from './task'

describe('parseTaskArgs', () => {
    it('parses a repeating task with --every, --start-at and --max-runs', () => {
        expect(parseTaskArgs(['add', '--every', '2h', '--text', 'Check CI', '--start-at', 'in 1h', '--max-runs', '5']))
            .toMatchObject({ action: 'add', texts: ['Check CI'], every: '2h', startAt: 'in 1h', maxRuns: 5, queue: false })
    })

    it('parses a one-shot with --at and a queue with repeated --text', () => {
        expect(parseTaskArgs(['add', '--at=2026-11-28T09:00:00+08:00', '--text', 'Stand-up']))
            .toMatchObject({ action: 'add', texts: ['Stand-up'], at: '2026-11-28T09:00:00+08:00' })
        expect(parseTaskArgs(['add', '--queue', '--every', '30m', '--text', 'a', '--text=b']))
            .toMatchObject({ action: 'add', queue: true, every: '30m', texts: ['a', 'b'] })
    })

    it('refuses a positional text next to --text, and takes everything after -- as positional', () => {
        expect(() => parseTaskArgs(['add', 'foo', '--every', '1h', '--text', 'bar'])).toThrow(/give the text as a positional or with --text, not both/)
        expect(parseTaskArgs(['add', '--every', '1h', '--text', '-odd'])).toMatchObject({ texts: ['-odd'] })
        expect(parseTaskArgs(['add', '--every', '1h', '--', '-odd', '--x'])).toMatchObject({ texts: ['-odd --x'] })
        expect(parseTaskArgs(['pause', '--', '-abc'])).toMatchObject({ taskId: '-abc' })
    })

    it('parses list, pause, resume, delete and --session', () => {
        expect(parseTaskArgs(['list'])).toMatchObject({ action: 'list' })
        expect(parseTaskArgs(['pause', 'abc', '--session', 'sess-1'])).toMatchObject({ action: 'pause', taskId: 'abc', sessionId: 'sess-1' })
        expect(parseTaskArgs(['resume', 'abc'])).toMatchObject({ action: 'resume', taskId: 'abc' })
        expect(parseTaskArgs(['delete', 'abc'])).toMatchObject({ action: 'delete', taskId: 'abc' })
        expect(parseTaskArgs(['--help']).help).toBe(true)
    })

    it.each([
        [['add'], /needs the text: --text/],
        [['pause', 'abc', 'extra'], /unexpected arg: extra \(hapi task pause takes one task id\)/],
        [['list', 'abc', 'extra'], /unexpected arg/],
        [['add', '--text', 'a', '--text', 'b'], /several --text need --queue/],
        [['add', '--queue', '--at', 'in 1h', '--text', 'a'], /not --queue/],
        [['add', '--text', 'x'], /--every .* or --at/],
        [['pause'], /hapi task pause <taskId>/],
        [['list', 'abc'], /takes no task id/],
        [['pause', 'abc', '--every', '2h'], /only valid with hapi task add/],
        [['delete', 'abc', '--text', 'x'], /--text is only valid/],
        [['frobnicate'], /unknown action/],
        [['add', '--max-runs', '0', '--text', 'x', '--every', '1h'], /positive integer/],
        [['list', '--nope'], /unexpected flag/]
    ] as const)('rejects %j', (args, message) => {
        expect(() => parseTaskArgs([...args])).toThrow(message)
    })
})

describe('handleTaskCommand', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.HAPI_SESSION_ID
    })

    it('targets HAPI_SESSION_ID by default and names the next run', async () => {
        process.env.HAPI_SESSION_ID = 'home-1'
        const add = vi.spyOn(tasksModule, 'addTask').mockResolvedValue({
            // Half a minute of slack: the handler formats against its own clock a few
            // ms later, and 2h minus a few ms humanizes as "1h59m59s" under load.
            id: 'task-1', kind: 'repeat', state: 'active', items: [{ text: 'Check CI' }], intervalMs: 7_200_000, maxRuns: null, totalRuns: null, runCount: 0, nextRunAt: Date.now() + 7_200_000 + 30_000, pending: false, lastError: null
        } as never)
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleTaskCommand(['add', '--every', '2h', '--text', 'Check CI'])
        expect(add).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'home-1',
            spec: expect.objectContaining({ kind: 'repeat', intervalMs: 7_200_000, text: 'Check CI' })
        }))
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/next run: \S+ \(in 2h/))
    })

    it('builds a queue from repeated --text and a one-shot from --at as a single-run task', async () => {
        const add = vi.spyOn(tasksModule, 'addTask').mockResolvedValue({
            id: 'task-9', kind: 'repeat', state: 'active', items: [{ text: 'Stand-up' }], intervalMs: 60_000, maxRuns: 1, totalRuns: 1, runCount: 0, nextRunAt: Date.now() + 1_800_000 + 30_000, pending: false, lastError: null
        } as never)
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleTaskCommand(['add', '--queue', '--every', '30m', '--text', 'a', '--text', 'b', '--session', 's'])
        expect(add).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', spec: { kind: 'queue', prompts: ['a', 'b'], intervalMs: 1_800_000 }, auth: expect.objectContaining({ get: expect.any(Function) }) }))
        const before = Date.now()
        await handleTaskCommand(['add', '--at', 'in 30m', '--text', 'Stand-up', '--session', 's'])
        expect(add).toHaveBeenLastCalledWith(expect.objectContaining({
            spec: {
                kind: 'repeat', text: 'Stand-up', intervalMs: 60_000, maxRuns: 1,
                startAt: expect.any(Number)
            }
        }))
        const spec = (add.mock.calls[1] as unknown as [{ spec: { startAt: number } }])[0].spec
        expect(spec.startAt).toBeGreaterThanOrEqual(before + 1_800_000)
        expect(spec.startAt).toBeLessThanOrEqual(Date.now() + 1_800_000)
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining('[active] once; next run: '))
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining('runs: 0/1'))
    })

    it('rejects a one-shot in the past or too far ahead', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await expect(handleTaskCommand(['add', '--at', '2020-01-01T00:00:00Z', '--text', 'x', '--session', 's'])).rejects.toThrow(/in the past/)
        await expect(handleTaskCommand(['add', '--at', 'in 400d', '--text', 'x', '--session', 's'])).rejects.toThrow(/more than a year ahead/)
    })

    it('pauses by unique prefix and deletes', async () => {
        const now = Date.now()
        const base = {
            sessionId: 's', kind: 'repeat' as const, items: [{ text: 'x' }], intervalMs: 7_200_000, maxRuns: null, totalRuns: null,
            runCount: 0, startAt: now, pending: false, lastRunAt: null, lastError: null, createdAt: now, updatedAt: now
        }
        const list = vi.spyOn(tasksModule, 'listTasks').mockResolvedValue([
            { ...base, id: 'aaaaaaaa-1', state: 'active', nextRunAt: now + 7_200_000 },
            { ...base, id: 'bbbbbbbb-2', state: 'active', nextRunAt: now + 7_200_000 }
        ])
        const update = vi.spyOn(tasksModule, 'updateTask').mockResolvedValue({ ...base, id: 'aaaaaaaa-1', state: 'paused', nextRunAt: null })
        const del = vi.spyOn(tasksModule, 'deleteTask').mockResolvedValue(undefined)
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleTaskCommand(['pause', 'aaaa', '--session', 's'])
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', taskId: 'aaaaaaaa-1', paused: true }))
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining('[paused]'))
        await handleTaskCommand(['delete', 'bbbbbbbb-2', '--session', 's'])
        expect(del).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', taskId: 'bbbbbbbb-2' }))
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Deleted task bbbbbbbb-2'))
        // One JWT for the whole command: list + update / delete share an auth source.
        const firstAuth = (list.mock.calls[0]![0] as { auth: unknown }).auth
        expect((update.mock.calls[0]![0] as { auth: unknown }).auth).toBe(firstAuth)
        await expect(handleTaskCommand(['pause', 'aaaa', 'extra', '--session', 's'])).rejects.toMatchObject({ code: 'bad_args' })
    })

    it('fails with bad_args for an impossible schedule', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await expect(handleTaskCommand(['add', '--every', 'soon', '--text', 'x', '--session', 's'])).rejects.toBeInstanceOf(BotClientError)
    })
})

describe('hapi task help', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('--help prints the help and needs no hub credential', () => {
        const token = vi.spyOn(tokenInit, 'initializeToken')
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        expect(handleTaskHelpOrUsage(['--help'])).toBe('handled')
        expect(log).toHaveBeenCalledTimes(1)
        expect(log).toHaveBeenCalledWith(expect.stringContaining('hapi task add --every 2h'))
        expect(log).toHaveBeenCalledWith(expect.stringContaining('--session <id>'))
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Exit codes:'))
        expect(log).toHaveBeenCalledWith(expect.stringContaining('2026-11-28 = local midnight'))
        expect(token).not.toHaveBeenCalled()
    })

    it('a bare `hapi task` prints the help and fails with the usage line', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        expect(() => handleTaskHelpOrUsage([])).toThrow(/missing action; usage: hapi task add\|list/)
        expect(log).toHaveBeenCalledTimes(1)
        expect(handleTaskHelpOrUsage(['list'])).toBe('run')
    })
})

describe('hapi task --session inside a bot session', () => {
    const full = () => ({
        id: 'aaaaaaaa-1', sessionId: 's', kind: 'repeat' as const, items: [{ text: 'x' }], intervalMs: 7_200_000, maxRuns: null, totalRuns: null,
        runCount: 0, nextRunAt: Date.now() + 7_200_000, startAt: 1, pending: false, lastRunAt: null, lastError: null, createdAt: 1, updatedAt: 1, state: 'active' as const
    })

    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.HAPI_SESSION_ID
        delete process.env.HAPI_BOT_ID
    })

    function bot() {
        process.env.HAPI_SESSION_ID = 'home-1'
        process.env.HAPI_BOT_ID = 'bot-1'
        const list = vi.spyOn(tasksModule, 'listTasks').mockResolvedValue([full()])
        vi.spyOn(console, 'log').mockImplementation(() => {})
        return list
    }

    it('--session omitted: the bot schedules itself', async () => {
        const list = bot()
        await handleTaskCommand(['list'])
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'home-1' }))
    })

    it('--session <own home chat>: allowed', async () => {
        const list = bot()
        await handleTaskCommand(['list', '--session', 'home-1'])
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'home-1' }))
        const update = vi.spyOn(tasksModule, 'updateTask').mockResolvedValue({ ...full(), state: 'paused', nextRunAt: null })
        await handleTaskCommand(['pause', 'aaaaaaaa', '--session', 'home-1'])
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'home-1', taskId: 'aaaaaaaa-1', paused: true }))
    })

    it('--session <other>: refused for list, pause, resume, delete and add — no request leaves', async () => {
        const list = bot()
        const update = vi.spyOn(tasksModule, 'updateTask')
        const del = vi.spyOn(tasksModule, 'deleteTask')
        const add = vi.spyOn(tasksModule, 'addTask')
        for (const args of [
            ['list', '--session', 'other'],
            ['pause', 'aaaaaaaa', '--session', 'other'],
            ['resume', 'aaaaaaaa', '--session', 'other'],
            ['delete', 'aaaaaaaa', '--session', 'other'],
            ['add', '--every', '1h', '--text', 'x', '--session', 'other']
        ]) {
            await expect(handleTaskCommand(args)).rejects.toMatchObject({
                code: 'forbidden',
                message: expect.stringMatching(/a bot schedules only itself.*peer tools/)
            })
        }
        expect(list).not.toHaveBeenCalled()
        expect(update).not.toHaveBeenCalled()
        expect(del).not.toHaveBeenCalled()
        expect(add).not.toHaveBeenCalled()
    })

    it('outside a bot session --session <other> still works as before', async () => {
        delete process.env.HAPI_BOT_ID
        process.env.HAPI_SESSION_ID = 'home-1'
        const list = vi.spyOn(tasksModule, 'listTasks').mockResolvedValue([])
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleTaskCommand(['list', '--session', 'other'])
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'other' }))
    })
})

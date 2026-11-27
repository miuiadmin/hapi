import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tokenInit from '@/ui/tokenInit'
import * as itemsModule from '@/modules/bot/items'
import { BotClientError } from '@/modules/bot/botClient'
import { HAPI_BOT_ID_ENV, HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { handleItemCommand, handleItemHelpOrUsage, parseItemArgs } from './item'

describe('parseItemArgs', () => {
    it('parses add with a positional title and flags', () => {
        const parsed = parseItemArgs(['add', 'Fix the flaky test', '--detail=steps', '--status', 'working', '--worker', 'w-1'])
        expect(parsed).toMatchObject({ action: 'add', title: 'Fix the flaky test', detail: 'steps', status: 'working', workerSessionId: 'w-1' })
        expect(parsed.itemRef).toBeUndefined()
    })

    it('parses set by number or id, with snooze and status', () => {
        expect(parseItemArgs(['set', '12', '--status=waiting', '--snooze-until', 'in 2h']))
            .toMatchObject({ action: 'set', itemRef: 12, status: 'waiting', snoozeUntil: 'in 2h' })
        expect(parseItemArgs(['set', 'item-abc', '--worker', 'w-2', '--detail', 'more']).itemRef).toBe('item-abc')
    })

    it('parses ask with options and recommendation, and comment text with spaces', () => {
        expect(parseItemArgs(['ask', '3', '--question', 'Which?', '--option', 'main', '--option=release', '--recommended', '0']))
            .toMatchObject({ action: 'ask', itemRef: 3, question: 'Which?', options: ['main', 'release'], recommended: 0 })
        expect(parseItemArgs(['comment', '3', 'go', 'with', 'main'])).toMatchObject({ action: 'comment', itemRef: 3, text: 'go with main' })
        expect(parseItemArgs(['comment', '3', '--text', 'ok'])).toMatchObject({ action: 'comment', text: 'ok' })
    })

    it('accepts #N the way the tools print it, `none` to detach / clear, and -- for titles that start with -', () => {
        expect(parseItemArgs(['show', '#3']).itemRef).toBe(3)
        expect(parseItemArgs(['set', ' #12 ', '--worker', 'none', '--snooze-until=none'])).toMatchObject({ itemRef: 12, workerSessionId: null, snoozeUntil: null })
        expect(parseItemArgs(['add', '--', '-odd title', '--still', 'title'])).toMatchObject({ title: '-odd title --still title' })
        expect(parseItemArgs(['comment', '--', '#3', '--text'])).toMatchObject({ itemRef: 3, text: '--text' })
    })

    it('parses list, show, done, cancel and the bot override', () => {
        expect(parseItemArgs(['list', '--all', '--bot', 'bot-9'])).toMatchObject({ action: 'list', all: true, botId: 'bot-9' })
        expect(parseItemArgs(['show', '7'])).toMatchObject({ action: 'show', itemRef: 7 })
        expect(parseItemArgs(['done', '7', '--detail', 'landed'])).toMatchObject({ action: 'done', itemRef: 7, detail: 'landed' })
        expect(parseItemArgs(['cancel', '7'])).toMatchObject({ action: 'cancel', itemRef: 7 })
        expect(parseItemArgs(['--help']).help).toBe(true)
    })

    it.each([
        [['set'], /hapi item set <n>/],
        [['ask', '3'], /--question/],
        [['comment', '3'], /comment <n> <text>/],
        [['set', '3'], /at least one/],
        [['set', '3', '--status', 'needs_you'], /needs_you is set by/],
        [['set', '3', '--status', 'bogus'], /--status must be/],
        [['add'], /hapi item add <title>/],
        [['add', 'x', '--status', 'done'], /planned or working/],
        [['show', '3', 'extra'], /unexpected arg/],
        [['list', '3'], /takes no item/],
        [['bogus'], /unknown action/],
        [['done', '3', '--question', 'q'], /only valid with hapi item ask/],
        [['show', '3', '--worker', ''], /takes a session id, or none/],
        [['show', '3', '--snooze-until', ''], /takes a time/],
        [['show', '3', '--snooze-until', 'none'], /only valid with hapi item set/],
        [['ask', '3', '--question', 'q', '--recommended='], /zero-based option index/],
        [['ask', '3', '--question', 'q', '--option='], /requires an option text/],
        [['add', 'x', '--worker', 'none'], /--worker none detaches a worker; a new item has none/],
        [['show', '3', 'extra', 'more'], /unexpected arg/],
        [['list', 'x'], /takes no item/],
        [['show', '3', '--nope'], /unexpected flag/]
    ] as const)('rejects %j', (args, message) => {
        expect(() => parseItemArgs([...args])).toThrow(message)
    })
})

describe('handleItemCommand', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.HAPI_BOT_ID
        delete process.env.HAPI_SESSION_ID
    })

    it('refuses without a bot identity', async () => {
        vi.spyOn(tokenInit, 'initializeToken').mockResolvedValue(undefined)
        await expect(handleItemCommand(['list'])).rejects.toMatchObject({ code: 'bad_args', message: expect.stringMatching(/--bot/) })
    })

    it('takes the bot from HAPI_BOT_ID and the caller from HAPI_SESSION_ID', async () => {
        process.env.HAPI_BOT_ID = 'bot-env'
        process.env.HAPI_SESSION_ID = 'home-1'
        const list = vi.spyOn(itemsModule, 'listItems').mockResolvedValue([])
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleItemCommand(['list'])
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-env', fromSessionId: 'home-1' }))
        expect(log).toHaveBeenCalledWith('No open items.')
    })

    it('creates, asks, comments and marks done through the ledger with --bot', async () => {
        const create = vi.spyOn(itemsModule, 'createItem').mockResolvedValue({ number: 12, status: 'planned', title: 'Ship it', workerSessionId: null, snoozedUntil: null } as never)
        const ask = vi.spyOn(itemsModule, 'askItem').mockResolvedValue({ number: 12, status: 'needs_you', title: 'Ship it', ask: { question: 'When?' }, workerSessionId: null, snoozedUntil: null } as never)
        const update = vi.spyOn(itemsModule, 'updateItem').mockResolvedValue({ number: 12, status: 'done', title: 'Ship it', workerSessionId: null, snoozedUntil: null } as never)
        const comment = vi.spyOn(itemsModule, 'commentItem').mockResolvedValue({ item: null, event: null })
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})

        await handleItemCommand(['add', 'Ship it', '--bot', 'bot-1'])
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-1', body: expect.objectContaining({ title: 'Ship it' }) }))
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Created #12 [planned] Ship it'))

        await handleItemCommand(['ask', '12', '--question', 'When?', '--option', 'now', '--recommended', '0', '--bot', 'bot-1'])
        expect(ask).toHaveBeenCalledWith(expect.objectContaining({
            itemId: 12,
            body: { question: 'When?', options: [{ label: 'now' }], recommended: 0 }
        }))
        expect(log).toHaveBeenCalledWith(expect.stringContaining('End your turn'))

        await handleItemCommand(['comment', '12', 'do it now', '--bot', 'bot-1'])
        expect(comment).toHaveBeenCalledWith(expect.objectContaining({ itemId: 12, body: { text: 'do it now' } }))

        await handleItemCommand(['done', '12', '--bot', 'bot-1'])
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ itemId: 12, body: { status: 'done' } }))
    })

    it('detaches the worker and clears the snooze with none, resolves #N, and shares one auth source across the command', async () => {
        const update = vi.spyOn(itemsModule, 'updateItem').mockResolvedValue({ number: 12, status: 'working', title: 'Ship it', workerSessionId: null, snoozedUntil: null } as never)
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleItemCommand(['set', '#12', '--worker', 'none', '--snooze-until', 'none', '--bot', 'bot-1'])
        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            itemId: 12,
            body: { workerSessionId: null, snoozeUntil: null },
            auth: expect.objectContaining({ get: expect.any(Function) })
        }))

        const full = { id: 'item-a', botId: 'bot-1', sessionId: 'home-1', number: 3, title: 'Fix', status: 'working', detail: '', ask: null, snoozedUntil: null, workerSessionId: null, createdAt: 1, updatedAt: 2 }
        const list = vi.spyOn(itemsModule, 'listItems').mockResolvedValue([full] as never)
        const events = vi.spyOn(itemsModule, 'listItemEvents').mockResolvedValue([] as never)
        await handleItemCommand(['show', '#3', '--bot', 'bot-1'])
        expect(events).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'item-a' }))
        const listAuth = (list.mock.calls[0]![0] as { auth: unknown }).auth
        const eventsAuth = (events.mock.calls[0]![0] as { auth: unknown }).auth
        expect(listAuth).toBe(eventsAuth)
        await expect(handleItemCommand(['show', '#9', '--bot', 'bot-1'])).rejects.toMatchObject({ code: 'not_found', message: 'no item 9' })
    })

    it('a bare date means local midnight (2026-11-28), not UTC', async () => {
        const update = vi.spyOn(itemsModule, 'updateItem').mockResolvedValue({ number: 3, status: 'working', title: 't', workerSessionId: null, snoozedUntil: 1 } as never)
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleItemCommand(['set', '3', '--snooze-until', '2026-11-28', '--bot', 'bot-1'])
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ body: { snoozeUntil: new Date(2026, 10, 28).getTime() } }))
    })

    it('the help carries an Exit codes section', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        expect(handleItemHelpOrUsage(['--help'])).toBe('handled')
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Exit codes:'))
        expect(log).toHaveBeenCalledWith(expect.stringContaining('2 bad arguments or peer tools disabled · 3 auth · 4 no such item'))
    })

    it('fails with bad_args on an unparseable snooze time', async () => {
        await expect(handleItemCommand(['set', '3', '--snooze-until', 'soon', '--bot', 'bot-1'])).rejects.toBeInstanceOf(BotClientError)
    })
})

describe('hapi item help', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('--help prints the help and needs no hub credential', () => {
        const token = vi.spyOn(tokenInit, 'initializeToken')
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        expect(handleItemHelpOrUsage(['--help'])).toBe('handled')
        expect(log).toHaveBeenCalledTimes(1)
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'))
        expect(log).toHaveBeenCalledWith(expect.stringContaining('hapi item list [--all]'))
        expect(token).not.toHaveBeenCalled()
    })

    it('a bare `hapi item` prints the help and fails with the usage line', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        expect(() => handleItemHelpOrUsage([])).toThrow(/missing action; usage: hapi item add\|set/)
        expect(log).toHaveBeenCalledTimes(1)
        expect(() => handleItemHelpOrUsage([])).toThrow(BotClientError)
    })

    it('hands real actions to the runner', () => {
        expect(handleItemHelpOrUsage(['list', '--all'])).toBe('run')
    })
})

describe('hapi item inside a bot session', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env[HAPI_SESSION_ID_ENV]
        delete process.env[HAPI_BOT_ID_ENV]
    })

    it('every write names this session as the actor, so --bot <other> is refused by the hub, not taken as the owner', async () => {
        process.env[HAPI_SESSION_ID_ENV] = 'home-1'
        delete process.env[HAPI_BOT_ID_ENV]
        const create = vi.spyOn(itemsModule, 'createItem').mockResolvedValue({ number: 1, status: 'planned', title: 't', workerSessionId: null, snoozedUntil: null } as never)
        const comment = vi.spyOn(itemsModule, 'commentItem').mockResolvedValue({ item: null, event: null })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleItemCommand(['add', 't', '--bot', 'other-bot'])
        await handleItemCommand(['comment', '1', 'note', '--bot', 'other-bot'])
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ botId: 'other-bot', fromSessionId: 'home-1' }))
        expect(comment).toHaveBeenCalledWith(expect.objectContaining({ botId: 'other-bot', fromSessionId: 'home-1', body: { text: 'note' } }))
    })

    it('a bot session without HAPI_SESSION_ID refuses to write rather than being taken as the owner', async () => {
        delete process.env[HAPI_SESSION_ID_ENV]
        process.env[HAPI_BOT_ID_ENV] = 'bot-1'
        const create = vi.spyOn(itemsModule, 'createItem')
        const update = vi.spyOn(itemsModule, 'updateItem')
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await expect(handleItemCommand(['add', 't'])).rejects.toMatchObject({ code: 'bad_args', message: expect.stringMatching(/would count as the owner's/) })
        await expect(handleItemCommand(['done', '1'])).rejects.toMatchObject({ code: 'bad_args' })
        expect(create).not.toHaveBeenCalled()
        expect(update).not.toHaveBeenCalled()
        // Reads stay open.
        const list = vi.spyOn(itemsModule, 'listItems').mockResolvedValue([])
        await handleItemCommand(['list'])
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-1', fromSessionId: undefined }))
    })
})

import { describe, expect, it } from 'vitest'
import type { BotItem, BotSummary, NeedsYouResponse } from '@hapi/protocol'
import {
    botDisplayStatus,
    botItemEventHead,
    botWorkersSummaryKey,
    buildCreateBotRequest,
    EMPTY_CREATE_BOT_DRAFT,
    isBotItemSnoozed,
    listableBots,
    previewBotHomeDir,
    snoozeOneHourFrom,
    splitBotItems,
    tomorrowNineAm,
    validateBotItemComment,
    validateBotItemTitle,
    type CreateBotDraft
} from './bots'

type NeedsYouEntry = NeedsYouResponse['entries'][number]

function bot(overrides: Partial<BotSummary> = {}): BotSummary {
    return {
        id: 'bot-1',
        name: 'Release manager',
        purpose: '',
        machineId: 'm1',
        homeDir: '~/.hapi/bots/release-manager',
        agent: 'claude',
        model: null,
        permissionMode: 'default',
        homeChatSessionId: 'home-1',
        state: 'active',
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        machineOnline: true,
        homeChatActive: false,
        counts: { needsYou: 0, working: 0, workers: 0 },
        ...overrides
    }
}

function item(number: number, overrides: Partial<BotItem> = {}): BotItem {
    return {
        id: `item-${number}`,
        botId: 'bot-1',
        sessionId: 'home-1',
        number,
        title: `Item ${number}`,
        status: 'working',
        detail: '',
        ask: null,
        snoozedUntil: null,
        workerSessionId: null,
        createdAt: number,
        updatedAt: number,
        ...overrides
    }
}

const question = (itemId: string): NeedsYouEntry => ({
    kind: 'question',
    itemId,
    number: 3,
    title: 'Also Android?',
    ask: { question: 'Also Android?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 0 },
    workerSessionId: null,
    updatedAt: 1
})

const t = (key: string) => key

describe('botDisplayStatus', () => {
    it('maps each state to the one label a row shows', () => {
        expect(botDisplayStatus(bot({ state: 'creating' }))?.key).toBe('creating')
        expect(botDisplayStatus(bot({ state: 'active' }))?.key).toBe('running')
        expect(botDisplayStatus(bot({ state: 'active', machineOnline: false }))?.key).toBe('machineOffline')
        expect(botDisplayStatus(bot({ state: 'paused', machineOnline: false }))?.key).toBe('paused')
        expect(botDisplayStatus(bot({ state: 'failed' }))?.key).toBe('failed')
        expect(botDisplayStatus(bot({ state: 'archived' }))).toBeNull()
    })

    it('keeps archived bots out of the sidebar and lists the rest newest first', () => {
        const listed = listableBots([
            bot({ id: 'old', createdAt: 1 }),
            bot({ id: 'gone', createdAt: 9, state: 'archived' }),
            bot({ id: 'new', createdAt: 5 })
        ])
        expect(listed.map((entry) => entry.id)).toEqual(['new', 'old'])
    })
})

describe('buildCreateBotRequest', () => {
    const draft: CreateBotDraft = {
        ...EMPTY_CREATE_BOT_DRAFT,
        name: '  Release manager ',
        purpose: ' Ship weekly ',
        machineId: 'm1',
        agent: 'claude',
        permissionMode: 'default',
        homeDir: ''
    }

    it('sends the trimmed name and purpose, the machine, agent and permission mode, and no home folder for the default', () => {
        expect(buildCreateBotRequest(draft)).toEqual({
            request: { name: 'Release manager', machineId: 'm1', purpose: 'Ship weekly', agent: 'claude', permissionMode: 'default' }
        })
    })

    it('leaves optional fields out when they are empty', () => {
        expect(buildCreateBotRequest({ ...draft, purpose: '   ', agent: null, permissionMode: null })).toEqual({
            request: { name: 'Release manager', machineId: 'm1' }
        })
    })

    it('passes a custom home folder through', () => {
        expect(buildCreateBotRequest({ ...draft, homeDir: ' ~/bots/rel ' })).toEqual({
            request: { name: 'Release manager', machineId: 'm1', purpose: 'Ship weekly', agent: 'claude', permissionMode: 'default', homeDir: '~/bots/rel' }
        })
    })

    it('refuses a missing name, a too long name, slashes, a missing machine and a too long purpose', () => {
        expect(buildCreateBotRequest({ ...draft, name: '  ' })).toEqual({ error: 'nameRequired' })
        expect(buildCreateBotRequest({ ...draft, name: 'x'.repeat(41) })).toEqual({ error: 'nameTooLong' })
        expect(buildCreateBotRequest({ ...draft, name: 'a/b' })).toEqual({ error: 'nameChars' })
        expect(buildCreateBotRequest({ ...draft, machineId: null })).toEqual({ error: 'machine' })
        expect(buildCreateBotRequest({ ...draft, purpose: 'x'.repeat(501) })).toEqual({ error: 'purposeTooLong' })
    })

    it('refuses a name that cannot name a folder while the default folder is wanted', () => {
        expect(previewBotHomeDir('!!!')).toBeNull()
        expect(buildCreateBotRequest({ ...draft, name: '!!!' })).toEqual({ error: 'nameSlug' })
        // A custom folder makes the same name usable.
        expect(buildCreateBotRequest({ ...draft, name: '!!!', homeDir: '~/bots/x' })).toMatchObject({ request: { name: '!!!', homeDir: '~/bots/x' } })
    })

    it('refuses the home directory itself as the home folder', () => {
        expect(buildCreateBotRequest({ ...draft, homeDir: '~' })).toEqual({ error: 'homeDir' })
        expect(buildCreateBotRequest({ ...draft, homeDir: '~/ ' })).toEqual({ error: 'homeDir' })
    })

    it('previews the default folder from the contract slug', () => {
        expect(previewBotHomeDir('Release  manager')).toBe('~/.hapi/bots/release-manager')
        expect(previewBotHomeDir('发布管家')).toBe('~/.hapi/bots/发布管家')
        expect(previewBotHomeDir('')).toBeNull()
    })
})

describe('splitBotItems', () => {
    it('keeps questions on "Needs you", finishes done and canceled, and orders the rest by number with snoozed last', () => {
        const items = [
            item(1, { status: 'planned' }),
            item(2, { status: 'done' }),
            item(3, { status: 'needs_you', ask: { question: '?' } }),
            item(4, { status: 'working', snoozedUntil: 9_999_999_999_999 }),
            item(5, { status: 'canceled' }),
            item(6, { status: 'waiting' })
        ]
        const { inProgress, done } = splitBotItems(items, [question('item-3')])
        expect(inProgress.map((entry) => entry.number)).toEqual([6, 1, 4])
        expect(done.map((entry) => entry.number)).toEqual([5, 2])
    })

    it('keeps a needs_you item on "In progress" when the feed no longer lists it (a snoozed question)', () => {
        const { inProgress } = splitBotItems([item(3, { status: 'needs_you', snoozedUntil: 9_999_999_999_999 })], [])
        expect(inProgress.map((entry) => entry.number)).toEqual([3])
    })
})

describe('snooze targets', () => {
    it('one hour from now', () => {
        expect(snoozeOneHourFrom(1_000_000)).toBe(1_000_000 + 3_600_000)
    })

    it('"Tomorrow 9:00" is always tomorrow, before and after nine', () => {
        const at = (hour: number, minute: number) => new Date(2026, 10, 27, hour, minute, 0, 0).getTime()
        expect(tomorrowNineAm(at(10, 0))).toBe(new Date(2026, 10, 28, 9, 0, 0, 0).getTime())
        // 08:00 used to mean "in an hour" under the old "next nine" rule, while the button said tomorrow.
        expect(tomorrowNineAm(at(8, 0))).toBe(new Date(2026, 10, 28, 9, 0, 0, 0).getTime())
    })

    it('a snooze in the past has expired', () => {
        expect(isBotItemSnoozed({ snoozedUntil: null }, 1_000)).toBe(false)
        expect(isBotItemSnoozed({ snoozedUntil: 1_500 }, 1_000)).toBe(true)
        expect(isBotItemSnoozed({ snoozedUntil: 1_500 }, 2_000)).toBe(false)
    })
})

describe('item text validation', () => {
    it('title', () => {
        expect(validateBotItemTitle('  ')).toBe('titleRequired')
        expect(validateBotItemTitle('x'.repeat(201))).toBe('titleTooLong')
        expect(validateBotItemTitle(' ok ')).toBeNull()
    })

    it('comment', () => {
        expect(validateBotItemComment('\n')).toBe('commentRequired')
        expect(validateBotItemComment('x'.repeat(4001))).toBe('commentTooLong')
        expect(validateBotItemComment(' yes ')).toBeNull()
    })
})

describe('botItemEventHead', () => {
    const translate = (key: string, params?: Record<string, string | number>) => params
        ? `${key}(${Object.values(params).join('|')})`
        : key

    it('joins actor and verb through the locale template, so Japanese gets no stray space', () => {
        expect(botItemEventHead({ kind: 'ask', actor: 'bot' }, translate))
            .toBe('bots.ledger.eventHead(bots.ledger.actor.bot|bots.ledger.event.ask)')
    })
})

describe('botWorkersSummaryKey', () => {
    it('picks singular and plural for the workers line', () => {
        expect(botWorkersSummaryKey(1, 0)).toBe('bots.ledger.workersSummary.one')
        expect(botWorkersSummaryKey(2, 0)).toBe('bots.ledger.workersSummary.other')
        expect(botWorkersSummaryKey(1, 1)).toBe('bots.ledger.workersSummaryWaiting.one')
        expect(botWorkersSummaryKey(3, 2)).toBe('bots.ledger.workersSummaryWaiting.other')
    })
})

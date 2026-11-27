import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en, ja, ru, zhCN } from '@/lib/locales'
import { formatTaskInterval, formatTaskIntervalCount, intervalToMs } from '@/lib/sessionTasks'

describe('question card locale strings', () => {
    it('localizes tool.waitingForReply in every shipped locale', () => {
        for (const [locale, dict] of [['zh-CN', zhCN], ['ru', ru], ['ja', ja]] as const) {
            expect(dict['tool.waitingForReply'], `${locale} should define the key`).toBeTruthy()
            expect(dict['tool.waitingForReply'], `${locale} should not ship the English copy`).not.toBe(en['tool.waitingForReply'])
        }
    })
})

describe('delete-session attached job copy', () => {
    const english: Record<string, string> = en
    const dictionaries: Array<[string, Record<string, string>]> = [['zh-CN', zhCN], ['ru', ru], ['ja', ja]]
    it.each(['dialog.delete.attachedJob', 'dialog.delete.attachedJobConflict'])(
        'localizes %s in every shipped locale', (key) => {
            expect(english[key], 'en should define the key').toBeTruthy()
            for (const [locale, dict] of dictionaries) {
                expect(dict[key], `${locale} should define the key`).toBeTruthy()
                expect(dict[key], `${locale} should not ship the English copy`).not.toBe(english[key])
            }
        }
    )
})

describe('local-session import copy', () => {
    const english: Record<string, string> = en
    const dictionaries: Array<[string, Record<string, string>]> = [['zh-CN', zhCN], ['ru', ru], ['ja', ja]]

    it('ships every dshSync.* key of the English dictionary in every other locale', () => {
        // The DSH import dialog is generic: a missing key silently falls back
        // to English, so a new flavor's keys have to be added to every locale
        // on purpose — nothing else in the suite would notice a gap.
        const keys = Object.keys(english).filter((key) => key.startsWith('dshSync.'))
        expect(keys.length).toBeGreaterThan(20)
        for (const [locale, dict] of dictionaries) {
            const missing = keys.filter((key) => !(key in dict))
            expect(missing, `${locale} is missing dshSync keys`).toEqual([])
        }
    })

    it.each(['dialog.rename.clearHint'])('localizes %s in every shipped locale', (key) => {
        expect(english[key], 'en should define the key').toBeTruthy()
        for (const [locale, dict] of dictionaries) {
            expect(dict[key], `${locale} should define the key`).toBeTruthy()
        }
    })
})

type Dict = Record<string, string>

function translate(dict: Dict) {
    return (key: string, params?: Record<string, string | number>) => {
        const template = dict[key]
        if (template === undefined) throw new Error(`missing key ${key}`)
        return template.replace(/\{(\w+)\}/g, (_match, name: string) => (params && params[name] !== undefined ? String(params[name]) : `{${name}}`))
    }
}

const locales: [string, Dict][] = [['en', en], ['zh-CN', zhCN], ['ja', ja], ['ru', ru]]

describe('session task strings', () => {
    it('says in the Extended session-list hints setting that it adds the task indicator', () => {
        // Only Extended mode marks a session that has tasks, so the setting's description must name it.
        const repeatIcon: Record<string, string> = { 'zh-CN': '循环图标', ja: '繰り返しアイコン', ru: 'иконка повтора' }
        expect(en['settings.display.sessionListStatus.detailedDescription']).toContain('repeat icon')
        expect(en['settings.display.sessionListStatus.detailedDescription']).toContain('clock icon')
        for (const [locale, dict] of locales.slice(1)) {
            const description = dict['settings.display.sessionListStatus.detailedDescription']
            expect(description, locale).toContain(repeatIcon[locale])
        }
    })

    it('ship every task key in every locale', () => {
        const keys = Object.keys(en).filter((key) => key.startsWith('tasks.') || key.startsWith('composer.task') || key === 'composer.scheduleAndTasks' || key === 'queuedMessages.fromTask' || key === 'queuedMessages.skipTaskPrompt')
        expect(keys.length).toBeGreaterThan(60)
        for (const [locale, dict] of locales) {
            for (const key of keys) {
                expect(dict[key], `${locale} should define ${key}`).toBeTruthy()
            }
        }
    })

    it('count intervals and messages grammatically in every locale', () => {
        for (const [locale, dict] of locales) {
            const t = translate(dict)
            // "Every {interval}" takes the bare unit for one unit, the counted form otherwise.
            const every = (ms: number) => t('tasks.every', { interval: formatTaskInterval(ms, t) })
            expect(every(intervalToMs(10, 'minutes')), locale).not.toMatch(/\b1\b/)
            expect(every(intervalToMs(10, 'minutes')), locale).toMatch(/10/)
            expect(every(intervalToMs(1, 'hours')), locale).toBeTruthy()
            expect(every(intervalToMs(3, 'days')), locale).toMatch(/3/)
            // Inside a sentence the count stays, with the singular for one.
            const count = (ms: number) => formatTaskIntervalCount(ms, t)
            expect(count(intervalToMs(10, 'minutes')), locale).toMatch(/10/)
            expect(count(intervalToMs(1, 'minutes')), locale).toMatch(/(^|\D)1(\D|$)/)
            // Japanese and Russian spell the one-form unit with its numeral, so the counted form must not repeat it.
            for (const unit of ['minutes', 'hours', 'days'] as const) {
                const one = count(intervalToMs(1, unit))
                expect(one, `${locale} ${unit}`).not.toMatch(/1\s+1/)
                expect(one, `${locale} ${unit}`).not.toContain('{unit}')
            }
            if (locale === 'ja') {
                expect(count(intervalToMs(1, 'minutes'))).toBe('1 分')
                expect(count(intervalToMs(1, 'hours'))).toBe('1 時間')
                expect(count(intervalToMs(1, 'days'))).toBe('1 日')
            }
            if (locale === 'ru') {
                expect(count(intervalToMs(1, 'minutes'))).toBe('1 мин')
                expect(count(intervalToMs(1, 'hours'))).toBe('1 ч')
                expect(count(intervalToMs(1, 'days'))).toBe('1 дн')
            }
            // Plural messages and tasks.
            expect(t('composer.taskQueueCount', { count: 2 }), locale).toMatch(/2/)
            expect(t('tasks.count', { count: 3 }), locale).toMatch(/3/)
            expect(t('tasks.countOne'), locale).not.toMatch(/\{count\}/)
            // English is the one that inflects.
            if (locale === 'en') {
                expect(every(intervalToMs(1, 'minutes'))).toBe('Every minute')
                expect(every(intervalToMs(1, 'days'))).toBe('Every day')
                expect(every(intervalToMs(10, 'minutes'))).toBe('Every 10 minutes')
                expect(count(intervalToMs(1, 'minutes'))).toBe('1 minute')
                expect(t('composer.taskQueueCountOne')).toBe('1 message, sent in this order')
                expect(t('tasks.countOne')).toBe('1 task')
                expect(t('composer.taskQueueCount', { count: 1 })).toBe('1 messages, sent in this order')
            }
        }
    })

    it('gives the Russian run limit no numeral phrase, since the numeral sits in the input', () => {
        expect(ru['composer.taskStopAfter']).toBe('Количество запусков')
        expect(ru['composer.taskStopAfterHint']).not.toMatch(/\bраз/)
        expect(ru['composer.taskStopAfterHint']).toBe('Оставьте пустым, чтобы повторять до остановки.')
    })

    it('gives every reason the hub records its own sentence, not the old "the task is paused" claim', () => {
        for (const [locale, dict] of locales.slice(1)) {
            expect(dict['tasks.sessionUnavailable'], locale).not.toBe(en['tasks.sessionUnavailable'])
            expect(dict['tasks.promptIndeterminate'], locale).not.toBe(dict['tasks.promptNotTaken'])
        }
        expect(en['tasks.sessionUnavailable']).toBe('The session cannot be resumed right now; retrying')
        expect(en['tasks.sessionUnavailable']).not.toContain('paused')
    })

    it('gives a failed run in the history its own reason in every locale, apart from the sentence of a task still held up', () => {
        const live: Record<string, string> = {
            machine_offline: 'tasks.waitingForMachine',
            session_unavailable: 'tasks.sessionUnavailable',
            session_archived: 'tasks.sessionArchived',
            send_failed: 'tasks.sendFailed'
        }
        expect(en['tasks.run.failedReason.machine_offline']).toBe('the machine was offline')
        expect(en['tasks.run.failedReason.session_unavailable']).toBe('the session could not be resumed')
        expect(en['tasks.run.failedReason.session_archived']).toBe('the session was archived')
        expect(en['tasks.run.failedReason.send_failed']).toBe('the send failed')
        // A noun phrase after "Failed:", never the live "…; retrying" / "Sends once …" sentence.
        for (const [locale, dict] of locales) {
            for (const [code, liveKey] of Object.entries(live)) {
                const reason = dict[`tasks.run.failedReason.${code}`]
                expect(reason, `${locale} ${code}`).toBeTruthy()
                expect(reason, `${locale} ${code}`).not.toBe(dict[liveKey])
            }
        }
        for (const [locale, dict] of locales.slice(1)) {
            expect(dict['tasks.run.failedReason.machine_offline'], locale).not.toBe(en['tasks.run.failedReason.machine_offline'])
        }
    })

    it('says of a delete, a kept prompt and an unconfirmed cancel what became of them, in every locale', () => {
        // Every delete speaks: deleted and done, the waiting prompt pulled back, the agent got there first, or the prompt still queued.
        const marks: Record<string, Record<string, string>> = {
            'zh-CN': { deleted: '已删除', pulledBack: '已撤回', paused: '暂停', kept: '仍会发送', taken: '接走', unconfirmed: '尚未确认', unconfirmedToast: '未能确认' },
            ja: { deleted: '削除', pulledBack: '取り下げ', paused: '一時停止', kept: '送信されます', taken: '取り込', unconfirmed: '未確認', unconfirmedToast: '確認できませんでした' },
            ru: { deleted: 'удалена', pulledBack: 'отозвано', paused: 'Приостановлено', kept: 'будет отправлено', taken: 'принял', unconfirmed: 'не подтверждена', unconfirmedToast: 'подтвердить не удалось' }
        }
        for (const [locale, dict] of locales) {
            expect(dict['tasks.deleted'], locale).not.toBe(dict['tasks.deletedPromptCancelled'])
            expect(dict['tasks.deletePromptTaken'], locale).not.toBe(dict['tasks.deleteUnconfirmed'])
            if (locale === 'en') continue
            const mark = marks[locale]
            expect(dict['tasks.deleted'], locale).toContain(mark.deleted)
            expect(dict['tasks.deletedPromptCancelled'], locale).toContain(mark.deleted)
            expect(dict['tasks.deletedPromptCancelled'], locale).toContain(mark.pulledBack)
            expect(dict['tasks.pausedPromptKept'], locale).toContain(mark.paused)
            expect(dict['tasks.pausedPromptKept'], locale).toContain(mark.kept)
            expect(dict['tasks.deletePromptTaken'], locale).toContain(mark.taken)
            expect(dict['tasks.deleteUnconfirmed'], locale).toContain(mark.unconfirmedToast)
            expect(dict['tasks.cancelUnconfirmed'], locale).toContain(mark.unconfirmed)
            for (const key of ['tasks.deleted', 'tasks.deletedPromptCancelled', 'tasks.pausedPromptKept', 'tasks.cancelUnconfirmed'] as const) {
                expect(dict[key], `${locale} ${key}`).not.toBe(en[key])
            }
        }
    })
})
describe('bot copy', () => {
    const english: Record<string, string> = en
    const dictionaries: Array<[string, Record<string, string>]> = [['zh-CN', zhCN], ['ru', ru], ['ja', ja]]
    const isBotKey = (key: string) => key.startsWith('bots.') || key.startsWith('settings.general.peerToolsBotsOnly')
    const botKeys = Object.keys(english).filter(isBotKey)
    // A value that is only placeholders and punctuation is language-neutral; identical copies are fine.
    const hasLetters = (value: string) => /\p{L}/u.test(value.replace(/\{[^}]*\}/g, ''))

    it('ships every bots.* key in every shipped locale, translated rather than copied', () => {
        expect(botKeys.length).toBeGreaterThan(100)
        for (const [locale, dict] of dictionaries) {
            expect(botKeys.filter((key) => !(key in dict)), `${locale} is missing bot keys`).toEqual([])
            expect(botKeys.filter((key) => dict[key] === english[key] && hasLetters(english[key])), `${locale} ships English copy`).toEqual([])
        }
    })

    it('carries exactly the same bots.* keys in all four locales', () => {
        for (const [locale, dict] of dictionaries) {
            const extra = Object.keys(dict).filter((key) => isBotKey(key) && !(key in english))
            expect(extra, `${locale} has bot keys en does not`).toEqual([])
        }
    })

    it('names every item event kind, actor, status, worker state and bot state the code can ask for', () => {
        for (const kind of ['created', 'status', 'comment', 'ask', 'answered', 'linked', 'unlinked', 'updated']) {
            expect(english[`bots.ledger.event.${kind}`], `en should describe the ${kind} event`).toBeTruthy()
        }
        for (const actor of ['bot', 'user', 'system']) {
            expect(english[`bots.ledger.actor.${actor}`], `en should name the ${actor} actor`).toBeTruthy()
        }
        for (const status of ['planned', 'working', 'waiting', 'needs_you', 'done', 'canceled']) {
            expect(english[`bots.ledger.itemStatus.${status}`], `en should name the ${status} status`).toBeTruthy()
        }
        for (const activity of ['busy', 'idle', 'stopped']) {
            expect(english[`bots.ledger.worker.${activity}`], `en should name the ${activity} worker`).toBeTruthy()
        }
        for (const state of ['creating', 'running', 'paused', 'failed', 'machineOffline']) {
            expect(english[`bots.status.${state}`], `en should name the ${state} state`).toBeTruthy()
        }
        for (const tab of ['needsYou', 'inProgress', 'done']) {
            expect(english[`bots.ledger.tab.${tab}`], `en should name the ${tab} tab`).toBeTruthy()
        }
    })

    it('has a translation for every bots.* key the source asks for (a missing one shows as the key itself)', () => {
        const used = new Set<string>()
        for (const file of sourceFiles(SRC)) {
            const text = readFileSync(file, 'utf8')
            for (const match of text.matchAll(/\bt\(\s*'((?:bots|settings\.general\.peerToolsBotsOnly)[A-Za-z0-9_.]*)'/g)) {
                used.add(match[1])
            }
        }
        expect(used.size).toBeGreaterThan(80)
        expect([...used].filter((key) => !(key in english)), 'keys used in source but missing from en').toEqual([])
    })
})

// import.meta.url is not a file: URL under vitest's jsdom environment; the suite runs from web/.
const SRC = resolve(process.cwd(), 'src')

function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
            out.push(...sourceFiles(path))
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
            out.push(path)
        }
    }
    return out
}

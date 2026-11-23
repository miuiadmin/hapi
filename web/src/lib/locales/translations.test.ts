import { describe, expect, it } from 'vitest'
import { en, ja, ru, zhCN } from '@/lib/locales'

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

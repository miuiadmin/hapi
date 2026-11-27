import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tokenInit from '@/ui/tokenInit'
import * as peerAnswerModule from '@/modules/bot/peerAnswer'
import { BotClientError } from '@/modules/bot/botClient'
import { handlePeerAnswerCommand, handlePeerAnswerHelpOrUsage, parsePeerAnswerArgs } from './peerAnswer'

describe('parsePeerAnswerArgs', () => {
    const bare = { help: false, options: [], answers: [], approve: false, deny: false, sessionIdPrefix: 'abc123', requestId: 'req-1' }

    it('parses a permission decision only as --approve / --deny', () => {
        expect(parsePeerAnswerArgs(['abc123', 'req-1', '--approve'])).toEqual({ ...bare, approve: true })
        expect(parsePeerAnswerArgs(['abc123', 'req-1', '--deny'])).toEqual({ ...bare, deny: true })
        expect(() => parsePeerAnswerArgs(['abc123', 'req-1'])).toThrow(/pass --approve or --deny/)
    })

    it('parses the single-question form: --option by text or 1-based number, --text, --question from 1', () => {
        expect(parsePeerAnswerArgs(['abc123', 'req-1', '--option', '2', '--option', 'custom text', '--text', 'note']))
            .toEqual({ ...bare, options: ['2', 'custom text'], text: 'note' })
        expect(parsePeerAnswerArgs(['abc123', 'req-1', '--question=2', '--option=main']))
            .toEqual({ ...bare, question: 2, options: ['main'] })
        expect(() => parsePeerAnswerArgs(['abc123', 'req-1', '--question', '0', '--option', 'main'])).toThrow(/question number from 1/)
    })

    it('parses the multi-question form and everything after -- as positionals', () => {
        expect(parsePeerAnswerArgs(['abc123', 'req-1', '--answer', '1=main', '--answer=2=Team']))
            .toEqual({ ...bare, answers: ['1=main', '2=Team'] })
        expect(parsePeerAnswerArgs(['abc123', '--deny', '--', '-req-9'])).toEqual({ ...bare, requestId: '-req-9', deny: true })
        expect(parsePeerAnswerArgs(['--help']).help).toBe(true)
    })

    it.each([
        [['abc'], /usage: hapi peer-answer/],
        [['abc', 'req'], /pass --approve or --deny/],
        [['abc', 'req', '--approve', '--deny'], /not both/],
        [['abc', 'req', '--approve', '--option', 'x'], /--approve is for permission requests/],
        [['abc', 'req', 'extra'], /unexpected arg/],
        [['abc', 'req', '--option'], /requires (a value|an option)/],
        [['abc', 'req', '--option='], /requires an option/],
        [['abc', 'req', '--text='], /requires a text/],
        [['abc', 'req', '--answer='], /requires <n>=/],
        [['abc', 'req', '--reason', 'x'], /unexpected flag/],
        [['abc', 'req', '--nope'], /unexpected flag/]
    ] as const)('rejects %j', (args, message) => {
        expect(() => parsePeerAnswerArgs([...args])).toThrow(message)
    })
})

describe('handlePeerAnswerCommand', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('forwards the parsed decision to answerRequest and prints the summary', async () => {
        vi.spyOn(tokenInit, 'initializeToken').mockResolvedValue(undefined)
        const answer = vi.spyOn(peerAnswerModule, 'answerRequest').mockResolvedValue({
            sessionId: 'sess-full', requestId: 'req-1', tool: 'Bash',
            plan: { approve: false, body: {}, summary: 'denied Bash' }
        })
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await handlePeerAnswerCommand(['sess', 'req-1', '--deny'])
        const call = answer.mock.calls[0]![0]
        expect(call).toMatchObject({
            sessionIdPrefix: 'sess',
            requestId: 'req-1',
            input: { approve: false, deny: true, options: [], text: undefined, question: undefined, answers: [] }
        })
        expect(call.auth).toBeDefined()
        expect(log).toHaveBeenCalledWith(expect.stringContaining('denied Bash'))
    })

    it('prints help and fails when the request id is missing; --help alone needs no credential', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const token = vi.spyOn(tokenInit, 'initializeToken')
        await expect(handlePeerAnswerCommand(['abc'])).rejects.toBeInstanceOf(BotClientError)
        // The command entry point shows the help with a usage slip.
        expect(() => handlePeerAnswerHelpOrUsage(['abc'])).toThrow(/usage: hapi peer-answer/)
        expect(log).toHaveBeenCalledWith(expect.stringContaining('hapi peer-answer <sessionIdPrefix> <requestId>'))
        expect(handlePeerAnswerHelpOrUsage(['--help'])).toBe('handled')
        expect(log).toHaveBeenCalledWith(expect.stringContaining('--answer <n>=<text|n>'))
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Exit codes:'))
        expect(token).not.toHaveBeenCalled()
    })
})

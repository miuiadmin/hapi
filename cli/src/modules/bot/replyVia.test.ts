import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureParentStamp, extractParentSessionIdFromRemit, parentSectionHasSessionChip } from '@hapi/protocol/peerParentStamp'
import {
    appendWorkerContract,
    assertTaskSessionAllowed,
    botIdFromEnv,
    countCodeFences,
    formatWorkerContract,
    isBotSession,
    parseReplyVia,
    resolveBotId,
    requireWriteFromSessionId,
    resolveReplyVia,
    settlePeerReply,
    workerContractIdentityFromEnv
} from './replyVia'
import { BotClientError } from './botClient'
import { HAPI_BOT_ID_ENV, HAPI_BOT_NAME_ENV, HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'

/** What registerReceipt throws when the hub answers 404 (older hub, route missing). */
const rejected = (status: number, detail = `HTTP ${status}`) => new BotClientError(
    status === 403 ? 'forbidden' : status === 401 ? 'auth_failed' : 'request_failed',
    `register reply receipt failed: ${detail}`,
    status
)
/** What a timeout / socket error looks like: no status at all. */
const unknownOutcome = () => new BotClientError('request_failed', 'register reply receipt failed: timeout of 15000ms exceeded')

describe('bot identity', () => {
    afterEach(() => {
        delete process.env[HAPI_BOT_ID_ENV]
        delete process.env[HAPI_BOT_NAME_ENV]
    })

    it('reads the bot from the session env and lets an explicit id win', () => {
        expect(isBotSession(undefined, {})).toBe(false)
        process.env[HAPI_BOT_ID_ENV] = 'bot-env'
        expect(botIdFromEnv()).toBe('bot-env')
        expect(isBotSession(undefined)).toBe(true)
        expect(isBotSession('bot-mcp')).toBe(true)
        expect(resolveBotId(' bot-x ')).toBe('bot-x')
        expect(resolveBotId(undefined)).toBe('bot-env')
        process.env[HAPI_BOT_NAME_ENV] = 'Ops'
        expect(workerContractIdentityFromEnv()).toEqual({ botId: 'bot-env', botName: 'Ops' })
    })

    it('a ledger write names the bot session, and inside a bot session that is mandatory', () => {
        expect(requireWriteFromSessionId({ [HAPI_SESSION_ID_ENV]: ' s1 ' })).toBe('s1')
        expect(requireWriteFromSessionId({})).toBeUndefined()
        expect(requireWriteFromSessionId({ [HAPI_SESSION_ID_ENV]: 's1', [HAPI_BOT_ID_ENV]: 'b' })).toBe('s1')
        expect(() => requireWriteFromSessionId({ [HAPI_BOT_ID_ENV]: 'b' })).toThrow(BotClientError)
        try {
            requireWriteFromSessionId({ [HAPI_BOT_ID_ENV]: 'b' })
        } catch (error) {
            expect((error as BotClientError).code).toBe('bad_args')
            expect((error as Error).message).toMatch(/would count as the owner's/)
        }
    })

    it('a bot may only schedule its own home chat; everyone else may name any session', () => {
        const bot = { [HAPI_BOT_ID_ENV]: 'b', [HAPI_SESSION_ID_ENV]: 'home-1' }
        expect(() => assertTaskSessionAllowed(undefined, bot)).not.toThrow()
        expect(() => assertTaskSessionAllowed('home-1', bot)).not.toThrow()
        expect(() => assertTaskSessionAllowed('other', bot)).toThrow(/a bot schedules only itself/)
        try {
            assertTaskSessionAllowed('other', bot)
        } catch (error) {
            expect((error as BotClientError).code).toBe('forbidden')
        }
        expect(() => assertTaskSessionAllowed('other', { [HAPI_SESSION_ID_ENV]: 'home-1' })).not.toThrow()
        expect(() => assertTaskSessionAllowed('other', {})).not.toThrow()
    })

    it('parses --receipt values', () => {
        expect(parseReplyVia('hub')).toBe('hub')
        expect(parseReplyVia(' CALLER ')).toBe('caller')
        expect(parseReplyVia(undefined)).toBeUndefined()
        expect(() => parseReplyVia('later')).toThrow(/hub or caller/)
    })
})

describe('resolveReplyVia', () => {
    const noBot = {}
    const bot = { [HAPI_BOT_ID_ENV]: 'bot-1' }

    it('gives an explicit replyVia precedence over waitForReply', () => {
        expect(resolveReplyVia({ replyVia: 'hub', waitForReply: true, env: noBot })).toBe('hub')
        expect(resolveReplyVia({ replyVia: 'caller', waitForReply: false, env: noBot })).toBe('caller')
    })

    it('maps waitForReply to the caller watch and leaves other sessions unchanged', () => {
        expect(resolveReplyVia({ waitForReply: true, env: noBot })).toBe('caller')
        expect(resolveReplyVia({ env: noBot })).toBeUndefined()
    })

    it('defaults a bot home chat to the hub receipt', () => {
        expect(resolveReplyVia({ env: bot })).toBe('hub')
        expect(resolveReplyVia({ botId: 'bot-mcp', env: noBot })).toBe('hub')
    })
})

describe('settlePeerReply', () => {
    function harness(overrides: Partial<Parameters<typeof settlePeerReply>[0]> = {}) {
        const forward = vi.fn(async () => {})
        const registerReceipt = vi.fn(async () => ({ id: 'r1' }))
        return {
            forward,
            registerReceipt,
            base: {
                via: 'hub' as const,
                task: { sessionId: 'child-1', localId: 'ping-peer-1', flavor: 'hermes' },
                callerSessionId: 'home-1',
                onHubFailure: 'forward' as const,
                flavorSupported: false,
                forward,
                registerReceipt,
                ...overrides
            }
        }
    }

    it("replyVia 'hub' registers a receipt and does not forward in-process, for any flavor", async () => {
        const h = harness()
        const result = await settlePeerReply(h.base)
        expect(h.registerReceipt).toHaveBeenCalledWith('child-1', { parentSessionId: 'home-1', taskLocalId: 'ping-peer-1', kind: 'turn_end' })
        expect(h.forward).not.toHaveBeenCalled()
        expect(result).toEqual({ mode: 'hub', forwarded: false, note: '; the hub will post its reply here when its turn ends' })
    })

    it('falls back to the caller watch only when the hub definitely refused, and the caller can keep one (MCP)', async () => {
        const register = vi.fn(async () => { throw rejected(404) })
        const h = harness({ flavorSupported: true, registerReceipt: register })
        const result = await settlePeerReply(h.base)
        expect(register).toHaveBeenCalledTimes(1)
        expect(h.forward).toHaveBeenCalledWith({ peerSessionId: 'child-1', taskLocalId: 'ping-peer-1', callerSessionId: 'home-1' })
        expect(result.mode).toBe('caller')
        expect(result.note).toBe('; hub receipt registration failed (register reply receipt failed: HTTP 404) — falling back to this session\'s hapi process: its reply will be posted here')
    })

    it('explains instead of watching when the hub refused and the caller cannot keep a watch (shell)', async () => {
        const register = vi.fn(async () => { throw rejected(404) })
        const h = harness({ onHubFailure: 'report', registerReceipt: register })
        const result = await settlePeerReply(h.base)
        expect(register).toHaveBeenCalledTimes(1)
        expect(h.forward).not.toHaveBeenCalled()
        expect(result.mode).toBe('unavailable')
        expect(result.note).toBe('; hub receipt registration failed (register reply receipt failed: HTTP 404), so the reply will NOT be posted back — check the peer later with inspect_peer')

        const unsupported = harness({ onHubFailure: 'forward', registerReceipt: vi.fn(async () => { throw rejected(403, 'not the home chat') }) })
        const r = await settlePeerReply(unsupported.base)
        expect(r.mode).toBe('unsupported')
        expect(r.note).toBe('; hub receipt registration failed (register reply receipt failed: not the home chat) — falling back to this session\'s hapi process: hermes peers do not report turn ends, so check the reply with inspect_peer')
    })

    it('an unknown outcome (timeout / network / 5xx) is retried once and, when the retry lands, nobody watches from here', async () => {
        let attempts = 0
        const register = vi.fn(async () => { attempts += 1; if (attempts === 1) throw unknownOutcome(); return { id: 'r1' } })
        const h = harness({ flavorSupported: true, registerReceipt: register })
        const result = await settlePeerReply(h.base)
        expect(register).toHaveBeenCalledTimes(2)
        expect(register).toHaveBeenLastCalledWith('child-1', { parentSessionId: 'home-1', taskLocalId: 'ping-peer-1', kind: 'turn_end' })
        expect(h.forward).not.toHaveBeenCalled()
        expect(result).toEqual({ mode: 'hub', forwarded: false, note: '; the hub will post its reply here when its turn ends (registration retried once)' })
    })

    it('an unknown outcome after the retry is reported as such — never a second delivery path', async () => {
        for (const onHubFailure of ['forward', 'report'] as const) {
            for (const failure of [unknownOutcome(), new BotClientError('request_failed', 'register reply receipt failed: HTTP 503', 503), new Error('socket hang up')]) {
                const register = vi.fn(async () => { throw failure })
                const h = harness({ onHubFailure, flavorSupported: true, registerReceipt: register })
                const result = await settlePeerReply(h.base)
                expect(register, failure.message).toHaveBeenCalledTimes(2)
                expect(h.forward, `${onHubFailure} ${failure.message}`).not.toHaveBeenCalled()
                expect(result.mode).toBe('unavailable')
                expect(result.note, failure.message).toMatch(/^; receipt registration outcome unknown \(/)
                expect(result.note).toContain('may or may not be posted back')
                expect(result.note).toContain('inspect_peer')
            }
        }
    })

    it('a refusal on the retry falls back like a first-answer refusal', async () => {
        let attempts = 0
        const register = vi.fn(async () => { attempts += 1; if (attempts === 1) throw unknownOutcome(); throw rejected(404) })
        const h = harness({ flavorSupported: true, registerReceipt: register })
        const result = await settlePeerReply(h.base)
        expect(register).toHaveBeenCalledTimes(2)
        expect(result.mode).toBe('caller')
    })

    it("replyVia 'caller' forwards only for supported flavors", async () => {
        const ok = harness({ via: 'caller', flavorSupported: true })
        expect(await settlePeerReply(ok.base)).toEqual({ mode: 'caller', forwarded: true, note: '; its reply will be posted here' })
        expect(ok.forward).toHaveBeenCalledTimes(1)

        const nope = harness({ via: 'caller', flavorSupported: false, task: { sessionId: 'c', localId: 'l', flavor: 'pi' } })
        const r = await settlePeerReply(nope.base)
        expect(r.mode).toBe('unsupported')
        expect(r.note).toBe('; pi peers do not report turn ends, so check the reply with inspect_peer')
        expect(nope.forward).not.toHaveBeenCalled()
    })

    it('refuses when the task has no localId or the calling session is unknown', async () => {
        expect((await settlePeerReply(harness({ task: { sessionId: 'c', localId: undefined, flavor: 'claude' } }).base)).note)
            .toContain('could not be identified')
        const r = await settlePeerReply(harness({ callerSessionId: '' }).base)
        expect(r.mode).toBe('unavailable')
        expect(r.note).toContain('calling session id is unknown')
    })
})

describe('worker contract', () => {
    const identity = { botId: 'bot-1', botName: 'Ops' }

    it('names the bot and asks for a report and for caution', () => {
        const text = formatWorkerContract(identity)
        expect(text).toContain('## Worker contract')
        expect(text).toContain('the HAPI bot "Ops" (id bot-1)')
        expect(text).toContain('final message')
        expect(text).toContain('force-pushing')
        expect(text).toContain('ask with your ask-user tool')
        expect(formatWorkerContract({ botId: 'bot-2', botName: null })).toContain('HAPI bot bot-2')
    })

    it('counts code fences and closes an open block before the contract so it is not swallowed', () => {
        expect(countCodeFences('plain')).toBe(0)
        expect(countCodeFences('```js\nx\n```')).toBe(2)
        expect(countCodeFences('~~~\nx\n~~~')).toBe(2)
        expect(countCodeFences('  ```\nx')).toBe(1)
        const open = 'Fix this.\n```ts\nconst unfinished = '
        const delivered = appendWorkerContract(open, identity)
        expect(delivered).toBe(`${open.trimEnd()}\n\x60\x60\x60\n\n${formatWorkerContract(identity)}`)
        expect(countCodeFences(delivered) % 2).toBe(0)
        const closed = 'Fix this.\n```ts\nconst done = 1\n```'
        expect(appendWorkerContract(closed, identity)).toBe(`${closed}\n\n${formatWorkerContract(identity)}`)
    })

    it('is appended after the remit without disturbing the Parent stamp or its extraction', () => {
        const parent = { sessionId: '4bd4d2b9-e114-4e03-af4c-03e9e4f7439e', name: 'Ops' }
        const stamped = ensureParentStamp('Fix the login tests', parent, { requireParent: true }).message
        const delivered = appendWorkerContract(stamped, identity)

        expect(delivered.startsWith('## Parent')).toBe(true)
        expect(parentSectionHasSessionChip(delivered, parent.sessionId)).toBe(true)
        expect(extractParentSessionIdFromRemit(delivered)).toBe(parent.sessionId)
        expect(delivered.indexOf('Fix the login tests')).toBeLessThan(delivered.indexOf('## Worker contract'))
        // The first 800 characters (what spawn verifies) are the stamp plus the remit.
        expect(delivered.slice(0, stamped.length)).toBe(stamped)
        // Idempotent re-stamp still recognizes the chip.
        expect(ensureParentStamp(delivered, parent).stamped).toBe(false)
    })
})

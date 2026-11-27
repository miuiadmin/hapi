import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as peerMessages from '@/modules/pingPeer/pingPeer'
import * as peerSpawn from '@/modules/spawnPeer/spawnPeer'
import * as receipts from '@/modules/bot/receipts'
import * as itemsModule from '@/modules/bot/items'
import * as tokenInit from '@/ui/tokenInit'
import { PingPeerError } from '@/modules/pingPeer/pingPeer'
import { SpawnPeerError } from '@/modules/spawnPeer/spawnPeer'
import { BotClientError } from '@/modules/bot/botClient'
import { HAPI_BOT_ID_ENV, HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { assertReceiptFeasible, handlePingPeerCommand, parsePingPeerArgs, settleReceipt } from './pingPeer'
import { handleSpawnPeerCommand, parseSpawnPeerArgs } from './spawnPeer'

const CHILD = 'child-1111-1111-1111-111111111111'
const pinged = { sessionId: CHILD, name: 'Worker', resumed: false, localId: 'ping-peer-abc', delivery: 'accepted' as const, flavor: 'hermes' as const }
const spawned = { sessionId: CHILD, name: 'Worker', localId: 'ping-peer-abc', flavor: 'hermes' as const }

describe('--receipt parsing', () => {
    afterEach(() => {
        delete process.env[HAPI_BOT_ID_ENV]
    })

    it('is absent unless given, in both flag forms, and validates its value', () => {
        expect(parsePingPeerArgs(['abc', 'hello'])).not.toHaveProperty('receipt')
        expect(parsePingPeerArgs(['abc', 'hello', '--receipt', 'hub']).receipt).toBe('hub')
        expect(parsePingPeerArgs(['abc', 'hello', '--receipt=caller']).receipt).toBe('caller')
        expect(() => parsePingPeerArgs(['abc', 'hello', '--receipt', 'later'])).toThrow(PingPeerError)
        expect(() => parsePingPeerArgs(['abc', 'hello', '--receipt'])).toThrow(PingPeerError)
        expect(() => parsePingPeerArgs(['abc', 'hello', '--receipt', 'hub', '--receipt', 'caller'])).toThrow(/once/)

        expect(parseSpawnPeerArgs(['--dir', '/tmp', '--name', 'W', 'msg'])).not.toHaveProperty('receipt')
        expect(parseSpawnPeerArgs(['--dir', '/tmp', '--name', 'W', 'msg', '--receipt=hub']).receipt).toBe('hub')
        expect(() => parseSpawnPeerArgs(['--dir', '/tmp', '--name', 'W', 'msg', '--receipt', 'x'])).toThrow(SpawnPeerError)
    })

    it('parses --item and --bot for spawn-peer, and refuses --item without a bot', () => {
        delete process.env[HAPI_BOT_ID_ENV]
        const parsed = parseSpawnPeerArgs(['--dir', '/tmp', '--name', 'W', 'msg', '--item', '12', '--bot', 'bot-1'])
        expect(parsed.item).toBe(12)
        expect(parsed.bot).toBe('bot-1')
        expect(parseSpawnPeerArgs(['--dir', '/tmp', '--name', 'W', 'msg', '--item=item-abc', '--bot', 'bot-1']).item).toBe('item-abc')
        expect(() => parseSpawnPeerArgs(['--dir', '/tmp', '--name', 'W', 'msg', '--item', '12'])).toThrow(/needs a bot/)
        process.env[HAPI_BOT_ID_ENV] = 'bot-env'
        expect(parseSpawnPeerArgs(['--dir', '/tmp', '--name', 'W', 'msg', '--item', '12']).item).toBe(12)
        expect(() => parseSpawnPeerArgs(['--dir', '/tmp', '--name', 'W', 'msg', '--item'])).toThrow(/requires an item/)
    })
})

describe('assertReceiptFeasible', () => {
    afterEach(() => { delete process.env[HAPI_SESSION_ID_ENV] })

    it('refuses an explicit receipt outside a session and lets the default through', () => {
        delete process.env[HAPI_SESSION_ID_ENV]
        expect(() => assertReceiptFeasible('hub')).toThrow(/HAPI_SESSION_ID/)
        expect(() => assertReceiptFeasible(undefined)).not.toThrow()
        process.env[HAPI_SESSION_ID_ENV] = 'home-1'
        expect(() => assertReceiptFeasible('caller')).not.toThrow()
    })
})

describe('settleReceipt (shell path)', () => {
    beforeEach(() => {
        process.env[HAPI_SESSION_ID_ENV] = 'home-1'
    })

    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env[HAPI_BOT_ID_ENV]
        delete process.env[HAPI_SESSION_ID_ENV]
    })

    it('does nothing outside a bot session without --receipt', async () => {
        const register = vi.spyOn(receipts, 'registerReceipt')
        expect(await settleReceipt({ explicit: undefined, task: pinged, command: 'hapi x' })).toBe('')
        expect(register).not.toHaveBeenCalled()
    })

    it('registers a hub receipt by default in a bot session, for any flavor', async () => {
        process.env[HAPI_BOT_ID_ENV] = 'bot-1'
        const register = vi.spyOn(receipts, 'registerReceipt').mockResolvedValue({ id: 'r1' } as never)
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply')
        const note = await settleReceipt({ explicit: undefined, task: pinged, command: 'hapi x' })
        expect(register).toHaveBeenCalledWith(CHILD, { parentSessionId: 'home-1', taskLocalId: 'ping-peer-abc', kind: 'turn_end' })
        expect(forward).not.toHaveBeenCalled()
        expect(note).toBe('; the hub will post its reply here when its turn ends')
    })

    it('explains instead of blocking when the hub refuses the receipt, even for an explicit --receipt hub', async () => {
        vi.spyOn(receipts, 'registerReceipt').mockRejectedValue(new BotClientError('request_failed', 'register reply receipt failed: HTTP 404', 404))
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply')
        const note = await settleReceipt({ explicit: 'hub', task: pinged, command: 'hapi x' })
        expect(forward).not.toHaveBeenCalled()
        expect(note).toContain('hub receipt registration failed (register reply receipt failed: HTTP 404)')
        expect(note).toContain('inspect_peer')
    })

    it('blocks on the in-process watch for an explicit --receipt caller', async () => {
        const register = vi.spyOn(receipts, 'registerReceipt')
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue(undefined)
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const note = await settleReceipt({ explicit: 'caller', task: { ...pinged, flavor: 'codex' }, command: 'hapi x' })
        expect(register).not.toHaveBeenCalled()
        expect(forward).toHaveBeenCalledWith({ peerSessionId: CHILD, taskLocalId: 'ping-peer-abc', callerSessionId: 'home-1' })
        expect(log).toHaveBeenCalledWith(expect.stringContaining("waiting for the peer's turn to end"))
        expect(note).toBe('; its reply will be posted here')
    })

    it('an unknown outcome is retried once and then reported; the shared auth reaches the registration', async () => {
        const register = vi.spyOn(receipts, 'registerReceipt')
            .mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'))
            .mockResolvedValueOnce({ id: 'r1' } as never)
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply')
        const auth = { get: vi.fn(async () => ({ apiUrl: 'http://hub.test', jwt: 'jwt', http: {} as never })) }
        const note = await settleReceipt({ explicit: 'hub', task: pinged, command: 'hapi x', auth })
        expect(register).toHaveBeenCalledTimes(2)
        expect(register).toHaveBeenLastCalledWith(CHILD, expect.objectContaining({ parentSessionId: 'home-1', auth }))
        expect(forward).not.toHaveBeenCalled()
        expect(note).toContain('(registration retried once)')
    })

    it('ping-peer prints the receipt note after the delivery line and refuses --receipt outside a session', async () => {
        process.env[HAPI_BOT_ID_ENV] = 'bot-1'
        vi.spyOn(tokenInit, 'initializeToken').mockResolvedValue(undefined)
        vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue(pinged)
        vi.spyOn(receipts, 'registerReceipt').mockResolvedValue({ id: 'r1' } as never)
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await handlePingPeerCommand([CHILD, 'hello'])
        expect(log).toHaveBeenCalledTimes(1)
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/OK - accepted for .*; the hub will post its reply here when its turn ends/))

        delete process.env[HAPI_SESSION_ID_ENV]
        await expect(handlePingPeerCommand([CHILD, 'hello', '--receipt', 'hub'])).rejects.toMatchObject({ code: 'bad_args' })
    })
})

describe('spawn-peer --item', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env[HAPI_BOT_ID_ENV]
        delete process.env[HAPI_SESSION_ID_ENV]
    })

    it('--bot without --receipt defaults to the hub receipt, like the env marker does', async () => {
        process.env[HAPI_SESSION_ID_ENV] = 'home-1'
        delete process.env[HAPI_BOT_ID_ENV]
        vi.spyOn(tokenInit, 'initializeToken').mockResolvedValue(undefined)
        vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue(spawned)
        const register = vi.spyOn(receipts, 'registerReceipt').mockResolvedValue({ id: 'r1' } as never)
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply')
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleSpawnPeerCommand(['--dir', '/tmp', '--name', 'W', '--bot', 'bot-7', 'msg'])
        expect(register).toHaveBeenCalledWith(CHILD, expect.objectContaining({ parentSessionId: 'home-1', taskLocalId: 'ping-peer-abc', kind: 'turn_end' }))
        expect(forward).not.toHaveBeenCalled()
    })

    it('attaches the new session to the item and keeps the spawn on a failed attach', async () => {
        process.env[HAPI_BOT_ID_ENV] = 'bot-1'
        process.env[HAPI_SESSION_ID_ENV] = 'home-1'
        vi.spyOn(tokenInit, 'initializeToken').mockResolvedValue(undefined)
        vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue(spawned)
        vi.spyOn(receipts, 'registerReceipt').mockResolvedValue({ id: 'r1' } as never)
        const update = vi.spyOn(itemsModule, 'updateItem')
            .mockResolvedValueOnce({ number: 12, status: 'working', title: 'Ship it' } as never)
            .mockRejectedValueOnce(new Error('no item 99'))
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})

        await handleSpawnPeerCommand(['--dir', '/tmp', '--name', 'W', '--item', '12', 'msg'])
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-1', itemId: 12, fromSessionId: 'home-1', body: { workerSessionId: CHILD } }))
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining(`OK ${CHILD}  name="Worker"  attached to item #12 [working] Ship it`))

        await handleSpawnPeerCommand(['--dir', '/tmp', '--name', 'W', '--item', '99', 'msg'])
        expect(error).toHaveBeenCalledWith(expect.stringContaining('could not attach to item 99'))
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining(`OK ${CHILD}  name="Worker"`))
    })

    it('without --bot and without the env marker nothing is registered', async () => {
        process.env[HAPI_SESSION_ID_ENV] = 'home-1'
        delete process.env[HAPI_BOT_ID_ENV]
        vi.spyOn(tokenInit, 'initializeToken').mockResolvedValue(undefined)
        vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue(spawned)
        const register = vi.spyOn(receipts, 'registerReceipt')
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleSpawnPeerCommand(['--dir', '/tmp', '--name', 'W', 'msg'])
        expect(register).not.toHaveBeenCalled()
    })

    it('passes an explicit --bot as the worker contract and refuses --receipt outside a session', async () => {
        vi.spyOn(tokenInit, 'initializeToken').mockResolvedValue(undefined)
        const spawn = vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue(spawned)
        vi.spyOn(receipts, 'registerReceipt').mockResolvedValue({ id: 'r1' } as never)
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleSpawnPeerCommand(['--dir', '/tmp', '--name', 'W', '--bot', 'bot-7', 'msg'])
        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ workerContract: { botId: 'bot-7', botName: null } }))

        await expect(handleSpawnPeerCommand(['--dir', '/tmp', '--name', 'W', '--receipt', 'caller', 'msg']))
            .rejects.toMatchObject({ code: 'bad_args' })
    })
})

import { describe, expect, it } from 'vitest'
import {
    ClearOpencodeSessionCallbackRequestSchema,
    ClearOpencodeSessionResponseSchema,
    CreateSessionResponseSchema,
    HubSettingsResponseSchema,
    ListCodexSessionsRpcResponseSchema,
    ListPiSessionsRpcResponseSchema,
    MessagesQuerySchema,
    SendMessageRequestSchema,
    UpdateHubSettingsRequestSchema
} from './apiTypes'
import { DecryptedMessageSchema } from './schemas'

describe('ListCodexSessionsRpcResponseSchema', () => {
    it('preserves Codex session messages when parsing runner RPC responses', () => {
        const parsed = ListCodexSessionsRpcResponseSchema.parse({
            success: true,
            sessions: [{
                id: 'codex-session-id',
                title: 'Codex Session',
                file: '/home/user/.codex/sessions/session.jsonl',
                modifiedAt: 1_000,
                messages: [{
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'hello'
                    },
                    meta: {
                        sentFrom: 'cli'
                    }
                }]
            }]
        })

        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.sessions[0]?.messages).toHaveLength(1)
        }
    })
})

describe('ListPiSessionsRpcResponseSchema', () => {
    it('preserves stable Pi entry and local ids', () => {
        const parsed = ListPiSessionsRpcResponseSchema.parse({
            success: true,
            sessions: [{
                id: 'pi-session-id',
                title: 'Pi Session',
                file: '/home/user/.pi/agent/sessions/session.jsonl',
                modifiedAt: 1_000,
                messageCount: 1,
                activeEntryIds: ['entry-1'],
                messages: [{
                    localId: 'pi:pi-session-id:entry-1:user',
                    entryId: 'entry-1',
                    parentEntryId: null,
                    createdAt: 900,
                    content: {
                        role: 'user',
                        content: { type: 'text', text: 'hello' },
                        meta: { sentFrom: 'cli' }
                    }
                }]
            }]
        })

        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.sessions[0]?.messages?.[0]?.entryId).toBe('entry-1')
    })
})

describe('ClearOpencodeSessionResponseSchema', () => {
    it('requires the new HAPI session identity', () => {
        expect(ClearOpencodeSessionResponseSchema.parse({ ok: true, sessionId: 'fresh-session' })).toEqual({
            ok: true,
            sessionId: 'fresh-session'
        })
    })
})

describe('ClearOpencodeSessionCallbackRequestSchema', () => {
    it('requires the reservation identity', () => {
        expect(ClearOpencodeSessionCallbackRequestSchema.parse({ replacementSessionId: 'fresh-session' })).toEqual({
            replacementSessionId: 'fresh-session'
        })
        expect(ClearOpencodeSessionCallbackRequestSchema.safeParse({}).success).toBe(false)
    })
})

describe('MessagesQuerySchema', () => {
    it('parses a forward cursor with a bounded snapshot and epoch', () => {
        expect(MessagesQuerySchema.parse({
            afterAt: '1000',
            afterSeq: '10',
            untilAt: '2000',
            untilSeq: '20',
            epoch: '3',
            limit: '200'
        })).toEqual({
            afterAt: 1000,
            afterSeq: 10,
            untilAt: 2000,
            untilSeq: 20,
            epoch: 3,
            limit: 200
        })
    })

    it('rejects mixed before and after directions', () => {
        expect(MessagesQuerySchema.safeParse({
            beforeAt: 1000,
            beforeSeq: 10,
            afterAt: 2000,
            afterSeq: 20
        }).success).toBe(false)
    })

    it('rejects an unpaired or unscoped until cursor', () => {
        expect(MessagesQuerySchema.safeParse({ untilAt: 2000, untilSeq: 20 }).success).toBe(false)
        expect(MessagesQuerySchema.safeParse({ afterAt: 1000, afterSeq: 10, untilAt: 2000 }).success).toBe(false)
    })

    it('rejects epoch without a forward cursor', () => {
        expect(MessagesQuerySchema.safeParse({ epoch: 1 }).success).toBe(false)
    })

    it('accepts a label, a manifest and an id list', () => {
        expect(MessagesQuerySchema.parse({ limit: '200', withRowHashes: '1' })).toEqual({ limit: 200, withRowHashes: '1' })
        expect(MessagesQuerySchema.parse({ limit: '200', rowHashes: '1', knownEpoch: '3' }))
            .toEqual({ limit: 200, rowHashes: '1', knownEpoch: 3 })
        expect(MessagesQuerySchema.parse({ limit: '200', withRowHashes: '1', knownEpoch: '3', ids: 'a,b' }))
            .toEqual({ limit: 200, withRowHashes: '1', knownEpoch: 3, ids: 'a,b' })
        // A label also rides along on a catch-up.
        expect(MessagesQuerySchema.safeParse({ afterAt: 1, afterSeq: 1, withRowHashes: '1' }).success).toBe(true)
        // An id list may name a whole page.
        expect(MessagesQuerySchema.safeParse({ withRowHashes: '1', knownEpoch: '1', ids: Array(200).fill('id').join(',') }).success).toBe(true)
    })

    it('rejects half-specified or misdirected fingerprint requests', () => {
        const rejected = [
            { rowHashes: '1' },
            { rowHashes: '1', knownEpoch: '1', afterAt: '1', afterSeq: '1' },
            { rowHashes: '1', knownEpoch: '1', beforeAt: '1', beforeSeq: '1' },
            { ids: 'a' },
            { ids: 'a', withRowHashes: '1' },
            { ids: 'a', knownEpoch: '1' },
            { withRowHashes: '1', knownEpoch: '1', afterAt: '1', afterSeq: '1', ids: 'a' },
            { withRowHashes: 'true' },
            { withRowHashes: '0' },
            { rowHashes: '0' },
            { withRowHashes: '1', knownEpoch: '1', ids: '' },
            { withRowHashes: '1', knownEpoch: '1', ids: 'a,,b' },
            { withRowHashes: '1', knownEpoch: '1', ids: 'a, b' },
            { withRowHashes: '1', knownEpoch: '1', ids: Array(201).fill('id').join(',') },
            { withRowHashes: '1', knownEpoch: '-1', ids: 'a' }
        ]
        for (const query of rejected) {
            expect(MessagesQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false)
        }
    })

    it('a manifest may ask to be answered under any epoch; only a manifest may', () => {
        expect(MessagesQuerySchema.parse({ limit: '200', rowHashes: '1', knownEpoch: '3', manifestAnyEpoch: '1' }))
            .toEqual({ limit: 200, rowHashes: '1', knownEpoch: 3, manifestAnyEpoch: '1' })
        for (const query of [
            // not without the manifest, not on an id list or a label, and one spelling
            { limit: '200', knownEpoch: '3', manifestAnyEpoch: '1' },
            { limit: '200', withRowHashes: '1', knownEpoch: '3', ids: 'a', manifestAnyEpoch: '1' },
            { limit: '200', withRowHashes: '1', manifestAnyEpoch: '1' },
            { limit: '200', rowHashes: '1', knownEpoch: '3', manifestAnyEpoch: 'true' },
            { limit: '200', rowHashes: '1', knownEpoch: '3', manifestAnyEpoch: '0' }
        ]) {
            expect(MessagesQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false)
        }
        // A query without the parameter parses to exactly what it did (nothing is added).
        expect(MessagesQuerySchema.parse({ limit: '200', rowHashes: '1', knownEpoch: '3' }))
            .toEqual({ limit: 200, rowHashes: '1', knownEpoch: 3 })
    })
})

describe('DecryptedMessageSchema rowHash', () => {
    it('carries a row fingerprint when the page was labelled, and nothing when it was not', () => {
        const message = { id: 'm1', seq: 1, localId: null, content: {}, createdAt: 1 }
        expect(DecryptedMessageSchema.parse({ ...message, rowHash: '0123456789ab' })).toEqual({ ...message, rowHash: '0123456789ab' })
        expect(DecryptedMessageSchema.parse(message)).toEqual(message)
    })
})

describe('SendMessageRequestSchema deliveryMode', () => {
    it('accepts queue and steer delivery modes while leaving the field optional', () => {
        expect(SendMessageRequestSchema.parse({ text: 'queue' }).deliveryMode).toBeUndefined()
        expect(SendMessageRequestSchema.parse({ text: 'steer', deliveryMode: 'steer' }).deliveryMode).toBe('steer')
        expect(SendMessageRequestSchema.parse({ text: 'queue', deliveryMode: 'queue' }).deliveryMode).toBe('queue')
    })

    it('rejects scheduled steer delivery', () => {
        const parsed = SendMessageRequestSchema.safeParse({
            text: 'later',
            localId: 'scheduled-steer',
            scheduledAt: Date.now() + 60_000,
            deliveryMode: 'steer'
        })

        expect(parsed.success).toBe(false)
        if (!parsed.success) {
            expect(parsed.error.issues.some((issue) => issue.path[0] === 'deliveryMode')).toBe(true)
            expect(parsed.error.issues.some((issue) => issue.message.includes('cannot use steer'))).toBe(true)
        }
    })
})

describe('disablePeerTools hub setting wire shapes', () => {
    it('UpdateHubSettingsRequestSchema accepts a lone disablePeerTools payload but still rejects empty bodies', () => {
        expect(UpdateHubSettingsRequestSchema.safeParse({ disablePeerTools: true }).success).toBe(true)
        expect(UpdateHubSettingsRequestSchema.safeParse({}).success).toBe(false)
        expect(UpdateHubSettingsRequestSchema.safeParse({ disablePeerTools: 'yes' }).success).toBe(false)
    })

    it('HubSettingsResponseSchema requires disablePeerTools as a boolean', () => {
        const parsed = HubSettingsResponseSchema.safeParse({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoTitlePerTurn: false,
            disablePeerTools: true,
            autoBridgeTransientModelErrors: false,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: { agent: 'cursor', permissionMode: 'default', models: {} }
        })
        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data.disablePeerTools).toBe(true)
        expect(HubSettingsResponseSchema.safeParse({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoTitlePerTurn: false,
            autoBridgeTransientModelErrors: false,
            telemetryLevel: 0,
            telemetryLevelSource: 'default',
            peerSpawnDefaults: { agent: 'cursor', permissionMode: 'default', models: {} }
        }).success).toBe(false)
        // telemetry fields are required on the response (developer-mode switch state)
        expect(HubSettingsResponseSchema.safeParse({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            autoTitlePerTurn: false,
            disablePeerTools: false,
            autoBridgeTransientModelErrors: false,
            peerSpawnDefaults: { agent: 'cursor', permissionMode: 'default', models: {} }
        }).success).toBe(false)
    })

    it('CreateSessionResponseSchema leaves disablePeerTools optional for older hubs', () => {
        const session = {
            id: 's1',
            namespace: 'default',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: null,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0
        }
        expect(CreateSessionResponseSchema.safeParse({ session }).success).toBe(true)
        const parsed = CreateSessionResponseSchema.safeParse({ session, disablePeerTools: true })
        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data.disablePeerTools).toBe(true)
    })
})

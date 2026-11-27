/**
 * Reply receipts (`session_receipts` on the hub). A bot that messages or
 * opens a worker with `replyVia: 'hub'` registers one instead of polling the
 * worker from its own process: when the worker's turn ends, the hub posts the
 * reply into the bot's home chat, waking it if needed. Survives a runner
 * restart and works for every flavor that reports `thinking`.
 *
 *   POST /api/sessions/:childId/receipts
 */

import { z } from 'zod'
import {
    RegisterSessionReceiptRequestSchema,
    SessionReceiptSchema,
    type SessionReceipt,
    type SessionReceiptKind
} from '@hapi/protocol'
import { isPeerToolsDisabled } from '@/modules/common/peerTools'
import { BotClientError, botAuthHeaders, botRequest, type BotClientOptions } from './botClient'

export type RegisterReceiptOptions = BotClientOptions & {
    /** The session the reply is posted back into (the bot's home chat). */
    parentSessionId: string
    /** `PingPeerResult.localId` of the message this receipt is the answer to. */
    taskLocalId: string
    kind?: SessionReceiptKind
}

const ReceiptResponseSchema = z.object({ receipt: SessionReceiptSchema })

/**
 * Register a `turn_end` receipt for a message already delivered to
 * `childSessionId`. Throws `BotClientError` when the hub refuses or does not
 * know the route (older hub); the caller decides how to fall back.
 */
export async function registerReceipt(childSessionId: string, options: RegisterReceiptOptions): Promise<SessionReceipt> {
    // Same defense-in-depth gate as pingPeer / spawnPeer: a receipt is a peer
    // message's shadow and must not outlive the switch that forbids the message.
    if (isPeerToolsDisabled()) {
        throw new BotClientError('disabled', 'peer session tools are disabled (disabled by your hub administrator, or HAPI_DISABLE_PEER_TOOLS is set)')
    }
    const child = (childSessionId ?? '').trim()
    if (!child) {
        throw new BotClientError('bad_args', 'child session id is required to register a receipt')
    }
    const body = RegisterSessionReceiptRequestSchema.safeParse({
        parentSessionId: options.parentSessionId,
        taskLocalId: options.taskLocalId,
        kind: options.kind ?? 'turn_end'
    })
    if (!body.success) {
        throw new BotClientError('bad_args', `invalid receipt: ${body.error.issues.map((issue) => issue.message).join('; ')}`)
    }
    return botRequest(options, {
        action: 'register reply receipt',
        request: async ({ jwt, http }) => http.post(
            `/api/sessions/${encodeURIComponent(child)}/receipts`,
            body.data,
            { headers: botAuthHeaders(jwt), timeout: 15_000, validateStatus: () => true }
        ),
        parse: (data) => ReceiptResponseSchema.parse(data).receipt
    })
}

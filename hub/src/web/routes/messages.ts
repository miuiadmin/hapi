import { Hono } from 'hono'
import { MessagesQuerySchema, QueuedStateRequestSchema, SendMessageRequestSchema } from '@hapi/protocol'
import type { MessagesQuery } from '@hapi/protocol/apiTypes'
import type { MessagePageRowHashes } from '../../sync/messageService'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'
import { stripLargeInlineImagePreviews } from '../../sync/attachmentPreviews'

/** The fingerprint part of a messages query; undefined when it asks for none of it. */
function rowHashesOf(query: MessagesQuery): MessagePageRowHashes | undefined {
    if (query.rowHashes === '1' && query.knownEpoch !== undefined) {
        return { kind: 'manifest', knownEpoch: query.knownEpoch }
    }
    if (query.ids !== undefined && query.knownEpoch !== undefined && query.withRowHashes === '1') {
        return { kind: 'ids', knownEpoch: query.knownEpoch, ids: query.ids.split(',') }
    }
    return query.withRowHashes === '1' ? { kind: 'label' } : undefined
}

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const parsed = MessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        }

        const limit = parsed.data.limit ?? 50
        const before = parsed.data.beforeAt !== undefined && parsed.data.beforeSeq !== undefined
            ? { at: parsed.data.beforeAt, seq: parsed.data.beforeSeq }
            : null
        const after = parsed.data.afterAt !== undefined && parsed.data.afterSeq !== undefined
            ? { at: parsed.data.afterAt, seq: parsed.data.afterSeq }
            : null
        const until = parsed.data.untilAt !== undefined && parsed.data.untilSeq !== undefined
            ? { at: parsed.data.untilAt, seq: parsed.data.untilSeq }
            : null
        const page = engine.getMessagesPage(sessionId, {
            limit,
            before,
            after,
            until,
            epoch: parsed.data.epoch ?? null,
            minConversation: parsed.data.minConversation,
            rowHashes: rowHashesOf(parsed.data)
        })
        // Large inline image previews do not ride along on pages; the web
        // fetches them on demand from the attachment preview route below.
        return c.json({ ...page, messages: stripLargeInlineImagePreviews(page.messages) })
    })

    app.get('/sessions/:id/messages/:messageId/attachments/:attachmentId/preview', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const preview = engine.getMessageAttachmentPreview(
            sessionResult.sessionId,
            c.req.param('messageId'),
            c.req.param('attachmentId')
        )
        if (!preview) {
            return c.json({ error: 'Attachment preview not found' }, 404)
        }
        return new Response(preview.data, {
            headers: {
                'Content-Type': preview.mimeType,
                'Content-Length': String(preview.data.byteLength),
                'X-Content-Type-Options': 'nosniff',
                // Message content is immutable, so the browser keeps the image
                // across every later page refetch of the same session.
                'Cache-Control': 'private, max-age=31536000, immutable',
            },
        })
    })

    app.get('/sessions/:id/messages/:messageId/context', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const context = engine.getMessageContext(sessionResult.sessionId, c.req.param('messageId'))
        if (!context) {
            return c.json(context)
        }
        return c.json({ ...context, messages: stripLargeInlineImagePreviews(context.messages) })
    })

    app.delete('/sessions/:id/messages/:messageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.cancelQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/:messageId/steer', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.steerQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/:messageId/retry', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        return c.json(await engine.retryIndeterminateMessage(
            sessionResult.sessionId,
            c.req.param('messageId')
        ))
    })

    // Explicit "send now" for a queued row (queued-bar ↑ affordance). No
    // requireActive: the primary use case is a row stranded by an abort, when
    // the session exists but no turn is running.
    app.post('/sessions/:id/messages/:messageId/deliver-now', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        return c.json(await engine.deliverQueuedMessageNow(
            sessionResult.sessionId,
            c.req.param('messageId')
        ))
    })

    app.post('/sessions/:id/messages/queued-state', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = QueuedStateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const localIds = [...new Set(parsed.data.localIds)]
        if (localIds.length === 0) {
            return c.json({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] })
        }
        return c.json(engine.getQueuedState(sessionId, localIds))
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = SendMessageRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        // Require text or attachments
        if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
            return c.json({ error: 'Message requires text or attachments' }, 400)
        }

        await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            localId: parsed.data.localId,
            attachments: parsed.data.attachments,
            sentFrom: 'webapp',
            scheduledAt: parsed.data.scheduledAt,
            deliveryMode: parsed.data.deliveryMode
        })
        return c.json({ ok: true })
    })

    return app
}

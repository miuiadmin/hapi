import { Hono } from 'hono'
import type { Context } from 'hono'
import {
    BotItemAskRequestSchema,
    BotItemCommentRequestSchema,
    CreateBotItemRequestSchema,
    CreateBotRequestSchema,
    RegisterSessionReceiptRequestSchema,
    UpdateBotItemRequestSchema,
    UpdateBotRequestSchema
} from '@hapi/protocol'
import { BotError } from '../../bots/botService'
import { SessionReceiptLimitError } from '../../sync/sessionReceiptService'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

/**
 * Bots and their ledger. Every route is scoped to the caller's namespace.
 *
 * Two callers share the ledger: the owner, from the web client, and the bot
 * itself, from inside its home chat. Agent calls say which session they run
 * in (`fromSessionId`); the service checks that it is the bot's home chat.
 */

type BodySchema<T> = { safeParse: (body: unknown) => { success: true; data: T } | { success: false } }

async function readBody<T>(c: Context<WebAppEnv>, schema: BodySchema<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
    const json = await c.req.json().catch(() => null)
    const parsed = schema.safeParse(json)
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, response: c.json({ error: 'Invalid body' }, 400) }
}

/** Run one handler body and turn a refusal into the response it names. */
async function attempt(c: Context<WebAppEnv>, run: () => unknown): Promise<Response> {
    try {
        return await run() as Response
    } catch (error) {
        if (error instanceof BotError) {
            return c.json({ error: error.message, code: error.code }, error.status as 400)
        }
        if (error instanceof SessionReceiptLimitError) {
            return c.json({ error: error.message, code: error.code }, 429)
        }
        throw error
    }
}

export function createBotRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const engine = (c: Context<WebAppEnv>): SyncEngine | Response => requireSyncEngine(c, getSyncEngine)

    // ---- bots ---------------------------------------------------------------

    app.get('/bots', (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        return c.json({ bots: ready.botService.list(c.get('namespace')) })
    })

    app.post('/bots', async (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        const body = await readBody(c, CreateBotRequestSchema)
        if (!body.ok) return body.response
        return attempt(c, async () => {
            const bot = await ready.botService.create(c.get('namespace'), body.data)
            c.status(201)
            return c.json({ bot })
        })
    })

    app.get('/bots/:botId', (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        return attempt(c, () => c.json({ bot: ready.botService.get(c.get('namespace'), c.req.param('botId')) }))
    })

    app.patch('/bots/:botId', async (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        const body = await readBody(c, UpdateBotRequestSchema)
        if (!body.ok) return body.response
        return attempt(c, async () => c.json({
            bot: await ready.botService.update(c.get('namespace'), c.req.param('botId'), body.data)
        }))
    })

    app.delete('/bots/:botId', (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        return attempt(c, () => {
            ready.botService.archive(c.get('namespace'), c.req.param('botId'))
            return c.json({ ok: true as const })
        })
    })

    // ---- views --------------------------------------------------------------

    app.get('/bots/:botId/needs-you', (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        return attempt(c, () => c.json({ entries: ready.botService.needsYou(c.get('namespace'), c.req.param('botId')) }))
    })

    app.get('/bots/:botId/workers', (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        return attempt(c, () => c.json({ workers: ready.botService.workers(c.get('namespace'), c.req.param('botId')) }))
    })

    // ---- items --------------------------------------------------------------

    app.get('/bots/:botId/items', (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        return attempt(c, () => c.json({ items: ready.botService.listItems(c.get('namespace'), c.req.param('botId')) }))
    })

    app.post('/bots/:botId/items', async (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        const body = await readBody(c, CreateBotItemRequestSchema)
        if (!body.ok) return body.response
        return attempt(c, () => c.json(ready.botService.createItem(c.get('namespace'), c.req.param('botId'), body.data)))
    })

    app.patch('/bots/:botId/items/:itemId', async (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        const body = await readBody(c, UpdateBotItemRequestSchema)
        if (!body.ok) return body.response
        return attempt(c, () => c.json({
            item: ready.botService.updateItem(c.get('namespace'), c.req.param('botId'), c.req.param('itemId'), body.data)
        }))
    })

    app.post('/bots/:botId/items/:itemId/ask', async (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        const body = await readBody(c, BotItemAskRequestSchema)
        if (!body.ok) return body.response
        return attempt(c, () => c.json({
            item: ready.botService.ask(c.get('namespace'), c.req.param('botId'), c.req.param('itemId'), body.data)
        }))
    })

    app.post('/bots/:botId/items/:itemId/comments', async (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        const body = await readBody(c, BotItemCommentRequestSchema)
        if (!body.ok) return body.response
        return attempt(c, () => c.json(ready.botService.comment(c.get('namespace'), c.req.param('botId'), c.req.param('itemId'), body.data)))
    })

    app.get('/bots/:botId/items/:itemId/events', (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        return attempt(c, () => c.json({
            events: ready.botService.listEvents(c.get('namespace'), c.req.param('botId'), c.req.param('itemId'))
        }))
    })

    // ---- receipts -----------------------------------------------------------

    /**
     * `ping_peer` / `spawn_peer` with `replyVia: 'hub'`: the hub posts the
     * reply back. The caller names two sessions and one message; each is
     * checked against the caller's namespace before a row is made of them.
     */
    app.post('/sessions/:id/receipts', async (c) => {
        const ready = engine(c)
        if (ready instanceof Response) return ready
        const child = requireSessionFromParam(c, ready)
        if (child instanceof Response) return child
        const body = await readBody(c, RegisterSessionReceiptRequestSchema)
        if (!body.ok) return body.response
        // The reply is posted into the parent, which wakes it: it has to be a
        // session of this namespace, not merely one that exists.
        const parent = ready.resolveSessionAccess(body.data.parentSessionId, c.get('namespace'))
        if (!parent.ok) {
            return c.json({ error: 'Session not found', code: 'parent_not_found' }, 404)
        }
        // A registration follows the message it answers, so that message is
        // already in the child's transcript. One that is not names a message
        // that was never sent (or is long gone).
        if (!ready.sessionHasMessage(child.sessionId, body.data.taskLocalId)) {
            return c.json({ error: 'No such message in that session', code: 'task_not_found' }, 404)
        }
        return attempt(c, () => {
            const receipt = ready.sessionReceipts.register(child.sessionId, { ...body.data, parentSessionId: parent.sessionId })
            c.status(201)
            return c.json({ receipt })
        })
    })

    return app
}

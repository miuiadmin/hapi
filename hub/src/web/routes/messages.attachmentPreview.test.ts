import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { MessageContextResponse, MessagesResponse } from '@hapi/protocol/apiTypes'
import type { SyncEngine } from '../../sync/syncEngine'
import { INLINE_IMAGE_PREVIEW_MAX_BYTES, type InlineImagePreview } from '../../sync/attachmentPreviews'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

const PIXEL_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const SHOT_URL = `data:image/jpeg;base64,${'A'.repeat(INLINE_IMAGE_PREVIEW_MAX_BYTES + 1)}`

const page: MessagesResponse['page'] = {
    readThroughRevision: 12,
    direction: 'latest',
    limit: 50,
    epoch: 7,
    reset: false,
    nextBeforeSeq: 1,
    nextBeforeAt: 10,
    nextAfterSeq: null,
    nextAfterAt: null,
    snapshotHeadSeq: 5,
    snapshotHeadAt: 50,
    hasMore: true
}
const contextPage: MessageContextResponse['page'] = {
    epoch: 7,
    nextBeforeSeq: 1,
    nextBeforeAt: 10,
    snapshotHeadSeq: 5,
    snapshotHeadAt: 50,
    hasMore: true
}

const screenshot = {
    id: 'message-shot',
    seq: 2,
    createdAt: 20,
    content: {
        role: 'user',
        content: {
            type: 'text',
            text: '正式服有黑块',
            attachments: [{ id: 'att-shot', filename: '15071.jpg', mimeType: 'image/jpeg', size: 551943, path: '/tmp/15071.jpg', previewUrl: SHOT_URL }]
        }
    }
}
const icon = {
    id: 'message-icon',
    seq: 3,
    createdAt: 30,
    content: {
        role: 'user',
        content: {
            type: 'text',
            text: 'icon',
            attachments: [{ id: 'att-icon', filename: 'dot.png', mimeType: 'image/png', size: 71, path: '/tmp/dot.png', previewUrl: `data:image/png;base64,${PIXEL_BASE64}` }]
        }
    }
}
const plain = { id: 'message-plain', seq: 4, createdAt: 40, content: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } }

function createApp(engine: Partial<SyncEngine>) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createMessagesRoutes(() => engine as SyncEngine))
    return app
}

function previewEngine(overrides: Partial<SyncEngine> = {}) {
    const calls: Array<[string, string, string]> = []
    const engine: Partial<SyncEngine> = {
        resolveSessionAccess: (sessionId: string) => ({
            ok: true,
            sessionId,
            session: { id: sessionId, active: true } as never
        }),
        getMessagesPage: (): MessagesResponse => ({ messages: [screenshot, icon, plain] as never, page }),
        getMessageContext: (): MessageContextResponse | null => ({
            messages: [screenshot, plain] as never,
            targetMessageId: 'message-shot',
            page: contextPage
        }),
        getMessageAttachmentPreview: (sessionId: string, messageId: string, attachmentId: string): InlineImagePreview | null => {
            calls.push([sessionId, messageId, attachmentId])
            if (attachmentId !== 'att-shot') return null
            return { mimeType: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }
        },
        ...overrides
    }
    return { engine, calls }
}

describe('GET /api/sessions/:id/messages', () => {
    it('leaves large inline image previews off the page and marks them for lazy loading', async () => {
        const { engine } = previewEngine()
        const response = await createApp(engine).request('/api/sessions/session-1/messages')

        expect(response.status).toBe(200)
        const body = await response.json() as MessagesResponse
        expect(body.page).toEqual(page)
        const shot = (body.messages[0]!.content as { content: { attachments: Array<Record<string, unknown>> } }).content.attachments[0]!
        expect(shot).not.toHaveProperty('previewUrl')
        expect(shot.hasPreview).toBe(true)
        expect(shot.filename).toBe('15071.jpg')
        const iconAttachment = (body.messages[1]!.content as { content: { attachments: Array<Record<string, unknown>> } }).content.attachments[0]!
        expect(iconAttachment.previewUrl).toBe(`data:image/png;base64,${PIXEL_BASE64}`)
        expect(iconAttachment).not.toHaveProperty('hasPreview')
        expect({ ...body.messages[2] }).toEqual(plain as never)
        // 0.7 MB of base64 is gone from what every cold open re-downloads.
        expect(JSON.stringify(body).length).toBeLessThan(2_000)
    })
})

describe('GET /api/sessions/:id/messages/:messageId/context', () => {
    it('strips large inline previews from search-target context the same way', async () => {
        const { engine } = previewEngine()
        const response = await createApp(engine).request('/api/sessions/session-1/messages/message-shot/context')

        expect(response.status).toBe(200)
        const body = await response.json() as MessageContextResponse
        const attachments = (body.messages[0]!.content as { content: { attachments: Array<Record<string, unknown>> } }).content.attachments
        expect(attachments[0]).toMatchObject({ id: 'att-shot', hasPreview: true })
        expect(attachments[0]).not.toHaveProperty('previewUrl')
        expect(body.targetMessageId).toBe('message-shot')
    })
})

describe('GET /api/sessions/:id/messages/:messageId/attachments/:attachmentId/preview', () => {
    it('serves the stored image as a privately cacheable response', async () => {
        const { engine, calls } = previewEngine()
        const response = await createApp(engine).request('/api/sessions/session-1/messages/message-shot/attachments/att-shot/preview')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/jpeg')
        expect(response.headers.get('content-length')).toBe('4')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
        expect(calls).toEqual([['session-1', 'message-shot', 'att-shot']])
    })

    it('is 404 when the attachment has no stored preview', async () => {
        const { engine, calls } = previewEngine()
        const response = await createApp(engine).request('/api/sessions/session-1/messages/message-icon/attachments/att-icon/preview')

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'Attachment preview not found' })
        expect(calls).toEqual([['session-1', 'message-icon', 'att-icon']])
    })

    it('never looks a preview up for a session the caller cannot access', async () => {
        const { engine, calls } = previewEngine({
            resolveSessionAccess: () => ({ ok: false, reason: 'access-denied' })
        })
        const response = await createApp(engine).request('/api/sessions/session-1/messages/message-shot/attachments/att-shot/preview')

        expect(response.status).toBe(403)
        expect(calls).toEqual([])
    })

    it('looks the preview up under the session id the hub resolved (merged ids)', async () => {
        const { engine, calls } = previewEngine({
            resolveSessionAccess: (sessionId: string) => ({ ok: true, sessionId: `${sessionId}-resolved`, session: { id: sessionId } as never })
        })
        const response = await createApp(engine).request('/api/sessions/session-1/messages/message-shot/attachments/att-shot/preview')

        expect(response.status).toBe(200)
        expect(calls).toEqual([['session-1-resolved', 'message-shot', 'att-shot']])
    })
})

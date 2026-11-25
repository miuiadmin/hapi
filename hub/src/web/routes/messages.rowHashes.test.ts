import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { DecryptedMessage } from '@hapi/protocol'
import type { MessagesResponse } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import { EventPublisher } from '../../sync/eventPublisher'
import { MessageService } from '../../sync/messageService'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

const HASH = /^[0-9a-f]{12}$/

function agentOutput(dataType: string, blocks: unknown[]): unknown {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: dataType,
                message: { role: dataType, content: blocks }
            }
        }
    }
}

function userPrompt(id: string): unknown {
    return { role: 'user', content: { type: 'text', text: `question ${id}` } }
}

function assistantText(id: string): unknown {
    return agentOutput('assistant', [{ type: 'text', text: `answer ${id}` }])
}

/** `page` without its manifest. */
function withoutManifest(page: MessagesResponse['page']): Omit<MessagesResponse['page'], 'rowHashes'> {
    const { rowHashes: _rowHashes, ...rest } = page
    return rest
}

/** The messages as an unlabelled page serves them. */
function unlabelled(messages: DecryptedMessage[]): DecryptedMessage[] {
    return messages.map(({ rowHash: _rowHash, ...message }) => message as DecryptedMessage)
}

function fingerprints(messages: DecryptedMessage[]): Array<{ id: string; hash: string }> {
    return messages.map((message) => ({ id: message.id, hash: message.rowHash ?? '' }))
}

describe('GET /api/sessions/:id/messages — row fingerprints', () => {
    function createApp(store: Store): Hono<WebAppEnv> {
        const service = new MessageService(
            store,
            { sockets: new Map(), except: () => {} } as never,
            { emit() {} } as unknown as EventPublisher
        )
        const engine = {
            resolveSessionAccess: (sessionId: string) => (
                { ok: true, sessionId, session: { id: sessionId, active: true } as never }
            ),
            getMessagesPage: (sessionId: string, options: Parameters<SyncEngine['getMessagesPage']>[1]) => (
                service.getMessagesPage(sessionId, options as never)
            )
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => engine))
        return app
    }

    function newSession(store: Store, tag: string): string {
        return store.sessions.getOrCreateSession(tag, { path: '/p', machineId: 'm', flavor: 'claude' }, null, 'default').id
    }

    async function get(app: Hono<WebAppEnv>, sessionId: string, query: string): Promise<MessagesResponse> {
        const response = await app.request(`/api/sessions/${sessionId}/messages${query}`)
        expect(response.status).toBe(200)
        return await response.json() as MessagesResponse
    }

    function editRow(store: Store, id: string, content: unknown): void {
        const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
        db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(JSON.stringify(content), id)
    }

    function seedConversation(store: Store, sessionId: string, count: number): void {
        for (let i = 1; i <= count; i++) {
            store.messages.addMessage(sessionId, i % 2 === 0 ? assistantText(`a${i}`) : userPrompt(`q${i}`), undefined, null, 1000 + i)
        }
    }

    it('changes nothing for a caller that does not ask', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'hashes-plain')
        seedConversation(store, sessionId, 5)
        const app = createApp(store)

        for (const query of ['?limit=200', '?limit=20&minConversation=1', '?limit=5']) {
            const response = await (await app.request(`/api/sessions/${sessionId}/messages${query}`)).text()
            expect(response).not.toContain('rowHash')
        }
    })

    it('labels every message of a page with its fingerprint', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'hashes-label')
        seedConversation(store, sessionId, 8)
        const app = createApp(store)

        const plain = await get(app, sessionId, '?limit=200')
        const labelled = await get(app, sessionId, '?limit=200&withRowHashes=1')
        expect(labelled.messages.every((message) => HASH.test(message.rowHash ?? ''))).toBe(true)
        expect(new Set(labelled.messages.map((message) => message.rowHash)).size).toBe(8)
        // The label is the only difference.
        expect(unlabelled(labelled.messages)).toEqual(plain.messages)
        expect(withoutManifest(labelled.page)).toEqual(withoutManifest(plain.page))
        expect(labelled.page).not.toHaveProperty('rowHashes')
    })

    it('answers a manifest with the page minus its messages', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'hashes-manifest')
        seedConversation(store, sessionId, 12)
        const app = createApp(store)

        const plain = await get(app, sessionId, '?limit=200')
        const labelled = await get(app, sessionId, '?limit=200&withRowHashes=1')
        const manifest = await get(app, sessionId, `?limit=200&rowHashes=1&knownEpoch=${plain.page.epoch}`)
        expect(manifest.messages).toHaveLength(0)
        expect(withoutManifest(manifest.page)).toEqual(withoutManifest(plain.page))
        expect(manifest.page.rowHashes).toEqual(fingerprints(labelled.messages))

        // A row changed in place shows up as a different fingerprint, nothing else moves.
        const before = manifest.page.rowHashes as Array<{ id: string; hash: string }>
        const changed = plain.messages[4]
        editRow(store, changed.id, assistantText('edited'))
        const after = await get(app, sessionId, `?limit=200&rowHashes=1&knownEpoch=${plain.page.epoch}`)
        expect(after.page.rowHashes?.filter((entry, i) => entry.hash !== before[i].hash).map((entry) => entry.id))
            .toEqual([changed.id])

        // A row appended on top joins the page.
        store.messages.addMessage(sessionId, userPrompt('q13'), undefined, null, 1013)
        const grown = await get(app, sessionId, `?limit=200&rowHashes=1&knownEpoch=${plain.page.epoch}`)
        expect(grown.page.rowHashes).toHaveLength(13)
    })

    it('serves only the asked-for rows of the page', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'hashes-ids')
        seedConversation(store, sessionId, 10)
        const app = createApp(store)
        const plain = await get(app, sessionId, '?limit=200')
        const wanted = [plain.messages[7].id, plain.messages[2].id]

        const page = await get(
            app,
            sessionId,
            `?limit=200&withRowHashes=1&knownEpoch=${plain.page.epoch}&ids=${wanted.join(',')}`
        )
        // Display order, not the order they were asked in; labelled like any page.
        expect(page.messages.map((message) => message.id)).toEqual([wanted[1], wanted[0]])
        expect(page.messages.every((message) => HASH.test(message.rowHash ?? ''))).toBe(true)
        // Everything else about the page is the whole page's.
        expect(withoutManifest(page.page)).toEqual(withoutManifest(plain.page))

        // Ids the page does not hold are simply not served.
        const outside = await get(app, sessionId, `?limit=200&withRowHashes=1&knownEpoch=${plain.page.epoch}&ids=not-a-row`)
        expect(outside.messages).toHaveLength(0)
    })

    it('answers with the whole page once the epoch has moved on', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'hashes-epoch')
        seedConversation(store, sessionId, 4)
        const app = createApp(store)
        const plain = await get(app, sessionId, '?limit=200')
        store.messages.bumpMessageEpoch(sessionId)

        const manifest = await get(app, sessionId, `?limit=200&rowHashes=1&knownEpoch=${plain.page.epoch}`)
        expect(manifest.messages).toHaveLength(4)
        expect(manifest.page).not.toHaveProperty('rowHashes')
        const ids = await get(
            app,
            sessionId,
            `?limit=200&withRowHashes=1&knownEpoch=${plain.page.epoch}&ids=${plain.messages[0].id}`
        )
        expect(ids.messages).toHaveLength(4)

        // Under the new epoch the narrowing works again.
        const narrowed = await get(
            app,
            sessionId,
            `?limit=200&withRowHashes=1&knownEpoch=${ids.page.epoch}&ids=${plain.messages[0].id}`
        )
        expect(narrowed.messages.map((message) => message.id)).toEqual([plain.messages[0].id])
    })

    it('labels catch-up pages, including a reset verdict', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'hashes-after')
        seedConversation(store, sessionId, 6)
        const app = createApp(store)
        const plain = await get(app, sessionId, '?limit=200')
        const oldest = plain.messages[0]

        const after = await get(
            app,
            sessionId,
            `?afterAt=${oldest.createdAt}&afterSeq=${oldest.seq}&limit=200&epoch=${plain.page.epoch}&withRowHashes=1`
        )
        expect(after.page.direction).toBe('after')
        expect(after.messages).toHaveLength(5)
        expect(after.messages.every((message) => HASH.test(message.rowHash ?? ''))).toBe(true)

        // A catch-up under an epoch the hub has left is answered by a full replacement page.
        const reset = await get(
            app,
            sessionId,
            `?afterAt=${oldest.createdAt}&afterSeq=${oldest.seq}&limit=200&epoch=${plain.page.epoch + 5}&withRowHashes=1`
        )
        expect(reset.page.reset).toBe(true)
        expect(reset.messages).toHaveLength(6)
        expect(reset.messages.every((message) => HASH.test(message.rowHash ?? ''))).toBe(true)

        // Unlabelled catch-ups are what they were.
        const bare = await get(app, sessionId, `?afterAt=${oldest.createdAt}&afterSeq=${oldest.seq}&limit=200&epoch=${plain.page.epoch}`)
        expect(JSON.stringify(bare)).not.toContain('rowHash')
    })

    it('keeps uninvoked queued rows in the manifest and the narrowed page', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'hashes-queued')
        store.messages.addMessage(sessionId, userPrompt('q1'), undefined, null, 1000)
        store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: 'queued' } }, 'local-queued', null, 1001)
        const app = createApp(store)
        const plain = await get(app, sessionId, '?limit=200')
        const queuedId = plain.messages.find((message) => message.localId === 'local-queued')?.id as string

        const manifest = await get(app, sessionId, `?limit=200&rowHashes=1&knownEpoch=${plain.page.epoch}`)
        expect(manifest.page.rowHashes?.map((entry) => entry.id)).toEqual(plain.messages.map((message) => message.id))

        const narrowed = await get(
            app,
            sessionId,
            `?limit=200&withRowHashes=1&knownEpoch=${plain.page.epoch}&ids=${queuedId}`
        )
        expect(narrowed.messages.map((message) => message.id)).toEqual([queuedId])
    })

    it('rejects half-specified or misdirected requests', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'hashes-invalid')
        store.messages.addMessage(sessionId, userPrompt('q1'), undefined, null, 1000)
        const app = createApp(store)

        for (const query of [
            // a manifest and an id list both need the epoch the caller's fingerprints belong to
            '?limit=200&rowHashes=1',
            '?limit=200&withRowHashes=1&ids=abc',
            '?limit=200&knownEpoch=0&ids=abc',
            // newest page only
            '?limit=2&beforeAt=1000&beforeSeq=1&rowHashes=1&knownEpoch=0',
            '?afterAt=999&afterSeq=0&rowHashes=1&knownEpoch=0',
            // the flag has one spelling
            '?limit=200&withRowHashes=true',
            '?limit=200&rowHashes=0',
            // id lists are bounded and well-formed
            `?limit=200&withRowHashes=1&knownEpoch=0&ids=${Array.from({ length: 201 }, (_, i) => `id${i}`).join(',')}`,
            '?limit=200&withRowHashes=1&knownEpoch=0&ids=',
            '?limit=200&withRowHashes=1&knownEpoch=0&ids=a,,b',
            '?limit=200&withRowHashes=1&knownEpoch=0&ids=a, b'
        ]) {
            const response = await app.request(`/api/sessions/${sessionId}/messages${query}`)
            expect(response.status).toBe(400)
        }
    })

    it('lets one id list hold a whole page', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'hashes-200')
        const app = createApp(store)
        const ids = Array.from({ length: 200 }, (_, i) => `id${i}`).join(',')
        const page = await get(app, sessionId, `?limit=200&withRowHashes=1&knownEpoch=0&ids=${ids}`)
        expect(page.page.direction).toBe('latest')
        expect(page.messages).toHaveLength(0)
    })
})

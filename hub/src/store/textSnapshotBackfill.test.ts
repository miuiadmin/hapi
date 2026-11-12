import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store } from './index'
import { isTextSnapshotBackfillDone, runTextSnapshotBackfill } from './textSnapshotBackfill'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('schema migration v28 to v29', () => {
    it('adds the store_maintenance marker table', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v28-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE store_maintenance;
            PRAGMA user_version = 28;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const tables = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'store_maintenance'"
        ).all() as Array<{ name: string }>

        expect(version.user_version).toBe(29)
        expect(tables).toHaveLength(1)
        expect(isTextSnapshotBackfillDone(internalDb)).toBe(false)
        migrated.close()
    })
})

describe('text snapshot backfill', () => {
    /** A stored text row exactly like the CLI wrote it pre-fix: snapshots
     *  carried streamSnapshot but no live marker, and neither did the
     *  boundary's settled row. */
    function legacyTextRow(streamId: string, text: string, live: boolean) {
        return {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'message',
                    message: text,
                    id: streamId,
                    streamSnapshot: true,
                    ...(live ? { live: true } : {})
                }
            }
        }
    }

    function makeStore() {
        return new Store(':memory:')
    }

    function makeSession(store: Store, tag: string) {
        return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
    }

    function textBodies(store: Store, sessionId: string): string[] {
        return store.messages.getAllMessages(sessionId)
            .map((message) => message.content as { content: { data: { type: string; message?: string } } })
            .filter((content) => content.content.data.type === 'message')
            .map((content) => content.content.data.message as string)
    }

    it('keeps only the newest row of each legacy stream and reports reclaimed bytes', async () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-legacy')
        const db = (store as unknown as { db: Database }).db

        for (const text of ['Hello', 'Hello world', 'Hello world, this is the answer']) {
            store.messages.addMessage(session.id, legacyTextRow('stream-1', text, true))
        }
        store.messages.addMessage(session.id, legacyTextRow('stream-1', 'Hello world, this is the answer — settled.', false))

        const stats = await runTextSnapshotBackfill(db)

        expect(stats).not.toBeNull()
        expect(stats!.deletedRows).toBe(3)
        expect(stats!.cleanedStreams).toBe(1)
        expect(stats!.candidateRows).toBe(4)
        expect(stats!.deletedBytes).toBeGreaterThan(0)
        expect(textBodies(store, session.id)).toEqual(['Hello world, this is the answer — settled.'])
        expect(isTextSnapshotBackfillDone(db)).toBe(true)
        store.close()
    })

    it('cleans new-format live rows too', async () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-live')
        const db = (store as unknown as { db: Database }).db

        store.messages.addMessage(session.id, legacyTextRow('stream-9', 'partial', true))
        store.messages.addMessage(session.id, legacyTextRow('stream-9', 'partial and more', true))
        store.messages.addMessage(session.id, legacyTextRow('stream-9', 'full text', false))

        const stats = await runTextSnapshotBackfill(db)

        expect(stats!.deletedRows).toBe(2)
        expect(textBodies(store, session.id)).toEqual(['full text'])
        store.close()
    })

    it('leaves plain text, reasoning and tool rows untouched', async () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-untouched')
        const db = (store as unknown as { db: Database }).db

        store.messages.addMessage(session.id, { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: 'plain one' } } })
        store.messages.addMessage(session.id, { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: 'plain two', id: 'id-but-no-marker' } } })
        store.messages.addMessage(session.id, { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'reasoning', message: 'thought', id: 'r-1', live: true } } })

        const stats = await runTextSnapshotBackfill(db)

        expect(stats!.deletedRows).toBe(0)
        expect(store.messages.getAllMessages(session.id)).toHaveLength(3)
        store.close()
    })

    it('groups per session and per stream id', async () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'backfill-groups-a')
        const sessionB = makeSession(store, 'backfill-groups-b')
        const db = (store as unknown as { db: Database }).db

        store.messages.addMessage(sessionA.id, legacyTextRow('stream-1', 'a1', true))
        store.messages.addMessage(sessionA.id, legacyTextRow('stream-1', 'a2', true))
        store.messages.addMessage(sessionA.id, legacyTextRow('stream-2', 'b1', true))
        store.messages.addMessage(sessionA.id, legacyTextRow('stream-2', 'b2', true))
        store.messages.addMessage(sessionB.id, legacyTextRow('stream-1', 'theirs1', true))
        store.messages.addMessage(sessionB.id, legacyTextRow('stream-1', 'theirs2', true))

        const stats = await runTextSnapshotBackfill(db)

        expect(stats!.deletedRows).toBe(3)
        expect(stats!.cleanedStreams).toBe(3)
        expect(textBodies(store, sessionA.id)).toEqual(['a2', 'b2'])
        expect(textBodies(store, sessionB.id)).toEqual(['theirs2'])
        store.close()
    })

    it('runs only once: the durable marker blocks a second pass', async () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-once')
        const db = (store as unknown as { db: Database }).db

        store.messages.addMessage(session.id, legacyTextRow('stream-1', 'one', true))
        store.messages.addMessage(session.id, legacyTextRow('stream-1', 'two', true))
        const first = await runTextSnapshotBackfill(db)
        expect(first!.deletedRows).toBe(1)

        // Rows that appear after the completed pass are the runtime sweep's
        // business; the backfill must not rescan the whole transcript.
        store.messages.addMessage(session.id, legacyTextRow('stream-2', 'late one', true))
        store.messages.addMessage(session.id, legacyTextRow('stream-2', 'late two', true))
        const second = await runTextSnapshotBackfill(db)
        expect(second).toBeNull()
        expect(textBodies(store, session.id)).toEqual(['two', 'late one', 'late two'])
        store.close()
    })

    it('scans in batches across more than one chunk', async () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-batched')
        const db = (store as unknown as { db: Database }).db

        // Two interleaved streams with several snapshots each, padded past the
        // 500-row scan chunk to exercise keyset pagination.
        for (let i = 0; i < 620; i++) {
            const streamId = i % 2 === 0 ? 'stream-even' : 'stream-odd'
            store.messages.addMessage(session.id, legacyTextRow(streamId, `text ${i}`, true))
        }

        const stats = await runTextSnapshotBackfill(db)

        expect(stats!.scannedRows).toBeGreaterThanOrEqual(620)
        expect(stats!.deletedRows).toBe(618)
        expect(textBodies(store, session.id)).toEqual(['text 618', 'text 619'])
        store.close()
    })

    it('exposes the sweep through the Store facade', async () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-facade')

        store.messages.addMessage(session.id, legacyTextRow('stream-1', 'one', true))
        store.messages.addMessage(session.id, legacyTextRow('stream-1', 'two', true))

        const stats = await store.runTextSnapshotBackfill()
        expect(stats!.deletedRows).toBe(1)
        expect(await store.runTextSnapshotBackfill()).toBeNull()
        store.close()
    })
})

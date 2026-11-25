import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { StoredMessage } from './types'
import { Store } from './index'
import { getMessagesAfterPosition, getMessagesByPosition, getUninvokedLocalMessages } from './messages'

const HASH = /^[0-9a-f]{12}$/

function session(store: Store, tag: string): string {
    return store.sessions.getOrCreateSession(tag, { path: '/p', machineId: 'm', flavor: 'claude' }, null, 'default').id
}

function raw(store: Store): Database {
    return (store as unknown as { db: Database }).db
}

describe('row fingerprints (withRowHash)', () => {
    it('are only computed for callers that ask', () => {
        const store = new Store(':memory:')
        try {
            const db = raw(store)
            const a = session(store, 'label')
            store.messages.addMessage(a, { role: 'user', content: { type: 'text', text: 'hello' } })
            const plain = getMessagesByPosition(db, a, 200)
            const labelled = getMessagesByPosition(db, a, 200, undefined, { withRowHash: true })
            expect(plain).toHaveLength(1)
            expect(plain[0]).not.toHaveProperty('rowHash')
            expect(labelled[0].rowHash).toMatch(HASH)
            // The message itself is exactly what it is without the fingerprint.
            const { rowHash, ...message } = labelled[0] as StoredMessage & { rowHash: string }
            expect(message).toEqual(plain[0])
            expect(rowHash).toHaveLength(12)
        } finally {
            store.close()
        }
    })

    it('follow the row: stable while it is, different once anything served changed', () => {
        const store = new Store(':memory:')
        try {
            const db = raw(store)
            const a = session(store, 'follows')
            const first = store.messages.addMessage(a, { role: 'user', content: { type: 'text', text: 'hello' } })
            const second = store.messages.addMessage(a, { role: 'user', content: { type: 'text', text: 'other' } })
            const hashOf = (id: string): string => {
                const row = getMessagesByPosition(db, a, 200, undefined, { withRowHash: true }).find((m) => m.id === id)
                return row?.rowHash ?? ''
            }
            const before = hashOf(first.id)
            expect(hashOf(first.id)).toBe(before)
            expect(hashOf(second.id)).not.toBe(before)

            // Read-state bookkeeping is not part of what a row serves.
            db.prepare('UPDATE messages SET content_revision = 3 WHERE id = ?').run(first.id)
            expect(hashOf(first.id)).toBe(before)

            db.prepare('UPDATE messages SET content = ? WHERE id = ?')
                .run('{"role":"user","content":{"type":"text","text":"merged"}}', first.id)
            const merged = hashOf(first.id)
            expect(merged).not.toBe(before)

            db.prepare("UPDATE messages SET delivery_state = 'indeterminate' WHERE id = ?").run(first.id)
            expect(hashOf(first.id)).not.toBe(merged)

            db.prepare('UPDATE messages SET invoked_at = 12345 WHERE id = ?').run(first.id)
            const invoked = hashOf(first.id)
            db.prepare('UPDATE messages SET seq = 99 WHERE id = ?').run(first.id)
            expect(hashOf(first.id)).not.toBe(invoked)
        } finally {
            store.close()
        }
    })

    it('are offered by the catch-up and queued-row queries too', () => {
        const store = new Store(':memory:')
        try {
            const db = raw(store)
            const a = session(store, 'queries')
            const head = store.messages.addMessage(a, { role: 'user', content: { type: 'text', text: 'head' } })
            store.messages.addMessage(a, { role: 'user', content: { type: 'text', text: 'queued' } }, 'local-1', null)
            const after = { at: head.createdAt, seq: head.seq }

            const plain = getMessagesAfterPosition(db, a, 200, after)
            expect(plain.some((m) => m.rowHash !== undefined)).toBe(false)
            const labelled = getMessagesAfterPosition(db, a, 200, after, undefined, { withRowHash: true })
            expect(labelled.length).toBeGreaterThan(0)
            expect(labelled.every((m) => HASH.test(m.rowHash ?? ''))).toBe(true)

            expect(getUninvokedLocalMessages(db, a).some((m) => m.rowHash !== undefined)).toBe(false)
            const queued = getUninvokedLocalMessages(db, a, { withRowHash: true })
            expect(queued.map((m) => m.localId)).toEqual(['local-1'])
            expect(queued[0].rowHash).toMatch(HASH)
        } finally {
            store.close()
        }
    })
})

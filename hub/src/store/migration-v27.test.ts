import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('schema migration v27 to v28', () => {
    it('adds an index used by the uninvoked-local-message lookup', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v27-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_messages_uninvoked_local;
            PRAGMA user_version = 27;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const plan = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT * FROM messages WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL ORDER BY seq ASC
        `).all('s') as Array<{ detail: string }>
        const deliverablePlan = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT * FROM messages WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL AND delivery_state = 'queued' ORDER BY seq ASC
        `).all('s') as Array<{ detail: string }>

        expect(version.user_version).toBe(29)
        expect(plan.some((row) => row.detail.includes('idx_messages_uninvoked_local'))).toBe(true)
        expect(deliverablePlan.some((row) => row.detail.includes('idx_messages_uninvoked_local'))).toBe(true)
        migrated.close()
    })
})

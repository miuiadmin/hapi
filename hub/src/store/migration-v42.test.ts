import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_VERSION, Store } from './index'
import { BOTS_TABLE_SQL } from './bots'
import { SESSION_RECEIPTS_TABLE_SQL } from './sessionReceipts'

/**
 * v41→v42: bots, their item ledger with its event log, and session receipts.
 * Every path that builds the schema (fresh, the step ladder, the v26 fast
 * path, the legacy chain) must end up with all four tables — and with what
 * the step before added (the session-task history), since this step comes
 * after it on the same ladder.
 */

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function tempDatabasePath(tag: string): string {
    const dir = mkdtempSync(join(tmpdir(), `hapi-migration-${tag}-`))
    tempDirs.push(dir)
    return join(dir, 'hapi.db')
}

const BOT_TABLES = ['bot_item_events', 'bot_items', 'bots', 'session_receipts']

function tables(db: Database, names: readonly string[]): string[] {
    return (db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => '?').join(', ')}) ORDER BY name`
    ).all(...names) as Array<{ name: string }>).map((row) => row.name)
}

function userVersion(db: Database): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
}

/** Take a current database back to the v41 shape: no bots, no ledger, no receipts. */
function downgradeToV41(db: Database): void {
    db.exec(`
        DROP TABLE session_receipts;
        DROP TABLE bot_item_events;
        DROP TABLE bot_items;
        DROP TABLE bots;
        PRAGMA user_version = 41;
    `)
}

/** Back to the v40 shape: also none of the phase-2 task objects (no `start_at`, no run history). */
function downgradeToV40(db: Database): void {
    downgradeToV41(db)
    db.exec(`
        DROP INDEX idx_session_task_runs_session;
        DROP INDEX idx_session_task_runs_recorded;
        DROP TABLE session_task_runs;
        ALTER TABLE session_tasks DROP COLUMN start_at;
        PRAGMA user_version = 40;
    `)
}

/** Back to the v39 shape: no task objects from either later step. */
function downgradeToV39(db: Database): void {
    downgradeToV40(db)
    db.exec(`
        DROP INDEX idx_session_tasks_pending;
        DROP INDEX idx_session_tasks_active_due;
        DROP INDEX idx_session_tasks_session;
        DROP TABLE session_tasks;
        PRAGMA user_version = 39;
    `)
}

/** What both later steps add to the task table, by name. */
const TASK_OBJECTS_AFTER_V39 = [
    'idx_session_task_runs_recorded',
    'idx_session_task_runs_session',
    'idx_session_tasks_active_due',
    'idx_session_tasks_pending',
    'idx_session_tasks_session',
    'session_task_runs',
    'session_tasks'
]

function taskObjects(db: Database): string[] {
    return (db.prepare(
        `SELECT name FROM sqlite_master WHERE tbl_name IN ('session_tasks', 'session_task_runs') AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all() as Array<{ name: string }>).map((row) => row.name)
}

function insertBot(store: Store): { botId: string; itemId: string } {
    const bot = store.bots.insert({
        namespace: 'default', name: 'Ops', purpose: '', machineId: 'm', homeDir: '/h', agent: 'claude',
        model: null, permissionMode: null, state: 'active', now: 1
    })
    const item = store.bots.createItem({
        botId: bot.id, sessionId: 'home', title: 'a', detail: '', status: 'planned', workerSessionId: null, actor: 'bot', now: 1
    })
    return { botId: bot.id, itemId: item.id }
}

describe('schema migration v41 to v42', () => {
    it('adds the four tables to a v41 database — the shape a hub running the task history leaves — and they work', () => {
        const dbPath = tempDatabasePath('v41')
        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        downgradeToV41(legacy)
        expect(tables(legacy, BOT_TABLES)).toEqual([])
        expect(userVersion(legacy)).toBe(41)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(SCHEMA_VERSION)
        expect(tables(internalDb, BOT_TABLES)).toEqual(BOT_TABLES)
        const { botId, itemId } = insertBot(migrated)
        expect(migrated.bots.listEvents(itemId)).toHaveLength(1)
        migrated.sessionReceipts.insert({ childSessionId: 'worker', parentSessionId: 'home', taskLocalId: 't', kind: 'turn_end', now: 1 })
        expect(migrated.sessionReceipts.listUnsettled()).toHaveLength(1)
        // Rows cascade with their bot.
        internalDb.prepare('DELETE FROM bots WHERE id = ?').run(botId)
        expect(migrated.bots.listItems(botId)).toEqual([])
        expect(internalDb.prepare('SELECT COUNT(*) AS n FROM bot_item_events').get()).toEqual({ n: 0 })
        migrated.close()
    })

    it('is idempotent: a database that stopped mid-upgrade runs the step again and keeps its rows', () => {
        const store = new Store(':memory:')
        const { itemId } = insertBot(store)
        const step = (store as unknown as { migrateFromV41ToV42: () => void }).migrateFromV41ToV42.bind(store)
        step()
        step()
        expect(store.bots.listEvents(itemId)).toHaveLength(1)
        const internalDb = (store as unknown as { db: Database }).db
        internalDb.exec(BOTS_TABLE_SQL)
        internalDb.exec(SESSION_RECEIPTS_TABLE_SQL)
        expect(tables(internalDb, BOT_TABLES)).toEqual(BOT_TABLES)
        store.close()
    })

    it('a fresh database has the final shape, including the name rule that lets a failed bot be created again', () => {
        const store = new Store(':memory:')
        const internalDb = (store as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(SCHEMA_VERSION)
        expect(tables(internalDb, BOT_TABLES)).toEqual(BOT_TABLES)
        const index = internalDb.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_bots_live_name'"
        ).get() as { sql: string }
        expect(index.sql).toContain("state NOT IN ('archived', 'failed')")
        store.close()
    })

    it('a v40 database gets the task history first and the bot tables after it', () => {
        const dbPath = tempDatabasePath('v40')
        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        downgradeToV40(legacy)
        expect(columnNames(legacy, 'session_tasks')).not.toContain('start_at')
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(SCHEMA_VERSION)
        expect(tables(internalDb, BOT_TABLES)).toEqual(BOT_TABLES)
        expect(taskObjects(internalDb)).toEqual(TASK_OBJECTS_AFTER_V39)
        expect(columnNames(internalDb, 'session_tasks')).toContain('start_at')
        migrated.close()
    })

    it('a v39 database gets every later step in order', () => {
        const dbPath = tempDatabasePath('v39')
        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        downgradeToV39(legacy)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(SCHEMA_VERSION)
        expect(tables(internalDb, BOT_TABLES)).toEqual(BOT_TABLES)
        expect(taskObjects(internalDb)).toEqual(TASK_OBJECTS_AFTER_V39)
        const sessionId = migrated.sessions.getOrCreateSession('v39', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        expect(migrated.sessionTasks.create({
            sessionId, kind: 'repeat', items: ['ping'], intervalMs: 60_000, maxRuns: null, startAt: 3, nextRunAt: 3
        }).startAt).toBe(3)
        insertBot(migrated)
        migrated.close()
    })

    // Databases older than v26 take the fast path in initSchema, which used to
    // list its steps by hand and stopped one short.
    it('the v26 fast path ends at the final shape too', () => {
        const dbPath = tempDatabasePath('v26')
        const before = new Store(dbPath)
        const session = before.sessions.getOrCreateSession('v26', { path: '/tmp/v26' }, null, 'default').id
        before.close()
        const legacy = new Database(dbPath)
        downgradeToV39(legacy)
        legacy.exec(`
            DROP TABLE session_turns;
            DROP TABLE message_content_search_short;
            DROP TABLE message_content_search_lookup;
            DROP TABLE message_content_search;
            ALTER TABLE messages DROP COLUMN content_revision;
            ALTER TABLE sessions DROP COLUMN manual_unread;
            ALTER TABLE sessions DROP COLUMN read_state_version;
            ALTER TABLE sessions DROP COLUMN read_revision;
            ALTER TABLE sessions DROP COLUMN content_revision;
            ALTER TABLE sessions DROP COLUMN last_user_message_at;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(SCHEMA_VERSION)
        expect(tables(internalDb, BOT_TABLES)).toEqual(BOT_TABLES)
        expect(taskObjects(internalDb)).toEqual(TASK_OBJECTS_AFTER_V39)
        expect(migrated.sessions.getSession(session)?.id).toBe(session)
        insertBot(migrated)
        migrated.close()
    })

    it('the legacy chain (user_version 0 with tables) creates the four tables as well', () => {
        const dbPath = tempDatabasePath('legacy')
        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        downgradeToV39(legacy)
        legacy.exec('PRAGMA user_version = 0;')
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(SCHEMA_VERSION)
        expect(tables(internalDb, BOT_TABLES)).toEqual(BOT_TABLES)
        insertBot(migrated)
        migrated.close()
    })

    it('refuses to come up when a table this build opens is missing, and leaves the version as it found it', () => {
        const dbPath = tempDatabasePath('missing')
        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec('DROP TABLE session_receipts;')
        legacy.close()

        expect(() => new Store(dbPath)).toThrow(/missing required tables \(session_receipts\)/)
        const check = new Database(dbPath)
        expect(userVersion(check)).toBe(SCHEMA_VERSION)
        check.close()
    })
})

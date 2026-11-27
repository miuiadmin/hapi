import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type {
    BotItemAsk,
    BotItemEventActor,
    BotItemEventKind,
    BotItemStatus,
    BotState
} from '@hapi/protocol'
import type { StoredSessionTask } from './sessionTasks'
import { prepareCached } from './statementCache'

/**
 * Bots and their ledger. A bot row marks one session (the home chat) as a
 * bot and says where its home folder is; items are what the bot is
 * delivering or deciding, each with an append-only event log. The hub owns
 * the ledger so every surface (web, phone, later chats) reads the same rows.
 */

export type StoredBot = {
    id: string
    namespace: string
    name: string
    purpose: string
    machineId: string
    homeDir: string
    agent: string
    model: string | null
    permissionMode: string | null
    homeChatSessionId: string | null
    state: BotState
    lastError: string | null
    /** Tasks of the home chat that pausing the bot paused; resumed with it. */
    pausedTasks: PausedTask[]
    createdAt: number
    updatedAt: number
}

/**
 * A task the hub paused on a bot's behalf, with when it was due next before
 * that. On resume only a task the owner has not edited is started again, and
 * it is put back on its schedule rather than run at once. (One the owner
 * resumed by hand and then paused again reads as untouched, and starts again
 * with the bot.)
 */
export type PausedTask = { id: string; fingerprint: string; nextRunAt: number | null }

/**
 * What an edit by hand changes in a task, as one short string to compare
 * later. The scheduler's own bookkeeping on the row is left out on purpose:
 * pausing takes a waiting prompt back, and the agent may take one while the
 * bot is paused; both change the row, and neither is the owner's doing.
 */
export function taskFingerprint(task: Pick<StoredSessionTask, 'kind' | 'items' | 'intervalMs' | 'maxRuns'>): string {
    return createHash('sha256').update(JSON.stringify([task.kind, task.items, task.intervalMs, task.maxRuns])).digest('hex').slice(0, 16)
}

export type StoredBotItem = {
    id: string
    botId: string
    sessionId: string
    number: number
    title: string
    status: BotItemStatus
    detail: string
    ask: BotItemAsk | null
    snoozedUntil: number | null
    workerSessionId: string | null
    createdAt: number
    updatedAt: number
}

export type StoredBotItemEvent = {
    id: number
    itemId: string
    seq: number
    kind: BotItemEventKind
    actor: BotItemEventActor
    text: string
    createdAt: number
}

type DbBotRow = {
    id: string
    namespace: string
    name: string
    purpose: string
    machine_id: string
    home_dir: string
    agent: string
    model: string | null
    permission_mode: string | null
    home_chat_session_id: string | null
    state: string
    last_error: string | null
    paused_tasks: string
    created_at: number
    updated_at: number
}

type DbItemRow = {
    id: string
    bot_id: string
    session_id: string
    number: number
    title: string
    status: string
    detail: string
    ask: string | null
    snoozed_until: number | null
    worker_session_id: string | null
    created_at: number
    updated_at: number
}

type DbEventRow = {
    id: number
    item_id: string
    seq: number
    kind: string
    actor: string
    text: string
    created_at: number
}

const BOT_COLUMNS = `id, namespace, name, purpose, machine_id, home_dir, agent, model, permission_mode,
    home_chat_session_id, state, last_error, paused_tasks, created_at, updated_at`
const ITEM_COLUMNS = `id, bot_id, session_id, number, title, status, detail, ask, snoozed_until, worker_session_id,
    created_at, updated_at`
const EVENT_COLUMNS = 'id, item_id, seq, kind, actor, text, created_at'

export const BOTS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT '',
        machine_id TEXT NOT NULL,
        home_dir TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        permission_mode TEXT,
        home_chat_session_id TEXT,
        state TEXT NOT NULL,
        last_error TEXT,
        paused_tasks TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_home_chat
        ON bots(home_chat_session_id) WHERE home_chat_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_bots_namespace ON bots(namespace, state);
    -- A name identifies a live bot within its namespace, whatever the letter
    -- case. A bot whose creation failed does not hold its name: the owner must
    -- be able to try again under the same name. The index is dropped first:
    -- CREATE INDEX IF NOT EXISTS alone would keep an older definition of it in place.
    DROP INDEX IF EXISTS idx_bots_live_name;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_live_name
        ON bots(namespace, name COLLATE NOCASE) WHERE state NOT IN ('archived', 'failed');

    CREATE TABLE IF NOT EXISTS bot_items (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        ask TEXT,
        snoozed_until INTEGER,
        worker_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
        UNIQUE (bot_id, number)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_items_bot ON bot_items(bot_id, status);
    CREATE INDEX IF NOT EXISTS idx_bot_items_worker ON bot_items(worker_session_id)
        WHERE worker_session_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bot_item_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (item_id) REFERENCES bot_items(id) ON DELETE CASCADE,
        UNIQUE (item_id, seq)
    );
`

function parseAsk(raw: string | null): BotItemAsk | null {
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || typeof parsed.question !== 'string') return null
        return parsed as BotItemAsk
    } catch {
        return null
    }
}

function parsePausedTasks(raw: string | null): PausedTask[] {
    try {
        const parsed: unknown = JSON.parse(raw ?? '[]')
        if (!Array.isArray(parsed)) return []
        return parsed.flatMap((entry): PausedTask[] => {
            if (!entry || typeof entry !== 'object') return []
            const { id, fingerprint, nextRunAt } = entry as { id?: unknown; fingerprint?: unknown; nextRunAt?: unknown }
            return typeof id === 'string' && typeof fingerprint === 'string' && (nextRunAt === null || typeof nextRunAt === 'number')
                ? [{ id, fingerprint, nextRunAt }]
                : []
        })
    } catch {
        return []
    }
}

export function toBot(row: DbBotRow): StoredBot {
    return {
        id: row.id,
        namespace: row.namespace,
        name: row.name,
        purpose: row.purpose,
        machineId: row.machine_id,
        homeDir: row.home_dir,
        agent: row.agent,
        model: row.model,
        permissionMode: row.permission_mode,
        homeChatSessionId: row.home_chat_session_id,
        state: row.state as BotState,
        lastError: row.last_error,
        pausedTasks: parsePausedTasks(row.paused_tasks),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

export function toBotItem(row: DbItemRow): StoredBotItem {
    return {
        id: row.id,
        botId: row.bot_id,
        sessionId: row.session_id,
        number: row.number,
        title: row.title,
        status: row.status as BotItemStatus,
        detail: row.detail,
        ask: parseAsk(row.ask),
        snoozedUntil: row.snoozed_until,
        workerSessionId: row.worker_session_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

function toBotItemEvent(row: DbEventRow): StoredBotItemEvent {
    return {
        id: row.id,
        itemId: row.item_id,
        seq: row.seq,
        kind: row.kind as BotItemEventKind,
        actor: row.actor as BotItemEventActor,
        text: row.text,
        createdAt: row.created_at
    }
}

export type BotPatch = {
    purpose?: string
    machineId?: string
    homeDir?: string
    agent?: string
    model?: string | null
    permissionMode?: string | null
    homeChatSessionId?: string | null
    state?: BotState
    lastError?: string | null
    pausedTasks?: PausedTask[]
}

export type BotItemPatch = {
    title?: string
    detail?: string
    status?: BotItemStatus
    ask?: BotItemAsk | null
    snoozedUntil?: number | null
    workerSessionId?: string | null
}

export class BotStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    // ---- bots ---------------------------------------------------------------

    private botById(id: string): DbBotRow | undefined {
        return prepareCached(this.db, `SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`).get(id) as DbBotRow | undefined
    }

    get(id: string): StoredBot | null {
        const row = this.botById(id)
        return row ? toBot(row) : null
    }

    getByHomeChat(sessionId: string): StoredBot | null {
        const row = prepareCached(this.db,
            `SELECT ${BOT_COLUMNS} FROM bots WHERE home_chat_session_id = ? AND state != 'archived'`
        ).get(sessionId) as DbBotRow | undefined
        return row ? toBot(row) : null
    }

    /** Bots that are not archived, newest first. */
    list(namespace: string): StoredBot[] {
        const rows = prepareCached(this.db,
            `SELECT ${BOT_COLUMNS} FROM bots WHERE namespace = ? AND state != 'archived' ORDER BY created_at DESC`
        ).all(namespace) as DbBotRow[]
        return rows.map(toBot)
    }

    /** Every bot that is not archived, across namespaces (a handful; used to route worker events). */
    listLive(): StoredBot[] {
        const rows = prepareCached(this.db,
            `SELECT ${BOT_COLUMNS} FROM bots WHERE state != 'archived' ORDER BY created_at DESC`
        ).all() as DbBotRow[]
        return rows.map(toBot)
    }

    insert(bot: {
        namespace: string
        name: string
        purpose: string
        machineId: string
        homeDir: string
        agent: string
        model: string | null
        permissionMode: string | null
        state: BotState
        now: number
    }): StoredBot {
        const id = randomUUID()
        prepareCached(this.db,
            `INSERT INTO bots
                (id, namespace, name, purpose, machine_id, home_dir, agent, model, permission_mode,
                 home_chat_session_id, state, last_error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`
        ).run(
            id, bot.namespace, bot.name, bot.purpose, bot.machineId, bot.homeDir, bot.agent,
            bot.model, bot.permissionMode, bot.state, bot.now, bot.now
        )
        const created = this.botById(id)
        if (!created) throw new Error('bot row missing after insert')
        return toBot(created)
    }

    update(id: string, patch: BotPatch, now: number): StoredBot | null {
        const sets: string[] = []
        const values: unknown[] = []
        const assign = (column: string, value: unknown) => {
            sets.push(`${column} = ?`)
            values.push(value)
        }
        if (patch.purpose !== undefined) assign('purpose', patch.purpose)
        if (patch.machineId !== undefined) assign('machine_id', patch.machineId)
        if (patch.homeDir !== undefined) assign('home_dir', patch.homeDir)
        if (patch.agent !== undefined) assign('agent', patch.agent)
        if (patch.model !== undefined) assign('model', patch.model)
        if (patch.permissionMode !== undefined) assign('permission_mode', patch.permissionMode)
        if (patch.homeChatSessionId !== undefined) assign('home_chat_session_id', patch.homeChatSessionId)
        if (patch.state !== undefined) assign('state', patch.state)
        if (patch.lastError !== undefined) assign('last_error', patch.lastError)
        if (patch.pausedTasks !== undefined) assign('paused_tasks', JSON.stringify(patch.pausedTasks))
        if (sets.length === 0) return this.get(id)
        sets.push('updated_at = ?')
        values.push(now, id)
        prepareCached(this.db, `UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...values)
        return this.get(id)
    }

    /**
     * A creation that never finished (the hub restarted while it was under
     * way) must not stay `creating` forever: nothing would ever complete it,
     * and until something does its name is taken. Marks every `creating` bot
     * last touched before `cutoff` as failed and returns them.
     */
    failStaleCreating(cutoff: number, message: string, now: number): StoredBot[] {
        const stale = prepareCached(this.db,
            `SELECT ${BOT_COLUMNS} FROM bots WHERE state = 'creating' AND updated_at < ?`
        ).all(cutoff) as DbBotRow[]
        for (const row of stale) {
            prepareCached(this.db,
                `UPDATE bots SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND state = 'creating'`
            ).run(message, now, row.id)
        }
        return stale.map((row) => this.get(row.id)).filter((bot): bot is StoredBot => bot !== null)
    }

    /**
     * A merged-away session's ledger follows it to the surviving row: the
     * bot whose home chat it was (unless the survivor is already one), the
     * chat that owns its items, and workers attached to items.
     */
    followMergedSession(fromSessionId: string, toSessionId: string, now: number): void {
        // The home-chat index is unique: leave the bot alone when any row already names the survivor.
        const taken = prepareCached(this.db,
            `SELECT 1 AS one FROM bots WHERE home_chat_session_id = ? LIMIT 1`
        ).get(toSessionId) as { one: number } | undefined
        if (!taken) {
            prepareCached(this.db,
                `UPDATE bots SET home_chat_session_id = ?, updated_at = ? WHERE home_chat_session_id = ?`
            ).run(toSessionId, now, fromSessionId)
        }
        prepareCached(this.db,
            `UPDATE bot_items SET session_id = ?, updated_at = ? WHERE session_id = ?`
        ).run(toSessionId, now, fromSessionId)
        prepareCached(this.db,
            `UPDATE bot_items SET worker_session_id = ?, updated_at = ? WHERE worker_session_id = ?`
        ).run(toSessionId, now, fromSessionId)
    }

    // ---- items --------------------------------------------------------------

    private itemById(id: string): DbItemRow | undefined {
        return prepareCached(this.db, `SELECT ${ITEM_COLUMNS} FROM bot_items WHERE id = ?`).get(id) as DbItemRow | undefined
    }

    getItemById(id: string): StoredBotItem | null {
        const row = this.itemById(id)
        return row ? toBotItem(row) : null
    }

    /** Scoped read: an item resolves only inside its own bot, by id or by number (`3` or `#3`). */
    getItem(botId: string, idOrNumber: string): StoredBotItem | null {
        const key = idOrNumber.trim()
        const asNumber = /^#?(\d+)$/.exec(key)
        const row = asNumber
            ? prepareCached(this.db,
                `SELECT ${ITEM_COLUMNS} FROM bot_items WHERE bot_id = ? AND number = ?`
            ).get(botId, Number(asNumber[1])) as DbItemRow | undefined
            : prepareCached(this.db,
                `SELECT ${ITEM_COLUMNS} FROM bot_items WHERE bot_id = ? AND id = ?`
            ).get(botId, key) as DbItemRow | undefined
        return row ? toBotItem(row) : null
    }

    listItems(botId: string): StoredBotItem[] {
        const rows = prepareCached(this.db,
            `SELECT ${ITEM_COLUMNS} FROM bot_items WHERE bot_id = ? ORDER BY number ASC`
        ).all(botId) as DbItemRow[]
        return rows.map(toBotItem)
    }

    /** Items not done and not canceled, the ones a bot panel shows as live. */
    listOpenItems(botId: string): StoredBotItem[] {
        const rows = prepareCached(this.db,
            `SELECT ${ITEM_COLUMNS} FROM bot_items
             WHERE bot_id = ? AND status IN ('planned', 'working', 'waiting', 'needs_you') ORDER BY number ASC`
        ).all(botId) as DbItemRow[]
        return rows.map(toBotItem)
    }

    listItemsForWorker(sessionId: string): StoredBotItem[] {
        const rows = prepareCached(this.db,
            `SELECT ${ITEM_COLUMNS} FROM bot_items
             WHERE worker_session_id = ? AND status IN ('planned', 'working', 'waiting', 'needs_you')`
        ).all(sessionId) as DbItemRow[]
        return rows.map(toBotItem)
    }

    countOpenItems(botId: string): number {
        const row = prepareCached(this.db,
            `SELECT COUNT(*) AS n FROM bot_items
             WHERE bot_id = ? AND status IN ('planned', 'working', 'waiting', 'needs_you')`
        ).get(botId) as { n: number }
        return row.n
    }

    countAllItems(botId: string): number {
        const row = prepareCached(this.db, `SELECT COUNT(*) AS n FROM bot_items WHERE bot_id = ?`).get(botId) as { n: number }
        return row.n
    }

    createItem(input: {
        botId: string
        sessionId: string
        title: string
        detail: string
        status: BotItemStatus
        workerSessionId: string | null
        /** Who created it; recorded on the `created` event. */
        actor: BotItemEventActor
        now: number
    }): StoredBotItem {
        const id = randomUUID()
        const run = this.db.transaction(() => {
            const last = prepareCached(this.db,
                `SELECT MAX(number) AS n FROM bot_items WHERE bot_id = ?`
            ).get(input.botId) as { n: number | null }
            const number = (last.n ?? 0) + 1
            prepareCached(this.db,
                `INSERT INTO bot_items
                    (id, bot_id, session_id, number, title, status, detail, ask, snoozed_until,
                     worker_session_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
            ).run(
                id, input.botId, input.sessionId, number, input.title, input.status, input.detail,
                input.workerSessionId, input.now, input.now
            )
            this.insertEvent(id, 'created', input.actor, '', input.now)
            return id
        })
        const insertedId = run()
        const created = this.itemById(insertedId)
        if (!created) throw new Error('bot item row missing after insert')
        return toBotItem(created)
    }

    private insertEvent(itemId: string, kind: BotItemEventKind, actor: BotItemEventActor, text: string, now: number): void {
        const last = prepareCached(this.db,
            `SELECT MAX(seq) AS s FROM bot_item_events WHERE item_id = ?`
        ).get(itemId) as { s: number | null }
        prepareCached(this.db,
            `INSERT INTO bot_item_events (item_id, seq, kind, actor, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(itemId, (last.s ?? 0) + 1, kind, actor, text, now)
    }

    /**
     * Change an item and record one event in the same transaction. Null when
     * the item does not exist.
     */
    mutateItem(
        id: string,
        patch: BotItemPatch,
        event: { kind: BotItemEventKind; actor: BotItemEventActor; text: string },
        now: number
    ): StoredBotItem | null {
        const changed = this.db.transaction(() => {
            const current = this.itemById(id)
            if (!current) return false
            prepareCached(this.db,
                `UPDATE bot_items SET
                    title = ?, detail = ?, status = ?, ask = ?, snoozed_until = ?, worker_session_id = ?,
                    updated_at = ?
                 WHERE id = ?`
            ).run(
                patch.title ?? current.title,
                patch.detail ?? current.detail,
                patch.status ?? current.status,
                patch.ask === undefined ? current.ask : (patch.ask === null ? null : JSON.stringify(patch.ask)),
                patch.snoozedUntil === undefined ? current.snoozed_until : patch.snoozedUntil,
                patch.workerSessionId === undefined ? current.worker_session_id : patch.workerSessionId,
                now,
                id
            )
            this.insertEvent(id, event.kind, event.actor, event.text, now)
            return true
        })()
        if (!changed) return null
        const updated = this.itemById(id)
        return updated ? toBotItem(updated) : null
    }

    appendEvent(
        itemId: string,
        event: { kind: BotItemEventKind; actor: BotItemEventActor; text: string },
        now: number
    ): StoredBotItemEvent | null {
        this.insertEvent(itemId, event.kind, event.actor, event.text, now)
        const row = prepareCached(this.db,
            `SELECT ${EVENT_COLUMNS} FROM bot_item_events WHERE item_id = ? ORDER BY seq DESC LIMIT 1`
        ).get(itemId) as DbEventRow | undefined
        return row ? toBotItemEvent(row) : null
    }

    /** Oldest first, bounded to the most recent `limit` events. */
    listEvents(itemId: string, limit: number = 200): StoredBotItemEvent[] {
        const rows = prepareCached(this.db,
            `SELECT ${EVENT_COLUMNS} FROM (
                SELECT ${EVENT_COLUMNS} FROM bot_item_events WHERE item_id = ? ORDER BY seq DESC LIMIT ?
             ) ORDER BY seq ASC`
        ).all(itemId, limit) as DbEventRow[]
        return rows.map(toBotItemEvent)
    }
}

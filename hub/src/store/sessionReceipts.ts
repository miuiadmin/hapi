import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { SessionReceipt, SessionReceiptKind, SessionReceiptState } from '@hapi/protocol'
import { prepareCached } from './statementCache'

/**
 * Receipts: "when this session's turn ends, post its reply back into that
 * one". Registered by the session that sent the message (ping_peer /
 * spawn_peer with `replyVia: 'hub'`), kept by the hub until delivered, so
 * the reply survives the sender's process exiting, a runner restart and a
 * hub restart. The hub owns the waiting; nothing here polls the model.
 */

export type StoredSessionReceipt = {
    id: string
    childSessionId: string
    parentSessionId: string
    taskLocalId: string
    kind: SessionReceiptKind
    state: SessionReceiptState
    createdAt: number
    deliveredAt: number | null
}

type DbReceiptRow = {
    id: string
    child_session_id: string
    parent_session_id: string
    task_local_id: string
    kind: string
    state: string
    created_at: number
    delivered_at: number | null
}

const RECEIPT_COLUMNS = 'id, child_session_id, parent_session_id, task_local_id, kind, state, created_at, delivered_at'

/** How long after a reply went out a second registration for the same message is treated as a retry of the first. */
export const REREGISTER_WINDOW_MS = 60 * 60_000

export const SESSION_RECEIPTS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS session_receipts (
        id TEXT PRIMARY KEY,
        child_session_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        task_local_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_session_receipts_child
        ON session_receipts(child_session_id, state);
    CREATE INDEX IF NOT EXISTS idx_session_receipts_parent
        ON session_receipts(parent_session_id, state);
`

export function toSessionReceipt(row: DbReceiptRow): SessionReceipt {
    return {
        id: row.id,
        childSessionId: row.child_session_id,
        parentSessionId: row.parent_session_id,
        taskLocalId: row.task_local_id,
        kind: row.kind as SessionReceiptKind,
        state: row.state as SessionReceiptState,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at
    }
}

export class SessionReceiptStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    private byId(id: string): DbReceiptRow | undefined {
        return prepareCached(this.db,
            `SELECT ${RECEIPT_COLUMNS} FROM session_receipts WHERE id = ?`
        ).get(id) as DbReceiptRow | undefined
    }

    get(id: string): StoredSessionReceipt | null {
        const row = this.byId(id)
        return row ? toSessionReceipt(row) : null
    }

    /**
     * The receipt already answering the same message, if it still stands:
     * one that is waiting or being delivered, or one delivered a moment ago
     * (a registration retried after a lost response must not start a second
     * reply for the same message).
     */
    findLive(childSessionId: string, parentSessionId: string, taskLocalId: string, now: number): StoredSessionReceipt | null {
        const row = prepareCached(this.db,
            `SELECT ${RECEIPT_COLUMNS} FROM session_receipts
             WHERE child_session_id = ? AND parent_session_id = ? AND task_local_id = ?
               AND (
                   state IN ('pending', 'delivering')
                   OR (state = 'delivered' AND delivered_at >= ?)
               )
             ORDER BY created_at DESC LIMIT 1`
        ).get(childSessionId, parentSessionId, taskLocalId, now - REREGISTER_WINDOW_MS) as DbReceiptRow | undefined
        return row ? toSessionReceipt(row) : null
    }

    insert(input: {
        childSessionId: string
        parentSessionId: string
        taskLocalId: string
        kind: SessionReceiptKind
        now: number
    }): StoredSessionReceipt {
        const id = randomUUID()
        prepareCached(this.db,
            `INSERT INTO session_receipts
                (id, child_session_id, parent_session_id, task_local_id, kind, state, created_at, delivered_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`
        ).run(id, input.childSessionId, input.parentSessionId, input.taskLocalId, input.kind, input.now)
        const created = this.byId(id)
        if (!created) throw new Error('session receipt row missing after insert')
        return toSessionReceipt(created)
    }

    listPendingForChild(childSessionId: string): StoredSessionReceipt[] {
        const rows = prepareCached(this.db,
            `SELECT ${RECEIPT_COLUMNS} FROM session_receipts
             WHERE child_session_id = ? AND state = 'pending' ORDER BY created_at ASC`
        ).all(childSessionId) as DbReceiptRow[]
        return rows.map(toSessionReceipt)
    }

    listPendingForParent(parentSessionId: string): StoredSessionReceipt[] {
        const rows = prepareCached(this.db,
            `SELECT ${RECEIPT_COLUMNS} FROM session_receipts
             WHERE parent_session_id = ? AND state = 'pending' ORDER BY created_at ASC`
        ).all(parentSessionId) as DbReceiptRow[]
        return rows.map(toSessionReceipt)
    }

    /**
     * Every receipt not settled yet, waiting or mid-delivery; read once at
     * hub start. A row left in `delivering` belongs to a process that died
     * while sending, so the start-up sweep has to see it to settle it.
     */
    listUnsettled(): StoredSessionReceipt[] {
        const rows = prepareCached(this.db,
            `SELECT ${RECEIPT_COLUMNS} FROM session_receipts WHERE state IN ('pending', 'delivering') ORDER BY created_at ASC`
        ).all() as DbReceiptRow[]
        return rows.map(toSessionReceipt)
    }

    /** Children a parent is still waiting on, newest first. */
    listPendingChildSessions(parentSessionId: string): string[] {
        const rows = prepareCached(this.db,
            `SELECT child_session_id FROM session_receipts
             WHERE parent_session_id = ? AND state IN ('pending', 'delivering') ORDER BY created_at DESC`
        ).all(parentSessionId) as Array<{ child_session_id: string }>
        return rows.map((row) => row.child_session_id)
    }

    /** Sessions still waiting on this child. */
    listPendingParentSessions(childSessionId: string): string[] {
        const rows = prepareCached(this.db,
            `SELECT DISTINCT parent_session_id FROM session_receipts
             WHERE child_session_id = ? AND state IN ('pending', 'delivering')`
        ).all(childSessionId) as Array<{ parent_session_id: string }>
        return rows.map((row) => row.parent_session_id)
    }

    /** Compare-and-set out of `pending`: two racing triggers deliver once. */
    claim(id: string): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_receipts SET state = 'delivering' WHERE id = ? AND state = 'pending'`
        ).run(id)
        return result.changes > 0
    }

    /** Give a claimed receipt back, e.g. the parent's machine is offline. */
    release(id: string): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_receipts SET state = 'pending' WHERE id = ? AND state = 'delivering'`
        ).run(id)
        return result.changes > 0
    }

    markDelivered(id: string, now: number): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_receipts SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'delivering'`
        ).run(now, id)
        return result.changes > 0
    }

    /**
     * Record that the reply went out, from whichever unsettled state the row
     * is in: for a previous attempt that persisted the message and then died
     * or failed before recording it (the message itself is the proof).
     */
    settleDelivered(id: string, now: number): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_receipts SET state = 'delivered', delivered_at = ? WHERE id = ? AND state IN ('pending', 'delivering')`
        ).run(now, id)
        return result.changes > 0
    }

    /** Settle without a message (parent gone, or waited too long). */
    markUndeliverable(id: string, state: 'failed' | 'expired', now: number): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_receipts SET state = ?, delivered_at = ? WHERE id = ? AND state IN ('pending', 'delivering')`
        ).run(state, now, id)
        return result.changes > 0
    }

    /** Drop receipts that were settled long ago. */
    deleteSettledBefore(cutoff: number): number {
        const result = prepareCached(this.db,
            `DELETE FROM session_receipts WHERE state IN ('delivered', 'failed', 'expired') AND created_at < ?`
        ).run(cutoff)
        return result.changes
    }

    /** A merged-away session's receipts follow it to the surviving row. */
    transfer(fromSessionId: string, toSessionId: string): number {
        const child = prepareCached(this.db,
            `UPDATE session_receipts SET child_session_id = ? WHERE child_session_id = ?`
        ).run(toSessionId, fromSessionId)
        const parent = prepareCached(this.db,
            `UPDATE session_receipts SET parent_session_id = ? WHERE parent_session_id = ?`
        ).run(toSessionId, fromSessionId)
        return child.changes + parent.changes
    }
}

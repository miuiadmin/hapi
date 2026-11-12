import type { Database } from 'bun:sqlite'

import { getTextSnapshotStreamId } from '@hapi/protocol/messages'

import { prepareCached } from './statementCache'
import { decodeMessageContent } from './contentCodec'

/**
 * One-time backfill for the text-stream snapshot rows the hub used to keep
 * forever (see deleteLiveTextSnapshots for the runtime fix).
 *
 * Before the runtime sweep existed, the CLI's idle text flushes landed as one
 * stored row per typing pause: each carried the full text-so-far under a
 * stable `streamSnapshot` id, and the boundary's settled row — same id, no
 * `live` marker — never cleaned them up. Those stale prefixes are pure
 * bloat: they inflate every transcript page and every pagination payload for
 * a session, which is exactly the "opening a large session freezes the UI"
 * profile. Rows written before the fix carry no `live` marker at all, so the
 * runtime live-only sweep cannot see them; this backfill recognizes any
 * `streamSnapshot` row of a stream (getTextSnapshotStreamId) and keeps only
 * the newest row per (session, streamId) — the boundary's settled row is
 * always the newest of its stream, so the final text always survives.
 *
 * Idempotent and crash-safe: deletions key on row ids, the completion marker
 * is written only after a full pass, and a crash simply re-runs the pass on
 * the next start.
 */

const BACKFILL_MARKER = 'text-snapshot-sweep-v1'

/** Rows decoded per scan chunk; keeps each synchronous burst short. */
const SCAN_BATCH_ROWS = 500
/** Row ids deleted per transaction; keeps each delete commit bounded. */
const DELETE_BATCH_IDS = 500

export type TextSnapshotBackfillStats = {
    /** Message rows read and decoded during the scan. */
    scannedRows: number
    /** Rows that belonged to a text stream (snapshot or settled). */
    candidateRows: number
    /** Distinct (session, streamId) groups that had stale rows removed. */
    cleanedStreams: number
    deletedRows: number
    deletedBytes: number
}

type StreamGroup = {
    sessionId: string
    /** seq of the newest row seen for the stream (the keeper). */
    keepSeq: number
    keepRowId: string
    staleRowIds: string[]
}

function rowByteLength(content: string | Uint8Array): number {
    return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength
}

export function isTextSnapshotBackfillDone(db: Database): boolean {
    return Boolean(
        prepareCached(db, 'SELECT 1 FROM store_maintenance WHERE name = ?').get(BACKFILL_MARKER)
    )
}

export function markTextSnapshotBackfillDone(db: Database): void {
    prepareCached(db, 'INSERT INTO store_maintenance (name, completed_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING')
        .run(BACKFILL_MARKER, Date.now())
}

/**
 * Scan every message row once, group stream rows by (session_id, streamId),
 * and delete every group member except the newest. Runs in batches with an
 * `await` between chunks so the hub's event loop keeps serving traffic while
 * a large transcript set is walked.
 */
export async function runTextSnapshotBackfill(db: Database): Promise<TextSnapshotBackfillStats | null> {
    if (isTextSnapshotBackfillDone(db)) return null

    const stats: TextSnapshotBackfillStats = {
        scannedRows: 0,
        candidateRows: 0,
        cleanedStreams: 0,
        deletedRows: 0,
        deletedBytes: 0
    }
    const groups = new Map<string, StreamGroup>()
    const scan = prepareCached(db,
        'SELECT rowid, id, session_id, seq, content FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?'
    )

    let cursor = 0
    for (;;) {
        const rows = scan.all(cursor, SCAN_BATCH_ROWS) as Array<{
            rowid: number
            id: string
            session_id: string
            seq: number
            content: string | Uint8Array
        }>
        if (rows.length === 0) break
        for (const row of rows) {
            cursor = row.rowid
            const streamId = getTextSnapshotStreamId(decodeMessageContent(row.content))
            if (streamId === null) continue
            stats.candidateRows += 1
            const key = `${row.session_id}\u0000${streamId}`
            const group = groups.get(key)
            if (!group) {
                groups.set(key, {
                    sessionId: row.session_id,
                    keepSeq: row.seq,
                    keepRowId: row.id,
                    staleRowIds: []
                })
                continue
            }
            // rowid order follows insertion order, so a later row of the same
            // stream supersedes an earlier keeper.
            group.staleRowIds.push(group.keepRowId)
            group.keepRowId = row.id
            group.keepSeq = row.seq
        }
        stats.scannedRows += rows.length
        // Yield between scan chunks so the sweep never monopolizes a tick.
        await new Promise(resolve => setImmediate(resolve))
    }

    // Byte accounting reads each stale row's stored content once, before any
    // deletion makes it unreadable.
    const contentSize = new Map<string, number>()
    for (const group of groups.values()) {
        for (const id of group.staleRowIds) {
            const row = prepareCached(db, 'SELECT content FROM messages WHERE id = ?').get(id) as { content: string | Uint8Array } | undefined
            if (row) contentSize.set(id, rowByteLength(row.content))
        }
    }

    for (const group of groups.values()) {
        for (let offset = 0; offset < group.staleRowIds.length; offset += DELETE_BATCH_IDS) {
            const batch = group.staleRowIds.slice(offset, offset + DELETE_BATCH_IDS)
            const bytes = batch.reduce((sum, id) => sum + (contentSize.get(id) ?? 0), 0)
            const changes = db.transaction(() => {
                const placeholders = batch.map(() => '?').join(', ')
                return prepareCached(db,
                    `DELETE FROM messages WHERE session_id = ? AND id IN (${placeholders})`
                ).run(group.sessionId, ...batch).changes
            })()
            stats.deletedRows += changes
            stats.deletedBytes += changes === batch.length ? bytes : 0
        }
        if (group.staleRowIds.length > 0) stats.cleanedStreams += 1
        // Yield between delete batches as well.
        await new Promise(resolve => setImmediate(resolve))
    }

    markTextSnapshotBackfillDone(db)
    return stats
}

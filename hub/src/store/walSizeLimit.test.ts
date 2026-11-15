import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from './index'

/**
 * The Store connection sets `PRAGMA journal_size_limit = 0` so the -wal
 * sidecar is truncated back to zero bytes after each checkpoint. With the
 * SQLite default (-1) the file only ever keeps its historical high-water
 * size on disk, which reads as "the WAL keeps growing" between restarts.
 */
describe('WAL journal size limit', () => {
    it('truncates the -wal sidecar to zero after a passive checkpoint', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-wal-limit-'))
        try {
            const dbPath = join(dir, 'wal-limit.db')
            const store = new Store(dbPath)
            const db: Database = (store as unknown as { db: Database }).db

            try {
                expect(db.prepare('PRAGMA journal_size_limit').get()).toEqual({ journal_size_limit: 0 })

                // Grow the WAL past 1 MiB but stay under the autocheckpoint
                // threshold (1000 pages ≈ 4 MiB) so the truncation below is
                // attributable to the explicit checkpoint, not an automatic one.
                db.exec('CREATE TABLE wal_growth (id INTEGER PRIMARY KEY, payload BLOB)')
                const insert = db.prepare('INSERT INTO wal_growth (payload) VALUES (?)')
                const chunk = new Uint8Array(64 * 1024).fill(65)
                db.transaction(() => {
                    for (let i = 0; i < 40; i += 1) {
                        insert.run(chunk)
                    }
                })()

                const walPath = `${dbPath}-wal`
                expect(statSync(walPath).size).toBeGreaterThan(1024 * 1024)

                // A PASSIVE checkpoint only backfills frames; SQLite applies
                // the size limit when the WAL is reset — i.e. on the first
                // write after a fully backfilled WAL (or a wrap at EOF). That
                // write truncates the sidecar to the limit (0) and then
                // appends its own frames, so the file collapses from >1 MiB
                // to a couple of frames instead of keeping the high-water
                // size forever (the default limit -1 behavior).
                db.exec('PRAGMA wal_checkpoint(PASSIVE)')
                db.exec("INSERT INTO wal_growth (id, payload) VALUES (1000, x'00')")
                expect(statSync(walPath).size).toBeLessThan(16 * 1024)

                db.exec('PRAGMA wal_checkpoint(RESTART)')
                db.exec("INSERT INTO wal_growth (id, payload) VALUES (1001, x'00')")
                expect(statSync(walPath).size).toBeLessThan(16 * 1024)
            } finally {
                store.close()
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

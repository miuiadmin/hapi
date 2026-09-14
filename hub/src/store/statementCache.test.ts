import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { prepareCached } from './statementCache'

describe('prepareCached', () => {
    it('reuses one Statement instance per (db, sql) and keeps it bindable', () => {
        const db = new Database(':memory:')
        db.exec('CREATE TABLE t (id TEXT)')

        const first = prepareCached(db, 'SELECT COUNT(*) AS n FROM t WHERE id = ?')
        const second = prepareCached(db, 'SELECT COUNT(*) AS n FROM t WHERE id = ?')
        expect(second).toBe(first)

        expect((first.get('x') as { n: number }).n).toBe(0)
        db.exec("INSERT INTO t VALUES ('x')")
        expect((second.get('x') as { n: number }).n).toBe(1)
        expect((prepareCached(db, 'SELECT COUNT(*) AS n FROM t WHERE id = ?').get('x') as { n: number }).n).toBe(1)
        db.close()
    })

    it('caches per Database instance', () => {
        const db1 = new Database(':memory:')
        const db2 = new Database(':memory:')
        for (const db of [db1, db2]) db.exec('CREATE TABLE t (id TEXT)')

        expect(prepareCached(db1, 'SELECT COUNT(*) FROM t')).not.toBe(prepareCached(db2, 'SELECT COUNT(*) FROM t'))
        db1.close()
        db2.close()
    })

    it('does not share statements across distinct sql on the same db', () => {
        const db = new Database(':memory:')
        db.exec('CREATE TABLE t (id TEXT)')
        expect(prepareCached(db, 'SELECT COUNT(*) FROM t')).not.toBe(prepareCached(db, 'SELECT id FROM t'))
        db.close()
    })
})

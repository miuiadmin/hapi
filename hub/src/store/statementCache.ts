import type { Database, Statement } from 'bun:sqlite'

// Prepared-statement cache keyed by Database instance, then SQL text.
//
// bun:sqlite compiles a fresh Statement on every `db.prepare()` call. The
// hub's per-socket-event paths (session access resolution, message ingest,
// consumed/steer acks) invoke the same handful of statements dozens of times
// per second per connected CLI, and SQL recompilation dominated the hub's CPU
// profile under sustained event traffic. Statements are re-bindable on every
// get/run/all call, so a cached statement is semantically identical to an
// inline prepare as long as callers fully drain each call before the next
// (true for every sync store helper; `Statement.iterate()` callers keep
// preparing inline because they `finalize()` their statement).
//
// Keyed weakly so a reopened/replaced Database drops its statements with it.
const statementsByDb = new WeakMap<Database, Map<string, Statement>>()

export function prepareCached(db: Database, sql: string): Statement {
    let bySql = statementsByDb.get(db)
    if (!bySql) {
        bySql = new Map()
        statementsByDb.set(db, bySql)
    }
    let statement = bySql.get(sql)
    if (!statement) {
        statement = db.prepare(sql)
        bySql.set(sql, statement)
    }
    return statement
}

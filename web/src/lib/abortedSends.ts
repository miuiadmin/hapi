/**
 * Sends the user cancelled while their POST was still on the wire.
 *
 * Cancelling a row the hub has already echoed is one DELETE. Cancelling one that is still in
 * flight can only stop the request on this device: the hub may already be holding the bytes and
 * insert the row a moment later, and the echo then shows a message the user has already cancelled.
 * Such a send is remembered here until its fate is known:
 *
 *  - while it is remembered, the thread's waiting bubble and the queue panel leave its rows out;
 *  - when the hub's row turns up (still waiting for the agent) it is cancelled for real, and when
 *    it turns up already taken it is a sent message like any other (see useAbortedSendReconciler);
 *  - an entry that nothing resolved is dropped after ABORTED_SEND_MAX_AGE_MS.
 *
 * Entries outlive a page reload, so a cancel followed by closing the tab still takes effect.
 */
const STORAGE_KEY = 'hapi:aborted-sends:v1'
export const ABORTED_SEND_MAX_AGE_MS = 10 * 60_000

export type AbortedSend = { sessionId: string; localId: string; at: number }

let cache: AbortedSend[] | null = null
/** Moved whenever the remembered set changes in a way a view can see; views subscribe to it. */
let version = 0
const listeners = new Set<() => void>()

function changed(): void {
    version += 1
    for (const listener of [...listeners]) listener()
}

function isEntry(value: unknown): value is AbortedSend {
    if (!value || typeof value !== 'object') return false
    const entry = value as Partial<AbortedSend>
    return typeof entry.sessionId === 'string'
        && typeof entry.localId === 'string'
        && typeof entry.at === 'number'
        && Number.isFinite(entry.at)
}

function storage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
        // Storage can throw as a whole (blocked third-party context).
        return null
    }
}

function load(): AbortedSend[] {
    if (cache) return cache
    let stored: unknown = null
    try {
        stored = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]')
    } catch {
        stored = null
    }
    cache = Array.isArray(stored) ? stored.filter(isEntry) : []
    return cache
}

function write(entries: AbortedSend[]): void {
    cache = entries
    try {
        storage()?.setItem(STORAGE_KEY, JSON.stringify(entries))
    } catch {
        // Full or blocked storage: the entries still work for this page.
    }
}

function key(sessionId: string, localId: string): string {
    return `${sessionId}\u0000${localId}`
}

function expired(entry: AbortedSend, now: number): boolean {
    return now - entry.at > ABORTED_SEND_MAX_AGE_MS
}

/** Remember a send cancelled in flight. Saying it again for the same send only refreshes its time. */
export function markSendAborted(sessionId: string, localId: string): void {
    const now = Date.now()
    const before = load()
    const entries = before.filter((entry) => !expired(entry, now))
    const id = key(sessionId, localId)
    const index = entries.findIndex((entry) => key(entry.sessionId, entry.localId) === id)
    const entry: AbortedSend = { sessionId, localId, at: now }
    if (index === -1) entries.push(entry)
    else entries[index] = entry
    // Rows follow the remembered set: adding an entry hides its rows, and so does an entry leaving.
    if (index === -1 || entries.length !== before.length) changed()
    write(entries)
}

/**
 * Whether a send is remembered as cancelled in flight for this session, and not too old to matter.
 * Reads only: it runs while a view renders.
 */
export function isSendAborted(sessionId: string, localId: string | null | undefined): boolean {
    if (!localId) return false
    const id = key(sessionId, localId)
    const now = Date.now()
    return load().some((entry) => key(entry.sessionId, entry.localId) === id && !expired(entry, now))
}

/** Its fate is settled (cancelled on the hub, or taken by the agent): stop hiding its rows. */
export function forgetSendAborted(sessionId: string, localId: string): void {
    const id = key(sessionId, localId)
    const before = load()
    const kept = before.filter((entry) => key(entry.sessionId, entry.localId) !== id)
    if (kept.length === before.length) return
    changed()
    write(kept)
}

/** The sends cancelled in flight for this session that are still awaiting their fate. Expired
 *  entries are dropped on the way. */
export function listAbortedSends(sessionId: string): AbortedSend[] {
    const now = Date.now()
    const before = load()
    const kept = before.filter((entry) => !expired(entry, now))
    if (kept.length !== before.length) {
        changed()
        write(kept)
    }
    return kept.filter((entry) => entry.sessionId === sessionId).map((entry) => ({ ...entry }))
}

export function subscribeAbortedSends(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

export function getAbortedSendsVersion(): number {
    return version
}

/** Test seam: the page is reloaded, so the next read comes back from storage. */
export function reloadAbortedSendsForTests(): void {
    cache = null
    listeners.clear()
}

/** Test seam: forget every entry, in memory and in storage. */
export function resetAbortedSends(): void {
    changed()
    listeners.clear()
    cache = []
    try {
        storage()?.removeItem(STORAGE_KEY)
    } catch {
        // Nothing to clear.
    }
}

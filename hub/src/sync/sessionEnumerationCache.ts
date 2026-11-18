/**
 * Single-flight + last-good cache for session enumeration RPCs
 * (ListSlashCommands / ListSkills).
 *
 * These RPCs are served by the runner/engine on the session's machine. When
 * the engine is mid-turn (or its socket is reconnecting), the RPC can queue
 * for tens of seconds (observed 20s+ in production) while clients re-request
 * the same enumeration on every session open. Enumerations change rarely, so:
 *   - concurrent callers share one in-flight fetch (single-flight)
 *   - a result younger than ttlMs is served without any RPC
 *   - a stale result is served immediately while it revalidates in background
 *   - a cold fetch is capped at fetchTimeoutMs; on timeout/failure the last
 *     good result (if any) is served instead
 *
 * Entries are keyed per session. The engine releases a session's entries
 * when it leaves the active set (deleted or archived), so memory is bounded
 * by the live session count rather than the hub's lifetime.
 */

interface EnumerationEntry {
    inFlight?: Promise<unknown>
    value?: unknown
    fetchedAt?: number
}

export class SessionEnumerationCache {
    private readonly entries = new Map<string, EnumerationEntry>()

    constructor(
        private readonly options: {
            ttlMs: number
            fetchTimeoutMs: number
            now?: () => number
        }
    ) {}

    /** Drop every entry whose key starts with `prefix` (e.g. a session id
     *  or machine id followed by the `|` separator). A fetch still in
     *  flight resolves against its detached entry object, so a late success
     *  cannot resurrect a released key — the next get() starts cold. */
    release(prefix: string): void {
        const scoped = `${prefix}|`
        for (const key of [...this.entries.keys()]) {
            if (key.startsWith(scoped)) {
                this.entries.delete(key)
            }
        }
    }

    /** Drop every entry belonging to the given session. Keys are
     *  `<sessionId>|<agent>` composites and session ids cannot contain '|',
     *  so a `sessionId|` prefix match is unambiguous. */
    releaseSession(sessionId: string): void {
        this.release(sessionId)
    }

    async get<T>(
        key: string,
        fetch: () => Promise<T>,
        isCacheable: (value: T) => boolean = () => true
    ): Promise<T> {
        return (await this.getEntry(key, fetch, isCacheable)).value
    }

    /**
     * Like get(), but reports whether the served value was fresh (in-TTL hit
     * or a live fetch) as opposed to a stale-while-revalidate serve. With
     * `force` the TTL check and the immediate stale serve are skipped: the
     * caller always waits for a fetch (joining any in-flight one) under the
     * same fetchTimeoutMs cap — explicit revalidation semantics.
     */
    async getEntry<T>(
        key: string,
        fetch: () => Promise<T>,
        isCacheable: (value: T) => boolean = () => true,
        options?: { force?: boolean }
    ): Promise<{ value: T; fresh: boolean }> {
        const now = this.options.now ?? Date.now
        const force = options?.force === true
        let entry = this.entries.get(key)
        if (!entry) {
            entry = {}
            this.entries.set(key, entry)
        }

        // Fresh value: serve without any RPC.
        if (
            !force
            && entry.value !== undefined
            && entry.fetchedAt !== undefined
            && now() - entry.fetchedAt < this.options.ttlMs
        ) {
            return { value: entry.value as T, fresh: true }
        }

        if (!entry.inFlight) {
            const started = (async () => fetch())().then(
                (value) => {
                    if (isCacheable(value)) {
                        entry.value = value
                        entry.fetchedAt = now()
                    }
                    return value
                },
                (error) => {
                    // Keep the last good value; propagate so cold callers react.
                    throw error
                }
            )
            entry.inFlight = started
            // Nobody may end up awaiting this fetch (stale callers are served
            // synchronously below) — swallow late rejections after it settles.
            void started.finally(() => {
                if (entry.inFlight === started) {
                    entry.inFlight = undefined
                }
            }).catch(() => {})
        }

        if (!force && entry.value !== undefined) {
            // Stale-while-revalidate: serve what we have; the in-flight fetch
            // above refreshes the entry for later callers.
            return { value: entry.value as T, fresh: false }
        }

        // Cold path (or forced revalidation): wait for the shared fetch,
        // capped at fetchTimeoutMs. The underlying fetch keeps running past
        // the cap so a late success still populates the cache for the next
        // caller.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        try {
            const value = await Promise.race([
                entry.inFlight as Promise<T>,
                new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(
                        () => reject(new Error('Enumeration RPC timed out')),
                        this.options.fetchTimeoutMs
                    )
                })
            ])
            return { value, fresh: true }
        } finally {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle)
            }
        }
    }

    /** Last-good value for the key with its fetch time, if any. Exposed so
     *  callers can decide their own fallback policy (e.g. serve a stale
     *  snapshot when a forced refresh hits an unreachable machine). */
    peek(key: string): { value: unknown; fetchedAt: number } | undefined {
        const entry = this.entries.get(key)
        if (!entry || entry.value === undefined || entry.fetchedAt === undefined) {
            return undefined
        }
        return { value: entry.value, fetchedAt: entry.fetchedAt }
    }
}

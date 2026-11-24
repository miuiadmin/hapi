import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { SESSION_DETAIL_STALE_TIME_MS } from './useSession'

/** How many of the topmost sessions (after the list's own sort) get their
 *  detail prefetched in eager mode. Clicking any of these renders from cache
 *  instantly — the "点进去才发现在加载" gap disappears. */
export const EAGER_PREFETCH_TOP_N = 5

/** Stagger between individual prefetch requests: keeps the hub from absorbing
 *  a burst of detail GETs at the exact same instant the list poll returns. */
const PREFETCH_STAGGER_MS = 200

/**
 * Prefetch requests allowed on the wire at once, across every batch. The list
 * of a busy hub has dozens of active sessions; prefetching them all on a fixed
 * 200ms stagger queued 50+ GETs on one connection, and on a slow link they
 * piled up faster than they completed — ahead of the foreground requests of
 * the session the user had just opened. Two outstanding keeps the 200ms
 * cadence on a healthy link and backs off by itself when the link is slow.
 */
export const MAX_PREFETCH_IN_FLIGHT = 2

/**
 * A failed prefetch pauses the next one for this long. Each consecutive
 * failure steps down the list, a success starts over. Without it a dead
 * connection collected one hanging GET every 200ms — measured as 115 requests
 * in 13 seconds, each failing only at the browser's 10s HTTP/2 ping timeout.
 */
export const PREFETCH_FAILURE_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const

/** A slot is handed back even if its request never settles (black-holed connection). */
const PREFETCH_SLOT_TIMEOUT_MS = 20_000

export function prefetchBackoffMs(failureCount: number): number {
    const index = Math.min(Math.max(failureCount, 1), PREFETCH_FAILURE_BACKOFF_MS.length) - 1
    return PREFETCH_FAILURE_BACKOFF_MS[index]
}

function isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * Eager-mode session detail prefetch. While enabled, every time the session
 * list data changes (initial load, poll refresh, SSE reordering) the hook
 * prefetches details for:
 *
 *  1. sessions with `active === true` (currently running — most likely to
 *     have new content the user wants to see),
 *  2. the top {@link EAGER_PREFETCH_TOP_N} sessions by list order (most
 *     likely to be clicked next).
 *
 * Prefetches use the same `queryKeys.session(id)` cache entries as
 * `useSession`, and respect `SESSION_DETAIL_STALE_TIME_MS`, so a warm cache
 * is not re-fetched on every poll cycle. No-op when `eager` is false.
 *
 * Background work only: nothing is prefetched while the browser is offline or
 * while a failure back-off is running, and at most
 * {@link MAX_PREFETCH_IN_FLIGHT} prefetches are outstanding.
 */
export function useEagerSessionPrefetch(
    api: ApiClient | null,
    sessions: SessionSummary[],
    eager: boolean,
    baseline: boolean = false
): void {
    const queryClient = useQueryClient()
    // Outlives one effect run: requests started by an abandoned batch keep
    // their slot until they settle, so restarts cannot stack up more of them.
    const inFlightRef = useRef(0)
    const pausedUntilRef = useRef(0)
    const failuresRef = useRef(0)

    useEffect(() => {
        if ((!eager && !baseline) || !api || sessions.length === 0) return
        if (!isOnline() || Date.now() < pausedUntilRef.current) return

        const targets = new Map<string, void>()
        if (baseline) {
            // Baseline mode: every session in the list gets its detail
            // prefetched. The 200ms stagger and 30s staleTime keep the hub
            // load bounded even with a large list.
            for (const session of sessions) {
                targets.set(session.id)
            }
        } else {
            for (const session of sessions) {
                if (session.active) {
                    targets.set(session.id)
                }
            }
            for (const session of sessions.slice(0, EAGER_PREFETCH_TOP_N)) {
                targets.set(session.id)
            }
        }
        const ids = [...targets.keys()]
        if (ids.length === 0) return

        let stopped = false
        let nextIndex = 0
        const timers = new Set<ReturnType<typeof setTimeout>>()

        const startNext = () => {
            if (stopped || nextIndex >= ids.length) return
            // Full: a releasing slot schedules the continuation. Offline or
            // backing off: this batch is abandoned; the next list refresh
            // starts a fresh one once conditions clear.
            if (inFlightRef.current >= MAX_PREFETCH_IN_FLIGHT) return
            if (!isOnline() || Date.now() < pausedUntilRef.current) return

            const sessionId = ids[nextIndex]
            nextIndex += 1
            inFlightRef.current += 1
            let released = false
            const release = () => {
                if (released) return
                released = true
                inFlightRef.current = Math.max(0, inFlightRef.current - 1)
            }
            const watchdog = setTimeout(() => {
                // The request never settled (black-holed connection): free its
                // slot and let the batch continue without it.
                timers.delete(watchdog)
                release()
                scheduleNext(PREFETCH_STAGGER_MS)
            }, PREFETCH_SLOT_TIMEOUT_MS)
            timers.add(watchdog)

            void queryClient.prefetchQuery({
                queryKey: queryKeys.session(sessionId),
                queryFn: async () => {
                    if (!api) throw new Error('API unavailable')
                    try {
                        const detail = await api.getSession(sessionId)
                        failuresRef.current = 0
                        pausedUntilRef.current = 0
                        return detail
                    } catch (error) {
                        failuresRef.current += 1
                        pausedUntilRef.current = Date.now() + prefetchBackoffMs(failuresRef.current)
                        throw error
                    }
                },
                staleTime: SESSION_DETAIL_STALE_TIME_MS
            }).catch(() => {
                // Prefetch is best-effort; failures surface through the
                // normal useSession error path when the user clicks in.
            }).finally(() => {
                clearTimeout(watchdog)
                timers.delete(watchdog)
                release()
                scheduleNext(PREFETCH_STAGGER_MS)
            })
        }

        const scheduleNext = (delay: number) => {
            if (stopped) return
            const timer = setTimeout(() => {
                timers.delete(timer)
                startNext()
            }, delay)
            timers.add(timer)
        }

        for (let i = 0; i < Math.min(MAX_PREFETCH_IN_FLIGHT, ids.length); i++) {
            scheduleNext(i * PREFETCH_STAGGER_MS)
        }

        return () => {
            stopped = true
            for (const timer of timers) clearTimeout(timer)
            timers.clear()
        }
    }, [eager, baseline, api, sessions, queryClient])
}

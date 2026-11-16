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
 */
export function useEagerSessionPrefetch(
    api: ApiClient | null,
    sessions: SessionSummary[],
    eager: boolean,
    baseline: boolean = false
): void {
    const queryClient = useQueryClient()
    const inFlightRef = useRef(false)

    useEffect(() => {
        if ((!eager && !baseline) || !api || sessions.length === 0 || inFlightRef.current) return

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

        inFlightRef.current = true
        let cancelled = false
        const timers: ReturnType<typeof setTimeout>[] = []

        ids.forEach((sessionId, index) => {
            const timer = setTimeout(() => {
                if (cancelled) return
                void queryClient.prefetchQuery({
                    queryKey: queryKeys.session(sessionId),
                    queryFn: async () => {
                        if (!api) throw new Error('API unavailable')
                        return await api.getSession(sessionId)
                    },
                    staleTime: SESSION_DETAIL_STALE_TIME_MS
                }).catch(() => {
                    // Prefetch is best-effort; failures surface through the
                    // normal useSession error path when the user clicks in.
                })
            }, index * PREFETCH_STAGGER_MS)
            timers.push(timer)
        })

        // Release the in-flight gate after the last staggered request has
        // had time to start, so the next list refresh can schedule a new
        // batch without overlapping this one.
        const gateTimer = setTimeout(() => {
            inFlightRef.current = false
        }, ids.length * PREFETCH_STAGGER_MS + 1000)
        timers.push(gateTimer)

        return () => {
            cancelled = true
            for (const timer of timers) clearTimeout(timer)
            inFlightRef.current = false
        }
    }, [eager, baseline, api, sessions, queryClient])
}

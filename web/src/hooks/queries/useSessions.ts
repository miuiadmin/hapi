import { useQuery, useQueryClient } from '@tanstack/react-query'
import { compareSessionSummaries, mergeReadState } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { reconcileAttachedJobsFromCache } from './reconcileAttachedJobs'

export type UseSessionsOptions = {
    enabled?: boolean
    /** When true, refetch the session list on a 15s interval while the tab
     *  is visible. React Query's default `refetchIntervalInBackground: false`
     *  keeps hidden tabs idle, so the cost is ~4 lightweight GETs/min only
     *  while the user is actually looking at the list. */
    eagerInterval?: boolean
}

/** Poll cadence for eager mode. 15s is aggressive enough to mask SSE
 *  disconnection gaps (hub restarts, phone backgrounding) without turning
 *  the list into a live ticker; SSE still delivers sub-second updates when
 *  connected, so this is purely a freshness floor. */
export const EAGER_REFETCH_INTERVAL_MS = 15_000

export function useSessions(api: ApiClient | null, options: UseSessionsOptions = {}): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const queryClient = useQueryClient()
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const response = await api.getSessions()
            // SSE may have delivered newer input while this GET was in flight.
            // Retain its monotonic ordering clock, not deleted rows or stale data.
            const current = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
            const cached = new Map(current?.sessions.map(s => [s.id, s]))
            const withClocks: SessionsResponse = {
                ...response,
                sessions: response.sessions.map(session => {
                    const prior = cached.get(session.id)
                    return { ...session,
                        lastUserMessageAt: Math.max(prior?.lastUserMessageAt ?? 0, session.lastUserMessageAt ?? 0) || undefined,
                        contentRevision: Math.max(prior?.contentRevision ?? 0, session.contentRevision ?? 0),
                        readState: mergeReadState(prior?.readState, session.readState)
                    }
                }).sort(compareSessionSummaries)
            }
            return reconcileAttachedJobsFromCache(withClocks, current)
        },
        enabled: Boolean(api) && (options.enabled ?? true),
        refetchInterval: options.eagerInterval ? EAGER_REFETCH_INTERVAL_MS : undefined,
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}

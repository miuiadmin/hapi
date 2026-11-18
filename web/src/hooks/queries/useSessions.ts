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

/** Idle poll cadence for eager mode (no active/thinking sessions on screen).
 *  SSE still delivers sub-second updates when connected, so this is purely a
 *  freshness floor for SSE disconnection gaps. */
export const EAGER_REFETCH_INTERVAL_MS = 15_000

/** Fast poll cadence when at least one session is active or thinking. The
 *  list's "loading" spinner (`active && thinking`) is the primary status
 *  surface users watch — when work is in flight, staleness beyond a few
 *  seconds reads as a wrong answer, not merely a late one. */
export const EAGER_ACTIVE_REFETCH_INTERVAL_MS = 5_000

/** Adaptive interval: 5s while any listed session is active/thinking (the
 *  spinner must be trustworthy), 15s when the list is all-idle. */
export function eagerRefetchInterval(data: { sessions: { active: boolean; thinking: boolean }[] } | undefined): number {
    const sessions = data?.sessions
    if (!sessions || sessions.length === 0) return EAGER_REFETCH_INTERVAL_MS
    for (const session of sessions) {
        if (session.active || session.thinking) return EAGER_ACTIVE_REFETCH_INTERVAL_MS
    }
    return EAGER_REFETCH_INTERVAL_MS
}

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
            // view=slim: the list never reads detail-only fields, and every
            // field the list does read survives the slim projection (audited
            // against SessionRowSummary/SessionList/sessionAttention/
            // sessionLastSeen + the SSE patch gates in useSSE).
            const response = await api.getSessions({ view: 'slim' })
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
        refetchInterval: options.eagerInterval ? (query) => eagerRefetchInterval(query.state.data as { sessions: { active: boolean; thinking: boolean }[] } | undefined) : undefined,
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}

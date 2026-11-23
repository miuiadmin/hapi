import { useCallback, useSyncExternalStore } from 'react'
import { hashKey, useQueryClient } from '@tanstack/react-query'
import type { AttachedJob } from '@hapi/protocol'
import type { SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

const SESSIONS_QUERY_HASH = hashKey(queryKeys.sessions)

function selectAttachedJob(data: SessionsResponse | undefined, sessionId: string): AttachedJob | null {
    return data?.sessions.find((summary) => summary.id === sessionId)?.attachedJob ?? null
}

/**
 * `SessionSummary.attachedJob` for one session, read reactively from the
 * session-list cache the sidebar / bootstrap / SSE patches keep fresh.
 *
 * The full `Session` detail the header renders carries no attached job, so the
 * delete-confirm copy reads it from the list row instead. Observe-only: it
 * subscribes to the cache and never adds a query observer, so mounting it in
 * the header never fetches the list nor changes how the list query refetches.
 * Returns null when the cache has no row for the session; the hub's 409
 * fallback covers that case.
 */
export function useSessionListAttachedJob(sessionId: string): AttachedJob | null {
    const queryClient = useQueryClient()
    const subscribe = useCallback((onChange: () => void) => (
        queryClient.getQueryCache().subscribe((event) => {
            if (event.query.queryHash === SESSIONS_QUERY_HASH) onChange()
        })
    ), [queryClient])
    // Snapshot identity is stable between cache writes: getQueryData hands
    // back the same row object until a patch replaces it.
    const getSnapshot = useCallback(
        () => selectAttachedJob(queryClient.getQueryData<SessionsResponse>(queryKeys.sessions), sessionId),
        [queryClient, sessionId]
    )
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

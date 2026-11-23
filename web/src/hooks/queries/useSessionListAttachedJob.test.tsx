import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AttachedJob } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useSessionListAttachedJob } from './useSessionListAttachedJob'

function summary(id: string, attachedJob: AttachedJob | null): SessionSummary {
    return {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        attachedJob,
        attachedJobUpdatedAt: attachedJob?.updatedAt ?? 0,
    }
}

function runningJob(key: string): AttachedJob {
    return { key, label: `Job ${key}`, status: 'running', heartbeatAt: 1, startedAt: 1, updatedAt: 1 }
}

function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    return { client, wrapper }
}

describe('useSessionListAttachedJob', () => {
    it('reads the row attached job from the session-list cache without adding a query observer', () => {
        const { client, wrapper } = setup()
        const job = runningJob('import')
        client.setQueryData(queryKeys.sessions, { sessions: [summary('other', null), summary('session-A', job)] })
        const fetchSpy = vi.spyOn(client, 'fetchQuery')
        const refetchSpy = vi.spyOn(client, 'refetchQueries')
        const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

        const { result } = renderHook(() => useSessionListAttachedJob('session-A'), { wrapper })

        expect(result.current).toBe(job)
        expect(client.getQueryCache().find({ queryKey: queryKeys.sessions })?.getObserversCount()).toBe(0)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(refetchSpy).not.toHaveBeenCalled()
        expect(invalidateSpy).not.toHaveBeenCalled()
    })

    it('returns null when the cache has no row for the session or no list at all', () => {
        const { client, wrapper } = setup()
        const { result } = renderHook(() => useSessionListAttachedJob('session-A'), { wrapper })
        expect(result.current).toBe(null)

        act(() => { client.setQueryData(queryKeys.sessions, { sessions: [summary('other', runningJob('x'))] }) })
        expect(result.current).toBe(null)

        act(() => { client.setQueryData(queryKeys.sessions, { sessions: [summary('session-A', null)] }) })
        expect(result.current).toBe(null)
    })

    it('follows SSE-style cache patches for its own session only', () => {
        const { client, wrapper } = setup()
        client.setQueryData(queryKeys.sessions, { sessions: [summary('session-A', null)] })
        const { result } = renderHook(() => useSessionListAttachedJob('session-A'), { wrapper })
        expect(result.current).toBe(null)

        // Attached-job SSE patch lands (as useSSE writes it).
        const job = runningJob('import')
        act(() => {
            client.setQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions, (previous) => (
                previous
                    ? { sessions: previous.sessions.map((row) => row.id === 'session-A' ? { ...row, attachedJob: job } : row) }
                    : previous
            ))
        })
        expect(result.current).toBe(job)

        // Another session's patch does not disturb the snapshot.
        act(() => {
            client.setQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions, (previous) => (
                previous
                    ? { sessions: previous.sessions.map((row) => row.id === 'session-A'
                        ? row
                        : { ...row, updatedAt: row.updatedAt + 1 }) }
                    : previous
            ))
        })
        expect(result.current).toBe(job)

        // Job completes: the hub clears the primary job on the row.
        act(() => {
            client.setQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions, (previous) => (
                previous
                    ? { sessions: previous.sessions.map((row) => row.id === 'session-A' ? { ...row, attachedJob: null } : row) }
                    : previous
            ))
        })
        expect(result.current).toBe(null)

        act(() => {
            client.setQueryData(queryKeys.sessions, { sessions: [summary('session-A', runningJob('export'))] })
        })
        expect(result.current).not.toBe(null)
        expect(result.current?.key).toBe('export')
    })

    it('ignores cache events for other queries', () => {
        const { client, wrapper } = setup()
        const job = runningJob('import')
        client.setQueryData(queryKeys.sessions, { sessions: [summary('session-A', job)] })
        const { result } = renderHook(() => useSessionListAttachedJob('session-A'), { wrapper })

        act(() => { client.setQueryData(queryKeys.session('session-A'), { session: { id: 'session-A' } }) })
        act(() => { client.setQueryData(queryKeys.machines, { machines: [] }) })

        expect(result.current).toBe(job)
    })
})

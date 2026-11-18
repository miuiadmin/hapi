import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { eagerRefetchInterval, EAGER_REFETCH_INTERVAL_MS, EAGER_ACTIVE_REFETCH_INTERVAL_MS } from './useSessions'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useSessions } from './useSessions'

afterEach(cleanup)

function row(id: string, at: number): SessionSummary {
    return {
        id, createdAt: 1, lastUserMessageAt: at, updatedAt: at,
        active: false, thinking: false, activeAt: 0, metadata: null,
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0,
        todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [],
        backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null,
        attachedJob: null, attachedJobUpdatedAt: 0,
        model: null, effort: null
    }
}

it('does not let a delayed REST snapshot undo newer user input from SSE', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const initial = { sessions: [row('b', 200), row('a', 100), row('removed', 50)] }
    client.setQueryData(queryKeys.sessions, initial)
    let resolve!: (response: SessionsResponse) => void
    const getSessions = vi.fn(() => new Promise<SessionsResponse>(done => { resolve = done }))
    const api = { getSessions } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api, { enabled: false }), { wrapper })
    await act(async () => {
        const pending = result.current.refetch()
        client.setQueryData(queryKeys.sessions, { sessions: [row('a', 300), row('b', 200), row('removed', 50)] })
        resolve({ sessions: [row('b', 200), row('a', 100)] })
        await pending
    })
    const data = client.getQueryData<SessionsResponse>(queryKeys.sessions)!
    expect(data.sessions.map(s => s.id)).toEqual(['a', 'b'])
    expect(data.sessions[0]!.lastUserMessageAt).toBe(300)
    // The list query always asks for the compact projection — every list
    // consumer tolerates omitted default fields (audited slim contract).
    expect(getSessions).toHaveBeenCalledWith({ view: 'slim' })
})

it('tolerates slim rows: absent default fields sort and merge like their defaults', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // A slim wire row: no model/effort/thinking/pendingRequests/… keys at all.
    const slimRow = {
        id: 'slim', createdAt: 1, lastUserMessageAt: 100, updatedAt: 100,
        active: true, metadata: null,
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0
    } as unknown as SessionSummary
    const getSessions = vi.fn(async () => ({ sessions: [slimRow] }) as SessionsResponse)
    const api = { getSessions } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api, { enabled: false }), { wrapper })
    await act(async () => {
        await result.current.refetch()
    })
    const data = client.getQueryData<SessionsResponse>(queryKeys.sessions)!
    expect(data.sessions.map(s => s.id)).toEqual(['slim'])
    expect(data.sessions[0]!.contentRevision).toBe(0)
    expect(getSessions).toHaveBeenCalledWith({ view: 'slim' })
})

// Adaptive eager interval: fast when any session is active/thinking, slow when idle.
describe('eagerRefetchInterval', () => {
    it('returns idle cadence for empty/undefined data', () => {
        expect(eagerRefetchInterval(undefined)).toBe(EAGER_REFETCH_INTERVAL_MS)
        expect(eagerRefetchInterval({ sessions: [] })).toBe(EAGER_REFETCH_INTERVAL_MS)
    })
    it('returns fast cadence when any session is active', () => {
        expect(eagerRefetchInterval({ sessions: [{ active: false, thinking: false }, { active: true, thinking: false }] })).toBe(EAGER_ACTIVE_REFETCH_INTERVAL_MS)
    })
    it('returns fast cadence when any session is thinking', () => {
        expect(eagerRefetchInterval({ sessions: [{ active: true, thinking: true }] })).toBe(EAGER_ACTIVE_REFETCH_INTERVAL_MS)
    })
    it('returns idle cadence when all sessions are idle', () => {
        expect(eagerRefetchInterval({ sessions: [{ active: false, thinking: false }, { active: false, thinking: false }] })).toBe(EAGER_REFETCH_INTERVAL_MS)
    })
})

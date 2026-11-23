import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { AttachedJob } from '@hapi/protocol'
import { useSessionActions } from './useSessionActions'
import { ApiError, type ApiClient } from '@/api/client'

function createWrapper(queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
})) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createMockApi(reopenSession: (sessionId: string) => Promise<{ ok: true; sessionId: string; resumed: boolean }>): ApiClient {
    return { reopenSession } as unknown as ApiClient
}

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('useSessionActions - local archive progress', () => {
    it('does not subscribe each action consumer to the shared mutation cache', () => {
        const client = new QueryClient()
        const subscribe = vi.spyOn(client.getMutationCache(), 'subscribe')
        const hook = renderHook(() => useSessionActions(null, 'session-A'), { wrapper: createWrapper(client) })
        hook.rerender()
        expect(subscribe).not.toHaveBeenCalled()
    })

    it.each(['success', 'failure'])('tracks its own unfinished archive (%s)', async outcome => {
        let resolve!: () => void
        let reject!: (error: Error) => void
        const archivePromise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
        const api = { archiveSession: vi.fn(() => archivePromise) } as unknown as ApiClient
        const wrapper = createWrapper()
        const initiator = renderHook(() => useSessionActions(api, 'session-A'), { wrapper })
        let pending!: Promise<unknown>
        act(() => { pending = initiator.result.current.archiveSession().catch(error => error) })
        await waitFor(() => expect(initiator.result.current.isPending).toBe(true))
        const observer = renderHook(() => useSessionActions(api, 'session-A'), { wrapper })
        expect(observer.result.current.isPending).toBe(false)
        await act(async () => {
            if (outcome === 'success') resolve()
            else reject(new Error('Archive failed'))
            await pending
        })
        await waitFor(() => expect(initiator.result.current.isPending).toBe(false))
        initiator.unmount()
        observer.unmount()
    })
})

describe('useSessionActions - reopenSession', () => {
    it('invokes api.reopenSession with the session id and forwards the response', async () => {
        const reopen = vi.fn(async (_sessionId: string) => ({
            ok: true as const,
            sessionId: 'session-A-spawned',
            resumed: true
        }))
        const api = createMockApi(reopen)

        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', 'cursor'),
            { wrapper: createWrapper() },
        )

        let response: { ok: true; sessionId: string; resumed: boolean } | undefined
        await act(async () => {
            response = await result.current.reopenSession()
        })

        expect(reopen).toHaveBeenCalledWith('session-A')
        // The mutation must propagate the response so the UI can navigate to the
        // possibly-new spawn id when resumeSession merges the row.
        expect(response).toEqual({ ok: true, sessionId: 'session-A-spawned', resumed: true })
    })

    it('throws when api or sessionId is missing', async () => {
        const { result } = renderHook(
            () => useSessionActions(null, null, null),
            { wrapper: createWrapper() },
        )

        await expect(result.current.reopenSession()).rejects.toThrow('Session unavailable')
    })

    it('surfaces an ApiError so the UI can render the 422 missing-metadata payload', async () => {
        const reopen = vi.fn(async () => {
            throw new ApiError(
                'HTTP 422 Unprocessable Entity: {"error":"Cursor session id is missing from metadata; reopen requires the original cursor chat id","missing":["cursorSessionId"]}',
                422,
                'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                '{"error":"Cursor session id is missing from metadata; reopen requires the original cursor chat id","missing":["cursorSessionId"]}'
            )
        })
        const api = createMockApi(reopen as unknown as ApiClient['reopenSession'])

        const { result } = renderHook(
            () => useSessionActions(api, 'session-X', 'cursor'),
            { wrapper: createWrapper() },
        )

        let captured: unknown
        await act(async () => {
            try {
                await result.current.reopenSession()
            } catch (error) {
                captured = error
            }
        })

        expect(captured).toBeInstanceOf(ApiError)
        const apiError = captured as ApiError
        expect(apiError.status).toBe(422)
        expect(apiError.body).toContain('cursorSessionId')

        await waitFor(() => {
            // The hook should not get stuck pending after the failure.
            expect(result.current.isPending).toBe(false)
        })
    })

    it('does not invalidate the source session detail when reopen returns a different id', async () => {
        const reopen = vi.fn(async () => ({
            ok: true as const,
            sessionId: 'session-B',
            resumed: true,
        }))
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        const api = createMockApi(reopen)
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', 'cursor'),
            { wrapper },
        )

        await act(async () => {
            await result.current.reopenSession()
        })

        await waitFor(() => {
            expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] })
        })
        expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['session', 'session-A'] })
    })

    it('invalidates the source session detail when reopen returns the same id', async () => {
        const reopen = vi.fn(async () => ({
            ok: true as const,
            sessionId: 'session-A',
            resumed: true,
        }))
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        const api = createMockApi(reopen)
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', 'cursor'),
            { wrapper },
        )

        await act(async () => {
            await result.current.reopenSession()
        })

        await waitFor(() => {
            expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 'session-A'] })
        })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] })
    })
})

describe('useSessionActions - setModel', () => {
    it('stays pending until the refreshed session detail is available', async () => {
        let releaseSessionRefresh!: () => void
        const sessionRefresh = new Promise<void>((resolve) => {
            releaseSessionRefresh = resolve
        })
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (filters) => {
            if (JSON.stringify(filters?.queryKey) === JSON.stringify(['session', 'session-A'])) {
                await sessionRefresh
            }
        })
        const api = {
            setModel: vi.fn(async () => undefined),
        } as unknown as ApiClient
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', 'agy'),
            { wrapper },
        )

        let settled = false
        const change = result.current.setModel('gemini-3.5-flash-low').then(() => {
            settled = true
        })

        await waitFor(() => expect(api.setModel).toHaveBeenCalled())
        expect(result.current.isPending).toBe(true)
        expect(settled).toBe(false)

        releaseSessionRefresh()
        await act(async () => await change)

        expect(settled).toBe(true)
        await waitFor(() => expect(result.current.isPending).toBe(false))
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 'session-A'] })
    })
})

describe('useSessionActions - setModelReasoningEffort', () => {
    it.each(['codex', 'opencode', 'dsh', 'hermes'])('forwards the dsh/codex-family thought level for %s sessions', async (flavor) => {
        const api = {
            setModelReasoningEffort: vi.fn(async () => undefined),
        } as unknown as ApiClient
        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', flavor, flavor === 'codex'),
            { wrapper: createWrapper() },
        )

        await act(async () => {
            await result.current.setModelReasoningEffort('high')
        })

        expect(api.setModelReasoningEffort).toHaveBeenCalledWith('session-A', 'high')
    })

    it.each([null, 'claude'])('still rejects unsupported flavors (%s)', async (flavor) => {
        const api = {
            setModelReasoningEffort: vi.fn(async () => undefined),
        } as unknown as ApiClient
        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', flavor ?? undefined),
            { wrapper: createWrapper() },
        )

        await expect(act(async () => {
            await result.current.setModelReasoningEffort('high')
        })).rejects.toThrow('Model reasoning effort is only supported for Codex, OpenCode, DSH, and Hermes sessions')
        expect(api.setModelReasoningEffort).not.toHaveBeenCalled()
    })
})

describe('useSessionActions - deleteSession', () => {
    function createAttachedJob(key: string, status: AttachedJob['status']): AttachedJob {
        return {
            key,
            label: `Job ${key}`,
            status,
            heartbeatAt: 1,
            startedAt: 1,
            updatedAt: 1
        }
    }

    function createDeleteApi(jobs: AttachedJob[] = []) {
        const calls: string[] = []
        const listSessionJobs = vi.fn(async () => {
            calls.push('list')
            return { jobs, primary: jobs.find((job) => job.status === 'running') ?? null }
        })
        const deleteSessionJob = vi.fn(async (_sessionId: string, jobKey: string) => {
            calls.push(`clear:${jobKey}`)
            return { ok: true as const }
        })
        const deleteSession = vi.fn(async () => {
            calls.push('delete')
        })
        const api = { listSessionJobs, deleteSessionJob, deleteSession } as unknown as ApiClient
        return { api, listSessionJobs, deleteSessionJob, deleteSession, calls }
    }

    it('deletes without touching attached jobs when not asked', async () => {
        const state = createDeleteApi([createAttachedJob('import', 'running')])
        const { result } = renderHook(() => useSessionActions(state.api, 'session-A'), { wrapper: createWrapper() })

        await act(async () => { await result.current.deleteSession() })

        expect(state.deleteSession).toHaveBeenCalledOnce()
        expect(state.deleteSession).toHaveBeenCalledWith('session-A')
        expect(state.listSessionJobs).not.toHaveBeenCalled()
        expect(state.deleteSessionJob).not.toHaveBeenCalled()
    })

    it.each([
        ['undefined', undefined],
        ['a click event', { type: 'click', preventDefault: vi.fn(), stopPropagation: vi.fn() }],
        ['an unrelated object', { confirm: true, clearAttachedJobs: 'yes' }],
        ['an array', ['clearAttachedJobs']]
    ])('ignores %s handed through as onConfirm and just deletes', async (_label, argument) => {
        const state = createDeleteApi([createAttachedJob('import', 'running')])
        const { result } = renderHook(() => useSessionActions(state.api, 'session-A'), { wrapper: createWrapper() })

        await act(async () => {
            await (result.current.deleteSession as (options?: unknown) => Promise<void>)(argument)
        })

        expect(state.listSessionJobs).not.toHaveBeenCalled()
        expect(state.deleteSessionJob).not.toHaveBeenCalled()
        expect(state.deleteSession).toHaveBeenCalledOnce()
    })

    it('clears only the running jobs, in list order, before deleting the session', async () => {
        const state = createDeleteApi([
            createAttachedJob('sync', 'completed'),
            createAttachedJob('import', 'running'),
            createAttachedJob('report', 'failed'),
            createAttachedJob('export', 'running')
        ])
        const { result } = renderHook(() => useSessionActions(state.api, 'session-A'), { wrapper: createWrapper() })

        await act(async () => { await result.current.deleteSession({ clearAttachedJobs: true }) })

        expect(state.listSessionJobs).toHaveBeenCalledOnce()
        expect(state.listSessionJobs).toHaveBeenCalledWith('session-A')
        expect(state.deleteSessionJob.mock.calls).toEqual([
            ['session-A', 'import'],
            ['session-A', 'export']
        ])
        expect(state.deleteSession).toHaveBeenCalledOnce()
        expect(state.deleteSession).toHaveBeenCalledWith('session-A')
        expect(state.calls).toEqual(['list', 'clear:import', 'clear:export', 'delete'])
        expect(result.current.isPending).toBe(false)
    })

    it('skips a job that vanished before it could be cleared', async () => {
        const state = createDeleteApi([createAttachedJob('import', 'running'), createAttachedJob('export', 'running')])
        state.deleteSessionJob.mockImplementationOnce(async () => {
            throw new ApiError('HTTP 404 Not Found: {"error":"Job not found"}', 404, 'Job not found', '{"error":"Job not found"}')
        })
        const { result } = renderHook(() => useSessionActions(state.api, 'session-A'), { wrapper: createWrapper() })

        await act(async () => { await result.current.deleteSession({ clearAttachedJobs: true }) })

        // The 404 is tolerated and the remaining running job is still cleared.
        expect(state.deleteSessionJob.mock.calls).toEqual([
            ['session-A', 'import'],
            ['session-A', 'export']
        ])
        expect(state.deleteSession).toHaveBeenCalledOnce()
    })

    it('does not delete the session when clearing a job fails', async () => {
        const state = createDeleteApi([createAttachedJob('import', 'running')])
        state.deleteSessionJob.mockImplementationOnce(async () => {
            throw new ApiError('HTTP 500 Internal Server Error: {"error":"db locked"}', 500, 'db locked', '{"error":"db locked"}')
        })
        const { result } = renderHook(() => useSessionActions(state.api, 'session-A'), { wrapper: createWrapper() })

        await expect(act(async () => { await result.current.deleteSession({ clearAttachedJobs: true }) }))
            .rejects.toThrow('db locked')

        expect(state.deleteSession).not.toHaveBeenCalled()
        await waitFor(() => expect(result.current.isPending).toBe(false))
    })

    it('throws when api or sessionId is missing', async () => {
        const { result } = renderHook(() => useSessionActions(null, null), { wrapper: createWrapper() })

        await expect(result.current.deleteSession({ clearAttachedJobs: true })).rejects.toThrow('Session unavailable')
    })

    function attachedJobConflict() {
        const body = '{"error":"Cannot delete a session while an attached job is running. Complete or clear it first."}'
        return new ApiError(`HTTP 409 Conflict: ${body}`, 409,
            'Cannot delete a session while an attached job is running. Complete or clear it first.', body)
    }

    it('marks the session list stale when the hub still rejects the delete for a running job', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        const api = { deleteSession: vi.fn(async () => { throw attachedJobConflict() }) } as unknown as ApiClient
        const { result } = renderHook(() => useSessionActions(api, 'session-A'), { wrapper: createWrapper(queryClient) })

        await expect(act(async () => { await result.current.deleteSession() }))
            .rejects.toBeInstanceOf(ApiError)

        // Nothing is cleared behind the operator's back; the list is refreshed
        // so the confirm copy can name the job before a retry.
        expect(api.listSessionJobs).toBeUndefined()
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] })
    })

    it('does not refresh the list for other delete failures', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        const api = { deleteSession: vi.fn(async () => {
            throw new ApiError('HTTP 500 Internal Server Error: {"error":"boom"}', 500, 'boom', '{"error":"boom"}')
        }) } as unknown as ApiClient
        const { result } = renderHook(() => useSessionActions(api, 'session-A'), { wrapper: createWrapper(queryClient) })

        await expect(act(async () => { await result.current.deleteSession() })).rejects.toThrow('boom')

        expect(invalidate).not.toHaveBeenCalled()
    })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionHeader } from './SessionHeader'
import { ToastProvider } from '@/lib/toast-context'
import { I18nProvider } from '@/lib/i18n-context'
import { ApiError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { en } from '@/lib/locales'
import type { AttachedJob } from '@hapi/protocol'
import type { Session, SessionSummary } from '@/types/api'

afterEach(() => { cleanup(); localStorage.clear() })

const SESSION_ID = 'delete-attached-job-test'
const SESSION_NAME = 'Job session'

function session(): Session {
    return { id: SESSION_ID, namespace: 'default', seq: 0, createdAt: 0, updatedAt: 0,
        active: false, activeAt: 0, metadata: { flavor: 'codex', path: '/repo', host: 'test', name: SESSION_NAME }, metadataVersion: 0,
        agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, model: null,
        modelReasoningEffort: null, effort: null, serviceTier: null }
}

function runningJob(key = 'import'): AttachedJob {
    return { key, label: 'Import progress', status: 'running', heartbeatAt: 1, startedAt: 1, updatedAt: 1 }
}

/** The list row the sidebar keeps in the sessions cache. */
function row(attachedJob: AttachedJob | null = null): SessionSummary {
    return {
        id: SESSION_ID,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 1,
        metadata: { path: '/repo', name: SESSION_NAME },
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

type SetupOptions = {
    /** Running job already present on the cached list row. */
    attachedJob?: AttachedJob
    /** What the hub's job listing returns when the delete asks to clear. */
    jobs?: AttachedJob[]
    /** `api.deleteSession` implementation (reject to exercise the fallback). */
    deleteSession?: () => Promise<void>
}

function setup({ attachedJob, jobs = attachedJob ? [attachedJob] : [], deleteSession = async () => {} }: SetupOptions = {}) {
    const calls: string[] = []
    const listSessionJobs = vi.fn(async () => { calls.push('list'); return { jobs, primary: jobs.find((job) => job.status === 'running') ?? null } })
    const deleteSessionJob = vi.fn(async (_id: string, key: string) => { calls.push(`clear:${key}`); return { ok: true as const } })
    const deleteSpy = vi.fn(async () => { calls.push('delete'); return await deleteSession() })
    const api = { archiveSession: vi.fn(async () => {}), deleteSession: deleteSpy, listSessionJobs, deleteSessionJob,
        getMachines: vi.fn(async () => ({ machines: [] })),
        getScratchlist: vi.fn(async () => ({ entries: [] })) } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    // Slim list rows omit the job fields entirely when there is no job.
    client.setQueryData(queryKeys.sessions, {
        sessions: [attachedJob ? row(attachedJob) : { ...row(), attachedJob: undefined, attachedJobUpdatedAt: undefined }],
    })
    const onSessionDeleted = vi.fn()
    const view = () => <QueryClientProvider client={client}><ToastProvider><I18nProvider>
        <SessionHeader session={session()} api={api} onBack={vi.fn()} onSessionDeleted={onSessionDeleted} />
    </I18nProvider></ToastProvider></QueryClientProvider>
    render(view())
    return { client, calls, listSessionJobs, deleteSessionJob, deleteSpy, onSessionDeleted }
}

function openDeleteDialog() {
    fireEvent.click(screen.getByTitle('More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    return screen.getByRole('dialog')
}

describe('SessionHeader delete with a running attached job', () => {
    it('names the running job in the copy, then clears it before deleting', async () => {
        const job = runningJob()
        const state = setup({ attachedJob: job })
        const dialog = openDeleteDialog()

        expect(within(dialog).getByText(`${en['dialog.delete.description']!.replace('{name}', SESSION_NAME)} ${en['dialog.delete.attachedJob']}`))
            .toBeInTheDocument()
        expect(state.listSessionJobs).not.toHaveBeenCalled()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(state.onSessionDeleted).toHaveBeenCalledOnce())
        expect(state.calls).toEqual(['list', 'clear:import', 'delete'])
        expect(state.listSessionJobs).toHaveBeenCalledWith(SESSION_ID)
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('keeps the plain copy and a plain delete when no job is running', async () => {
        const state = setup()
        const dialog = openDeleteDialog()

        expect(within(dialog).getByText(en['dialog.delete.description']!.replace('{name}', SESSION_NAME))).toBeInTheDocument()
        expect(within(dialog).queryByText(/long-running job/)).not.toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(state.onSessionDeleted).toHaveBeenCalledOnce())
        expect(state.deleteSpy).toHaveBeenCalledOnce()
        expect(state.listSessionJobs).not.toHaveBeenCalled()
        expect(state.deleteSessionJob).not.toHaveBeenCalled()
    })

    it('updates an open dialog when the job arrives through a list patch', async () => {
        const state = setup({ jobs: [runningJob('export')] })
        const dialog = openDeleteDialog()
        expect(within(dialog).queryByText(/long-running job/)).not.toBeInTheDocument()

        act(() => {
            state.client.setQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions, (previous) => (
                previous
                    ? { sessions: previous.sessions.map((row) => ({ ...row, attachedJob: runningJob('export'), attachedJobUpdatedAt: 2 })) }
                    : previous
            ))
        })

        await waitFor(() => expect(within(dialog).getByText(/long-running job/)).toBeInTheDocument())
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(state.onSessionDeleted).toHaveBeenCalledOnce())
        expect(state.calls).toEqual(['list', 'clear:export', 'delete'])
    })

    it('shows the readable conflict copy instead of the raw 409 when the list did not show the job', async () => {
        const body = '{"error":"Cannot delete a session while an attached job is running. Complete or clear it first."}'
        const reject = vi.fn(async () => {
            throw new ApiError(`HTTP 409 Conflict: ${body}`, 409,
                'Cannot delete a session while an attached job is running. Complete or clear it first.', body)
        })
        const state = setup({ deleteSession: reject })
        const dialog = openDeleteDialog()
        expect(within(dialog).queryByText(/long-running job/)).not.toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(within(dialog).getByText(en['dialog.delete.attachedJobConflict']!)).toBeInTheDocument())
        expect(within(dialog).queryByText(/HTTP 409/)).not.toBeInTheDocument()
        expect(screen.getByRole('dialog')).toBe(dialog)
        // Nothing is cleared behind the operator's back, and the list is
        // refreshed so a retry sees the job in the copy.
        expect(state.listSessionJobs).not.toHaveBeenCalled()
        expect(state.deleteSessionJob).not.toHaveBeenCalled()
        expect(state.onSessionDeleted).not.toHaveBeenCalled()
        await waitFor(() => expect(state.client.getQueryState(queryKeys.sessions)?.isInvalidated).toBe(true))
    })
})

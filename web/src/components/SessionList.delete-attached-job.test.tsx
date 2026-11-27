import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client'
import type { AttachedJob } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { en } from '@/lib/locales'
import { SessionList } from './SessionList'

afterEach(() => { cleanup(); localStorage.clear() })

const SESSION_ID = 'session-1'
const SESSION_NAME = 'Job session'

function runningJob(key: string): AttachedJob {
    return { key, label: `Job ${key}`, status: 'running', heartbeatAt: 1, startedAt: 1, updatedAt: 1 }
}

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false, thinking: false, activeAt: 0, updatedAt: 1, metadata: { path: '/work/app', name: SESSION_NAME },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, activeTaskCount: 0, nextTaskRunAt: null, model: null, effort: null,
        attachedJob: null, attachedJobUpdatedAt: 0,
        ...overrides
    }
}

function setup(sessions: SessionSummary[], options: { jobs?: AttachedJob[]; deleteSession?: () => Promise<void> } = {}) {
    const calls: string[] = []
    const jobs = options.jobs ?? []
    const listSessionJobs = vi.fn(async () => { calls.push('list'); return { jobs, primary: jobs.find((job) => job.status === 'running') ?? null } })
    const deleteSessionJob = vi.fn(async (_id: string, key: string) => { calls.push(`clear:${key}`); return { ok: true as const } })
    const deleteSession = vi.fn(async () => { calls.push('delete'); await (options.deleteSession ?? (async () => {}))() })
    const api = { listSessionJobs, deleteSessionJob, deleteSession, getMachines: vi.fn(async () => ({ machines: [] })) } as unknown as ApiClient
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList sessions={sessions} selectedSessionId={SESSION_ID} onSelect={vi.fn()} onNewSession={vi.fn()}
                        onRefresh={vi.fn()} isLoading={false} renderHeader={false} api={api} />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
    return { calls, listSessionJobs, deleteSessionJob, deleteSession }
}

function openDeleteDialog() {
    const row = screen.getByRole('button', { name: new RegExp(SESSION_NAME) })
    fireEvent.mouseDown(row, { button: 2, clientX: 10, clientY: 10 })
    fireEvent.mouseUp(row, { button: 2, clientX: 10, clientY: 10 })
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    return screen.getByRole('dialog')
}

const plainDescription = en['dialog.delete.description'].replace('{name}', SESSION_NAME)

describe('SessionList row delete with a running attached job', () => {
    it('names the running job in the copy, then clears it before deleting the session', async () => {
        const state = setup([makeSession({ id: SESSION_ID, attachedJob: runningJob('import'), attachedJobUpdatedAt: 1 })],
            { jobs: [runningJob('import')] })
        const dialog = openDeleteDialog()

        expect(within(dialog).getByText(`${plainDescription} ${en['dialog.delete.attachedJob']}`)).toBeInTheDocument()
        expect(state.listSessionJobs).not.toHaveBeenCalled()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(state.deleteSession).toHaveBeenCalledOnce())
        expect(state.deleteSession).toHaveBeenCalledWith(SESSION_ID)
        expect(state.listSessionJobs).toHaveBeenCalledWith(SESSION_ID)
        expect(state.deleteSessionJob.mock.calls).toEqual([[SESSION_ID, 'import']])
        expect(state.calls).toEqual(['list', 'clear:import', 'delete'])
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('keeps the plain copy and a plain delete when no job is running', async () => {
        const state = setup([makeSession({ id: SESSION_ID })])
        const dialog = openDeleteDialog()

        expect(within(dialog).getByText(plainDescription)).toBeInTheDocument()
        expect(within(dialog).queryByText(/long-running job/)).not.toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(state.deleteSession).toHaveBeenCalledOnce())
        expect(state.listSessionJobs).not.toHaveBeenCalled()
        expect(state.deleteSessionJob).not.toHaveBeenCalled()
    })

    it('ignores terminal jobs the summary might carry', async () => {
        const state = setup([makeSession({ id: SESSION_ID, attachedJob: { ...runningJob('sync'), status: 'completed' }, attachedJobUpdatedAt: 1 })])
        const dialog = openDeleteDialog()

        expect(within(dialog).queryByText(/long-running job/)).not.toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(state.deleteSession).toHaveBeenCalledOnce())
        expect(state.listSessionJobs).not.toHaveBeenCalled()
    })

    it('shows the readable conflict copy instead of the raw 409 when the row did not show the job', async () => {
        const body = '{"error":"Cannot delete a session while an attached job is running. Complete or clear it first."}'
        const reject = async () => {
            throw new ApiError(`HTTP 409 Conflict: ${body}`, 409,
                'Cannot delete a session while an attached job is running. Complete or clear it first.', body)
        }
        const state = setup([makeSession({ id: SESSION_ID })], { deleteSession: reject })
        const dialog = openDeleteDialog()
        expect(within(dialog).queryByText(/long-running job/)).not.toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(within(dialog).getByText(en['dialog.delete.attachedJobConflict'])).toBeInTheDocument())
        expect(within(dialog).queryByText(/HTTP 409/)).not.toBeInTheDocument()
        expect(screen.getByRole('dialog')).toBe(dialog)
        // The operator was never told about a job, so nothing is cleared.
        expect(state.listSessionJobs).not.toHaveBeenCalled()
        expect(state.deleteSessionJob).not.toHaveBeenCalled()
    })

    it('keeps other failures on their original message', async () => {
        const state = setup([makeSession({ id: SESSION_ID })], { deleteSession: async () => { throw new Error('runner offline') } })
        const dialog = openDeleteDialog()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(within(dialog).getByText('runner offline')).toBeInTheDocument())
    })

    it('picks up a job that lands on the row while the dialog is open', async () => {
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
        const deleteSession = vi.fn(async () => {})
        const listSessionJobs = vi.fn(async () => ({ jobs: [runningJob('export')], primary: runningJob('export') }))
        const deleteSessionJob = vi.fn(async () => ({ ok: true as const }))
        const api = { deleteSession, listSessionJobs, deleteSessionJob } as unknown as ApiClient
        const list = (attachedJob: AttachedJob | null) => (
            <QueryClientProvider client={client}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionList sessions={[makeSession({ id: SESSION_ID, attachedJob, attachedJobUpdatedAt: attachedJob?.updatedAt ?? 0 })]}
                            selectedSessionId={SESSION_ID} onSelect={vi.fn()} onNewSession={vi.fn()} onRefresh={vi.fn()}
                            isLoading={false} renderHeader={false} api={api} />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )
        const { rerender } = render(list(null))
        const dialog = openDeleteDialog()
        expect(within(dialog).queryByText(/long-running job/)).not.toBeInTheDocument()

        // The SSE attached-job patch reaches the row through props.
        rerender(list(runningJob('export')))

        await waitFor(() => expect(within(dialog).getByText(/long-running job/)).toBeInTheDocument())
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(deleteSession).toHaveBeenCalledOnce())
        expect(deleteSessionJob).toHaveBeenCalledWith(SESSION_ID, 'export')
    })
})

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider, useToast, type Toast } from '@/lib/toast-context'
import { queryKeys } from '@/lib/query-keys'
import { clearSessionActionFailures } from '@/lib/sessionActionFailures'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionErrorDialog } from './SessionActionErrorDialog'
import { SessionList } from './SessionList'

// Archiving is shown at once: the row takes the archived look the moment the
// request starts, whatever the cache keeps saying about the session, and only
// a failure brings it back.

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true, thinking: false, activeAt: 0, updatedAt: Date.now(), metadata: { path: '/work/app', name: `Title ${overrides.id}` },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, activeTaskCount: 0, nextTaskRunAt: null, model: null, effort: null,
        attachedJob: null, attachedJobUpdatedAt: 0,
        ...overrides,
    }
}

let toasts: Toast[] = []
function ToastProbe() {
    toasts = useToast().toasts
    return null
}

/** The list reads its rows from the sessions query, as the app does, so "an event" is a cache write like useSSE's. */
function CachedList(props: { api: ApiClient; selectedSessionId?: string | null }) {
    const { data } = useQuery({ queryKey: queryKeys.sessions, queryFn: () => props.api.getSessions() })
    return <SessionList sessions={data?.sessions ?? []} selectedSessionId={props.selectedSessionId ?? null} onSelect={vi.fn()}
        onNewSession={vi.fn()} onRefresh={vi.fn()} isLoading={false} renderHeader={false} api={props.api} />
}

function setup(sessions: SessionSummary[], api: Partial<ApiClient>, selectedSessionId: string | null = null) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    client.setQueryData(queryKeys.sessions, { sessions })
    const fullApi = api as ApiClient
    toasts = []
    render(
        <QueryClientProvider client={client}>
            <ToastProvider>
                <I18nProvider>
                    <ToastProbe />
                    <CachedList api={fullApi} selectedSessionId={selectedSessionId} />
                    <SessionActionErrorDialog />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
    const event = (next: SessionSummary[]) => act(() => {
        client.setQueryData(queryKeys.sessions, { sessions: next })
    })
    return { client, event }
}

function rowOf(id: string): HTMLElement {
    const row = document.querySelector<HTMLElement>(`[data-session-row-id="${id}"]`)
    if (!row) throw new Error(`row ${id} is not in the list`)
    return row
}

/** Grey: the title at half opacity and a stopped presence badge, as for an archived session. */
function lookOf(id: string) {
    const row = rowOf(id)
    const title = within(row).getByText(`Title ${id}`)
    const presence = within(row).queryByTestId('session-presence')
    return {
        grey: title.className.includes('opacity-50'),
        presence: presence?.getAttribute('data-presence') ?? null,
        archiveButton: within(row).queryByRole('button', { name: 'Archive' }),
    }
}

function rowOrder(): string[] {
    return [...document.querySelectorAll('[data-session-row-id]')].map((row) => row.getAttribute('data-session-row-id')!)
}

function pendingArchive() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-session-list-status')
    clearSessionActionFailures()
    vi.restoreAllMocks()
})

describe('session row archive is shown at once', () => {
    it('greys the row before the request answers and keeps it grey across events about the session', async () => {
        const archive = pendingArchive()
        let archived = false
        const api = {
            archiveSession: vi.fn(() => archive.promise),
            getSessions: vi.fn(async () => ({ sessions: [makeSession({ id: 'a', active: !archived, metadata: { path: '/work/app', name: 'Title a', lifecycleState: archived ? 'archived' : 'running' } })] })),
        }
        const { event } = setup([makeSession({ id: 'a' })], api)
        expect(lookOf('a')).toMatchObject({ grey: false, presence: 'waiting' })

        fireEvent.click(lookOf('a').archiveButton!)
        await waitFor(() => expect(api.archiveSession).toHaveBeenCalledWith('a'))
        expect(lookOf('a')).toMatchObject({ grey: true, presence: 'stopped' })
        expect(rowOf('a')).toHaveAttribute('data-archive-pending')
        expect(toasts).toEqual([])

        // Keep-alive patch: the agent socket is still up while the hub asks it to stop.
        event([makeSession({ id: 'a', activeAt: Date.now() })])
        expect(lookOf('a')).toMatchObject({ grey: true, presence: 'stopped' })
        // The agent disconnects: the hub's own event agrees with the look.
        event([makeSession({ id: 'a', active: false })])
        expect(lookOf('a')).toMatchObject({ grey: true, presence: 'stopped' })
        // A full record rebroadcast still says running.
        event([makeSession({ id: 'a', active: true, thinking: true })])
        expect(lookOf('a')).toMatchObject({ grey: true, presence: 'stopped' })

        archived = true
        await act(async () => archive.resolve())
        await waitFor(() => expect(toasts.map((toast) => toast.title)).toEqual(['Session archived']))
        expect(lookOf('a')).toMatchObject({ grey: true, presence: 'stopped' })
        expect(rowOf('a')).not.toHaveAttribute('data-archive-pending')
        await waitFor(() => expect(api.getSessions).toHaveBeenCalled())
        expect(lookOf('a')).toMatchObject({ grey: true, presence: 'stopped' })
    })

    it('sinks the row with the archived sessions and takes it out of the Active lens at once', async () => {
        localStorage.setItem('hapi-session-list-status', 'all')
        const archive = pendingArchive()
        const api = { archiveSession: vi.fn(() => archive.promise) }
        setup([makeSession({ id: 'top', updatedAt: 20 }), makeSession({ id: 'older', updatedAt: 10 })], api)
        const [first, second] = rowOrder()
        expect(rowOrder()).toHaveLength(2)

        fireEvent.click(lookOf(first!).archiveButton!)
        await waitFor(() => expect(api.archiveSession).toHaveBeenCalledWith(first))
        expect(rowOrder()).toEqual([second, first])

        cleanup()
        localStorage.setItem('hapi-session-list-status', 'active')
        const secondRun = pendingArchive()
        setup([makeSession({ id: 'gone', updatedAt: 20 }), makeSession({ id: 'kept', updatedAt: 10 })], { archiveSession: vi.fn(() => secondRun.promise) })
        expect(rowOrder()).toHaveLength(2)
        fireEvent.click(lookOf('gone').archiveButton!)
        await waitFor(() => expect(document.querySelector('[data-session-row-id="gone"]')).toBeNull())
        expect(rowOrder()).toEqual(['kept'])
    })

    it('keeps a selected session visible in the Active lens, grey, while its archive is in flight', async () => {
        localStorage.setItem('hapi-session-list-status', 'active')
        const archive = pendingArchive()
        const api = { archiveSession: vi.fn(() => archive.promise) }
        setup([makeSession({ id: 'sel', updatedAt: 20 }), makeSession({ id: 'other', updatedAt: 10 })], api, 'sel')

        fireEvent.click(lookOf('sel').archiveButton!)
        await waitFor(() => expect(api.archiveSession).toHaveBeenCalledWith('sel'))
        expect(rowOrder()).toEqual(['other', 'sel'])
        expect(lookOf('sel')).toMatchObject({ grey: true, presence: 'stopped' })
    })

    it('greys the row for an archive another component started', async () => {
        const archive = pendingArchive()
        const api = { archiveSession: vi.fn(() => archive.promise) }
        function Driver() {
            const { archiveSession } = useSessionActions(api as unknown as ApiClient, 'a')
            return <button type="button" onClick={() => void archiveSession().catch(() => {})}>archive from elsewhere</button>
        }
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        client.setQueryData(queryKeys.sessions, { sessions: [makeSession({ id: 'a' })] })
        render(
            <QueryClientProvider client={client}>
                <ToastProvider>
                    <I18nProvider>
                        <CachedList api={api as unknown as ApiClient} />
                        <Driver />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )
        expect(lookOf('a').grey).toBe(false)

        fireEvent.click(screen.getByRole('button', { name: 'archive from elsewhere' }))
        await waitFor(() => expect(lookOf('a').grey).toBe(true))
        expect(lookOf('a').presence).toBe('stopped')
    })

    it('reverts the row and opens the failure dialog when the archive fails', async () => {
        const archive = pendingArchive()
        const api = { archiveSession: vi.fn(() => archive.promise), getSessions: vi.fn(async () => ({ sessions: [makeSession({ id: 'a' })] })) }
        const { client } = setup([makeSession({ id: 'a' })], api)
        fireEvent.click(lookOf('a').archiveButton!)
        await waitFor(() => expect(lookOf('a').grey).toBe(true))

        await act(async () => archive.reject(new Error('Session process is still running')))
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByText('Archive could not be confirmed')).toBeInTheDocument()
        expect(within(dialog).getByText('Session process is still running')).toBeInTheDocument()
        // One action, Close (next to the dialog's own X); no Cancel, no Retry.
        const buttons = within(dialog).getAllByRole('button')
        expect(buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Close', 'Close'])
        expect(toasts).toEqual([])
        // The list is refetched so the row says what the hub says (here: still running).
        await waitFor(() => expect(api.getSessions).toHaveBeenCalled())
        expect(client.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)?.sessions[0]).toMatchObject({ id: 'a', active: true })
        expect(lookOf('a')).toMatchObject({ grey: false, presence: 'waiting' })
        expect(rowOf('a')).not.toHaveAttribute('data-archive-pending')

        // The modal hides the rest of the page from the accessibility tree while it is open.
        fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!)
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(lookOf('a').archiveButton).toBeEnabled()
    })

    it('fails into the dialog even when the row that started the archive is gone', async () => {
        localStorage.setItem('hapi-session-list-status', 'active')
        const archive = pendingArchive()
        setup([makeSession({ id: 'a' })], { archiveSession: vi.fn(() => archive.promise) })
        fireEvent.click(lookOf('a').archiveButton!)
        await waitFor(() => expect(document.querySelector('[data-session-row-id="a"]')).toBeNull())

        await act(async () => archive.reject(new Error('runner offline')))
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByText('runner offline')).toBeInTheDocument()
    })

    it('keeps Reopen off the menu while the archive is still being confirmed', async () => {
        const archive = pendingArchive()
        setup([makeSession({ id: 'a' })], { archiveSession: vi.fn(() => archive.promise), reopenSession: vi.fn() })
        fireEvent.click(lookOf('a').archiveButton!)
        await waitFor(() => expect(lookOf('a').grey).toBe(true))

        fireEvent.contextMenu(within(rowOf('a')).getByRole('button', { name: /Title a/ }))
        const reopen = screen.getByRole('menuitem', { name: 'Reopen' })
        expect(reopen).toHaveAttribute('aria-disabled', 'true')
        fireEvent.click(reopen)
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.getByText('Archiving…')).toBeInTheDocument()
    })
})

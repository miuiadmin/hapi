import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client'
import type { ReopenSessionResponse } from '@hapi/protocol/apiTypes'
import type { Session, SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider, useToast, type Toast } from '@/lib/toast-context'
import { queryKeys } from '@/lib/query-keys'
import { clearSessionActionFailures } from '@/lib/sessionActionFailures'
import { runTrackedSessionResume, useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionErrorDialog } from './SessionActionErrorDialog'
import { SessionList } from './SessionList'
import { SessionHeader } from './SessionHeader'

// A reopen is visible where it is waited for: a green spinner on the row's
// right edge until the hub confirms, then the row is active again; a failure is
// the dialog. The spinner reads the reopen key, so it shows for a reopen
// started from anywhere.

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

/** What the hub lists for an archived session: inactive, sorted with the archived rows (with a conversation, so the list keeps it). */
function archived(id: string): SessionSummary {
    return makeSession({ id, active: false, hasConversationContent: true, metadata: { path: '/work/app', name: `Title ${id}`, lifecycleState: 'archived', agentSessionId: `agent-${id}` } })
}

let toasts: Toast[] = []
function ToastProbe() {
    toasts = useToast().toasts
    return null
}

function CachedList(props: { api: ApiClient; selectedSessionId?: string | null }) {
    const { data } = useQuery({ queryKey: queryKeys.sessions, queryFn: () => props.api.getSessions() })
    return <SessionList sessions={data?.sessions ?? []} selectedSessionId={props.selectedSessionId ?? null} onSelect={vi.fn()}
        onNewSession={vi.fn()} onRefresh={vi.fn()} isLoading={false} renderHeader={false} api={props.api} />
}

function setup(sessions: SessionSummary[], api: Record<string, unknown>, extra?: ReactNode, selectedSessionId: string | null = 'a') {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    client.setQueryData(queryKeys.sessions, { sessions })
    const fullApi = api as unknown as ApiClient
    toasts = []
    render(
        <QueryClientProvider client={client}>
            <ToastProvider>
                <I18nProvider>
                    <ToastProbe />
                    {/* Selected so its project group stays open; a group of only inactive rows is folded by default. */}
                    <CachedList api={fullApi} selectedSessionId={selectedSessionId} />
                    <SessionActionErrorDialog />
                    {extra}
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

function spinnerOf(id: string) {
    return within(rowOf(id)).queryByTestId('session-reopen-spinner')
}

/** Grey: the title at half opacity, as for an inactive session. */
function isGrey(id: string): boolean {
    return within(rowOf(id)).getByText(`Title ${id}`).className.includes('opacity-50')
}

function openRowMenu(id: string) {
    fireEvent.contextMenu(within(rowOf(id)).getByRole('button', { name: new RegExp(`Title ${id}`) }))
}

function pendingReopen() {
    let resolve!: (value: ReopenSessionResponse) => void
    let reject!: (error: Error) => void
    const promise = new Promise<ReopenSessionResponse>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

afterEach(() => {
    cleanup()
    clearSessionActionFailures()
    vi.restoreAllMocks()
})

describe('session row reopen progress', () => {
    it('shows the green spinner on the row while the reopen is in flight and the row is active once the hub confirms', async () => {
        const reopen = pendingReopen()
        const api = { reopenSession: vi.fn(() => reopen.promise) }
        setup([archived('a')], api)
        expect(spinnerOf('a')).toBeNull()
        expect(isGrey('a')).toBe(true)

        openRowMenu('a')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Reopen' }))
        await waitFor(() => expect(api.reopenSession).toHaveBeenCalledWith('a'))
        const spinner = spinnerOf('a')
        expect(spinner).not.toBeNull()
        expect(spinner).toHaveAttribute('role', 'status')
        expect(spinner).toHaveAttribute('aria-label', 'Restoring session…')
        expect(spinner!.querySelector('.animate-spin')).not.toBeNull()
        expect(spinner!.querySelector('svg')!.getAttribute('class')).toContain('text-[var(--app-badge-success-text)]')
        expect(rowOf('a')).toHaveAttribute('data-reopening')
        // The row stays grey until the hub confirms.
        expect(isGrey('a')).toBe(true)
        expect(within(rowOf('a')).getByTestId('session-presence')).toHaveAttribute('data-presence', 'stopped')
        // The time gave way to the spinner.
        expect(within(rowOf('a')).queryByText(/just now|now/)).toBeNull()

        await act(async () => reopen.resolve({ ok: true, sessionId: 'a', resumed: true }))
        await waitFor(() => expect(spinnerOf('a')).toBeNull())
        expect(rowOf('a')).not.toHaveAttribute('data-reopening')
        await waitFor(() => expect(isGrey('a')).toBe(false))
        expect(within(rowOf('a')).getByTestId('session-presence')).toHaveAttribute('data-presence', 'waiting')
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('starts nothing on a second click while the reopen is in flight', async () => {
        const reopen = pendingReopen()
        const api = { reopenSession: vi.fn(() => reopen.promise) }
        setup([archived('a')], api)
        openRowMenu('a')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Reopen' }))
        await waitFor(() => expect(api.reopenSession).toHaveBeenCalledTimes(1))

        openRowMenu('a')
        const item = screen.getByRole('menuitem', { name: 'Reopen' })
        expect(item).toHaveAttribute('aria-disabled', 'true')
        expect(screen.getByText('Restoring session…')).toBeInTheDocument()
        fireEvent.click(item)
        expect(api.reopenSession).toHaveBeenCalledTimes(1)
        expect(spinnerOf('a')).not.toBeNull()
    })

    it('opens the dialog and removes the spinner when the reopen fails', async () => {
        const reopen = pendingReopen()
        const api = { reopenSession: vi.fn(() => reopen.promise) }
        setup([archived('a')], api)
        openRowMenu('a')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Reopen' }))
        await waitFor(() => expect(spinnerOf('a')).not.toBeNull())

        await act(async () => reopen.reject(new ApiError('HTTP 409 Conflict: {"error":"Runner is offline","code":"resume_unavailable"}', 409, 'resume_unavailable', '{"error":"Runner is offline","code":"resume_unavailable"}')))
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByText('Could not reopen session')).toBeInTheDocument()
        expect(within(dialog).getByText('Runner is offline')).toBeInTheDocument()
        expect(within(dialog).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Close', 'Close'])
        expect(spinnerOf('a')).toBeNull()
        expect(rowOf('a')).not.toHaveAttribute('data-reopening')
        expect(isGrey('a')).toBe(true)
        expect(toasts).toEqual([])
    })

    it('shows the spinner for a reopen the conversation view started', async () => {
        const reopen = pendingReopen()
        const api = { reopenSession: vi.fn(() => reopen.promise) }
        function Driver() {
            // The header's own hook instance, with its own mutation observer.
            const { reopenSession } = useSessionActions(api as unknown as ApiClient, 'a')
            return <button type="button" onClick={() => void reopenSession().catch(() => {})}>reopen from the header</button>
        }
        setup([archived('a')], api, <Driver />)

        fireEvent.click(screen.getByRole('button', { name: 'reopen from the header' }))
        await waitFor(() => expect(spinnerOf('a')).not.toBeNull())
        expect(isGrey('a')).toBe(true)

        await act(async () => reopen.resolve({ ok: true, sessionId: 'a', resumed: true }))
        await waitFor(() => expect(spinnerOf('a')).toBeNull())
        await waitFor(() => expect(isGrey('a')).toBe(false))
    })

    // A group of only archived rows is folded, so a reopen started elsewhere (a toast, the
    // conversation view) would spin on a row nobody sees.
    it('opens the row\'s group for a reopen started elsewhere, and keeps it open once the session runs', async () => {
        const reopen = pendingReopen()
        const api = { reopenSession: vi.fn(() => reopen.promise) }
        function Driver() {
            const { reopenSession } = useSessionActions(api as unknown as ApiClient, 'a')
            return <button type="button" onClick={() => void reopenSession().catch(() => {})}>reopen from elsewhere</button>
        }
        setup([archived('a')], api, <Driver />, null)
        const header = () => document.querySelector<HTMLElement>('[data-session-scroll-anchor] > [role="button"][aria-expanded]')!
        expect(header().getAttribute('aria-expanded')).toBe('false')

        fireEvent.click(screen.getByRole('button', { name: 'reopen from elsewhere' }))
        await waitFor(() => expect(api.reopenSession).toHaveBeenCalledWith('a'))
        expect(header().getAttribute('aria-expanded')).toBe('true')
        expect(spinnerOf('a')).not.toBeNull()

        await act(async () => reopen.resolve({ ok: true, sessionId: 'a', resumed: true }))
        await waitFor(() => expect(spinnerOf('a')).toBeNull())
        await waitFor(() => expect(isGrey('a')).toBe(false))
        expect(header().getAttribute('aria-expanded')).toBe('true')
    })

    it('folds the group again when a reopen started elsewhere fails', async () => {
        const reopen = pendingReopen()
        const api = { reopenSession: vi.fn(() => reopen.promise) }
        function Driver() {
            const { reopenSession } = useSessionActions(api as unknown as ApiClient, 'a')
            return <button type="button" onClick={() => void reopenSession().catch(() => {})}>reopen from elsewhere</button>
        }
        setup([archived('a')], api, <Driver />, null)
        const header = () => document.querySelector<HTMLElement>('[data-session-scroll-anchor] > [role="button"][aria-expanded]')!
        fireEvent.click(screen.getByRole('button', { name: 'reopen from elsewhere' }))
        await waitFor(() => expect(header().getAttribute('aria-expanded')).toBe('true'))

        await act(async () => reopen.reject(new ApiError('HTTP 409 Conflict: {"error":"Machine is offline","code":"no_machine_online"}', 409, 'no_machine_online', '{"error":"Machine is offline"}')))
        await screen.findByRole('dialog', { name: 'Could not reopen session' })
        await waitFor(() => expect(header().getAttribute('aria-expanded')).toBe('false'))
    })

    // From elsewhere the reopen finds the row down with the stopped groups ("Active first").
    it('keeps the row where it is, spinning, until the hub answers; then it moves up with the running ones', async () => {
        const reopen = pendingReopen()
        const api = { reopenSession: vi.fn(() => reopen.promise) }
        function Driver() {
            const { reopenSession } = useSessionActions(api as unknown as ApiClient, 'a')
            return <button type="button" onClick={() => void reopenSession().catch(() => {})}>reopen from elsewhere</button>
        }
        setup([
            makeSession({ id: 'a', active: false, createdAt: 3_000, hasConversationContent: true, metadata: { path: '/work/app', name: 'Title a', lifecycleState: 'archived', agentSessionId: 'agent-a' } }),
            makeSession({ id: 'b', createdAt: 1_000, active: true, metadata: { path: '/work/old', name: 'Title b' } }),
        ], api, <Driver />, null)
        const groupOrder = () => [...document.querySelectorAll('[data-session-scroll-anchor] > [role="button"][aria-expanded]')]
            .map((header) => (header.textContent ?? '').includes('work/app') ? 'work/app' : (header.textContent ?? '').includes('work/old') ? 'work/old' : 'other')
            .filter((name) => name !== 'other')
        expect(groupOrder()).toEqual(['work/old', 'work/app'])

        fireEvent.click(screen.getByRole('button', { name: 'reopen from elsewhere' }))
        await waitFor(() => expect(spinnerOf('a')).not.toBeNull())
        expect(groupOrder()).toEqual(['work/old', 'work/app'])

        await act(async () => reopen.resolve({ ok: true, sessionId: 'a', resumed: true }))
        await waitFor(() => expect(spinnerOf('a')).toBeNull())
        await waitFor(() => expect(groupOrder()).toEqual(['work/app', 'work/old']))
    })

    it('shows the spinner for a resume that ran under the reopen key outside the hook', async () => {
        let resolve!: (value: string) => void
        const target = new Promise<string>((done) => { resolve = done })
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        client.setQueryData(queryKeys.sessions, { sessions: [archived('a')] })
        let resume!: Promise<string>
        function Driver() {
            return <button type="button" onClick={() => { resume = runTrackedSessionResume(client, 'a', () => target) }}>resume before a send</button>
        }
        render(
            <QueryClientProvider client={client}>
                <ToastProvider>
                    <I18nProvider>
                        <CachedList api={{} as ApiClient} selectedSessionId="a" />
                        <Driver />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )
        expect(spinnerOf('a')).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'resume before a send' }))
        await waitFor(() => expect(spinnerOf('a')).not.toBeNull())
        await act(async () => { resolve('a'); await resume })
        await waitFor(() => expect(spinnerOf('a')).toBeNull())
    })

    it('shows the spinner for a Reopen from the archived toast', async () => {
        const reopen = pendingReopen()
        const api = { archiveSession: vi.fn(async () => {}), reopenSession: vi.fn(() => reopen.promise) }
        setup([makeSession({ id: 'a' })], api)
        fireEvent.click(within(rowOf('a')).getByRole('button', { name: 'Archive' }))
        await waitFor(() => expect(toasts.map((toast) => toast.title)).toEqual(['Session archived']))
        expect(spinnerOf('a')).toBeNull()

        await act(async () => toasts[0]?.action?.onClick())
        await waitFor(() => expect(api.reopenSession).toHaveBeenCalledWith('a'))
        expect(spinnerOf('a')).not.toBeNull()
        await act(async () => reopen.resolve({ ok: true, sessionId: 'a', resumed: true }))
        await waitFor(() => expect(spinnerOf('a')).toBeNull())
    })

    it('keeps Reopen off the header menu while the reopen is in flight', async () => {
        const reopen = pendingReopen()
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const session: Session = {
            id: 'a', active: false, thinking: false, activeTurnStartedAt: null, permissionMode: 'default',
            metadata: { flavor: 'claude', path: '/work/app', host: 'machine', lifecycleState: 'archived', claudeSessionId: 'agent-a' },
        } as unknown as Session
        function Header() {
            const { reopenSession } = useSessionActions({ reopenSession: vi.fn(() => reopen.promise) } as unknown as ApiClient, 'a')
            return (
                <>
                    <SessionHeader session={session} api={null} canReopen onBack={() => {}} onSessionReopened={vi.fn()} />
                    <button type="button" onClick={() => void reopenSession().catch(() => {})}>reopen</button>
                </>
            )
        }
        render(<QueryClientProvider client={client}><I18nProvider><ToastProvider><Header /></ToastProvider></I18nProvider></QueryClientProvider>)

        fireEvent.click(screen.getByRole('button', { name: 'reopen' }))
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        const item = await screen.findByRole('menuitem', { name: 'Reopen' })
        await waitFor(() => expect(item).toHaveAttribute('aria-disabled', 'true'))
        fireEvent.click(item)
        expect(screen.queryByRole('dialog')).toBeNull()
        await act(async () => reopen.resolve({ ok: true, sessionId: 'a', resumed: true }))
    })
})

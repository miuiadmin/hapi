import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import type { ApiClient } from '@/api/client'
import type { ReopenSessionResponse } from '@hapi/protocol/apiTypes'
import { SessionChat } from './SessionChat'
import { SessionActionErrorDialog } from './SessionActionErrorDialog'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { queryKeys } from '@/lib/query-keys'
import { clearSessionActionFailures } from '@/lib/sessionActionFailures'
import type { DecryptedMessage, Session } from '@/types/api'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useNavigate: () => async () => {}
}))

class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
    ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
}
if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = function scrollTo() {}
}

const NOTICE = 'This session is inactive. Send a message to resume.'

/** An archived session the hub can resume (its agent thread id is known). */
function makeSession(active: boolean): Session {
    return {
        id: 'ses-a',
        active,
        thinking: false,
        activeTurnStartedAt: null,
        metadata: { flavor: 'claude', path: '/repo', host: 'machine', claudeSessionId: 'agent-a', lifecycleState: active ? 'running' : 'archived' },
        permissionMode: 'default',
    } as unknown as Session
}

const rows: DecryptedMessage[] = [
    { id: 'u1', seq: 1, localId: 'u1-local', createdAt: 1000, invokedAt: 1000,
        content: { role: 'user', content: { type: 'text', text: 'earlier question' } } }
]

/** The page reads the session from its detail query, so what the mutation writes there (active again) is what the chat shows. */
function Chat(props: { api: ApiClient }) {
    const { data } = useQuery({ queryKey: queryKeys.session('ses-a'), queryFn: () => props.api.getSession('ses-a') })
    if (!data?.session) return null
    return (
        <SessionChat
            api={props.api}
            session={data.session}
            messages={rows}
            messagesWarning={null}
            hasMoreMessages={false}
            isSyncingTail={false}
            isCatchingUpFromCache={false}
            cachedTailFirstFrame={false}
            isLoadingMoreMessages={false}
            isSending={false}
            viewMode="tail"
            messagesVersion={0}
            historyVersion={0}
            tailRevision={0}
            onBack={() => {}}
            onRefresh={() => {}}
            onLoadMore={async () => 'terminal-stop' as never}
            onCancelLoadMore={() => {}}
            onSend={async () => false}
            onViewModeChange={() => {}}
            onJumpToTail={() => {}}
        />
    )
}

function pendingReopen() {
    let resolve!: (value: ReopenSessionResponse) => void
    let reject!: (error: Error) => void
    const promise = new Promise<ReopenSessionResponse>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

function setup(reopenSession: (sessionId: string) => Promise<ReopenSessionResponse>) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    client.setQueryData(queryKeys.session('ses-a'), { session: makeSession(false) })
    const api = {
        reopenSession: vi.fn(reopenSession),
        getSession: vi.fn(async () => ({ session: makeSession(false) })),
        fetchTranscriptionProviders: vi.fn(async () => []),
        listSessionTasks: vi.fn(async () => ({ tasks: [] })),
    }
    render(
        <QueryClientProvider client={client}>
            <I18nProvider>
                <ToastProvider>
                    <Chat api={api as unknown as ApiClient} />
                    <SessionActionErrorDialog />
                </ToastProvider>
            </I18nProvider>
        </QueryClientProvider>
    )
    return { client, api }
}

const banner = () => screen.queryByTestId('session-restoring-banner')
/** The failure dialog by its title (a first-use callout also has role=dialog). */
const failureDialog = () => screen.queryByRole('dialog', { name: 'Could not reopen session' })
const statusText = () => screen.queryByText(/^\s*(offline|restoring|online)\s*$/)?.textContent?.trim() ?? null

async function reopenFromHeader() {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reopen' }))
}

afterEach(() => {
    cleanup()
    clearSessionActionFailures()
    vi.restoreAllMocks()
})

describe('restoring a session from the conversation view', () => {
    it('drops the stopped notice at once, floats the banner and says "restoring" while the hub resumes, then clears by itself', async () => {
        const reopen = pendingReopen()
        const { api, client } = setup(() => reopen.promise)
        expect(await screen.findByText(NOTICE)).toBeInTheDocument()
        expect(banner()).toBeNull()
        expect(statusText()).toBe('offline')

        await reopenFromHeader()
        await waitFor(() => expect(api.reopenSession).toHaveBeenCalledWith('ses-a'))
        // At once: no waiting for the hub.
        expect(screen.queryByText(NOTICE)).toBeNull()
        const floating = banner()
        expect(floating).not.toBeNull()
        expect(floating).toHaveAttribute('role', 'status')
        expect(floating!.textContent).toContain('Restoring session…')
        expect(floating!.className).toContain('absolute')
        expect(floating!.className).toContain('pointer-events-none')
        expect(floating!.className).toContain('left-1/2')
        // The thread's own status pill (the one that says it is pulling the latest messages), not a banner of its own.
        for (const token of ['border-[var(--app-border)]', 'bg-[var(--app-bg)]/90', 'text-[var(--app-hint)]', 'top-3']) {
            expect(floating!.className.split(/\s+/)).toContain(token)
        }
        expect(floating!.className).not.toContain('app-banner')
        expect(floating!.querySelector('.animate-spin')).not.toBeNull()
        expect(document.activeElement).not.toBe(floating)
        expect(statusText()).toBe('restoring')
        expect(failureDialog()).toBeNull()

        await act(async () => reopen.resolve({ ok: true, sessionId: 'ses-a', resumed: true }))
        await waitFor(() => expect(banner()).toBeNull())
        await waitFor(() => expect(client.getQueryData<{ session: Session }>(queryKeys.session('ses-a'))?.session.active).toBe(true))
        await waitFor(() => expect(statusText()).toBe('online'))
        expect(screen.queryByText(NOTICE)).toBeNull()
        expect(failureDialog()).toBeNull()
    })

    it('brings the notice back with the dialog and the offline status when the reopen fails', async () => {
        const reopen = pendingReopen()
        const { api } = setup(() => reopen.promise)
        expect(await screen.findByText(NOTICE)).toBeInTheDocument()

        await reopenFromHeader()
        await waitFor(() => expect(banner()).not.toBeNull())
        expect(screen.queryByText(NOTICE)).toBeNull()

        await act(async () => reopen.reject(new ApiError('HTTP 409 Conflict: {"error":"Machine is offline","code":"no_machine_online"}', 409, 'no_machine_online', '{"error":"Machine is offline","code":"no_machine_online"}')))
        const dialog = await screen.findByRole('dialog', { name: 'Could not reopen session' })
        expect(within(dialog).getByText('Machine is offline')).toBeInTheDocument()
        expect(within(dialog).getByText('Machine is offline')).toBeInTheDocument()
        expect(banner()).toBeNull()
        expect(screen.getByText(NOTICE)).toBeInTheDocument()
        await waitFor(() => expect(statusText()).toBe('offline'))
    })

    it('keeps Reopen off the header menu while the restore is in flight', async () => {
        const reopen = pendingReopen()
        const { api } = setup(() => reopen.promise)
        await reopenFromHeader()
        await waitFor(() => expect(banner()).not.toBeNull())

        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        const item = await screen.findByRole('menuitem', { name: 'Reopen' })
        expect(item).toHaveAttribute('aria-disabled', 'true')
        fireEvent.click(item)
        expect(api.reopenSession).toHaveBeenCalledTimes(1)
        await act(async () => reopen.resolve({ ok: true, sessionId: 'ses-a', resumed: true }))
    })
})

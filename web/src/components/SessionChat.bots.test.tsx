import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { BotSummary } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import type { DecryptedMessage, Session } from '@/types/api'
import { SessionChat } from './SessionChat'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'

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

function bot(overrides: Partial<BotSummary> = {}): BotSummary {
    return {
        id: 'bot-1',
        name: 'Release manager',
        purpose: 'Ship every week',
        machineId: 'm1',
        homeDir: '~/.hapi/bots/release-manager',
        agent: 'claude',
        model: null,
        permissionMode: 'default',
        homeChatSessionId: 'ses-1',
        state: 'active',
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        machineOnline: true,
        homeChatActive: false,
        counts: { needsYou: 2, working: 0, workers: 0 },
        ...overrides
    }
}

function makeSession(): Session {
    return {
        id: 'ses-1',
        active: true,
        thinking: false,
        activeTurnStartedAt: null,
        metadata: {}
    } as unknown as Session
}

const rows: DecryptedMessage[] = [
    { id: 'u1', seq: 1, localId: 'u1-local', createdAt: 1_000, invokedAt: 1_000, content: { role: 'user', content: { type: 'text', text: 'hello' } } }
]

describe('SessionChat ledger entry', () => {
    afterEach(cleanup)

    function shell(bots: BotSummary[], listError?: Error): ReactNode {
        const api = {
            listBots: vi.fn(async () => {
                if (listError) throw listError
                return { bots }
            }),
            getBot: vi.fn(async () => ({ bot: bots[0] ?? null })),
            listBotNeedsYou: vi.fn(async () => ({ entries: [] })),
            listBotItems: vi.fn(async () => ({ items: [] })),
            listBotWorkers: vi.fn(async () => ({ workers: [] })),
            forkConversation: vi.fn(),
            rewindConversation: vi.fn(),
            forkPreview: vi.fn(),
            fetchTranscriptionProviders: vi.fn(async () => [])
        } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        return (
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <ToastProvider>
                        <SessionChat
                            api={api}
                            session={makeSession()}
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
                    </ToastProvider>
                </I18nProvider>
            </QueryClientProvider>
        )
    }

    it('offers the ledger on a bot\'s home chat, with what waits on the owner', async () => {
        render(shell([bot()]))
        const bar = await screen.findByTestId('bot-ledger-bar')
        expect(bar).toHaveTextContent('Ledger')
        expect(screen.getByTestId('bot-ledger-bar-badge')).toHaveTextContent('2')
        // The header icon is the desktop entry; both point at the same sheet, which starts closed.
        expect(screen.getByTestId('session-header-ledger')).toBeTruthy()
        expect(screen.queryByTestId('bot-ledger-sheet')).toBeNull()

        // Either entry opens the bot's ledger over the chat.
        const chatColumn = screen.getByTestId('bot-ledger-bar').parentElement as HTMLElement
        expect(chatColumn.classList.contains('sm:pr-[452px]')).toBe(false)
        fireEvent.click(bar)
        const sheet = await screen.findByTestId('bot-ledger-sheet')
        expect(sheet).toHaveAttribute('role', 'dialog')
        expect(await within(sheet).findByText('Release manager')).toBeInTheDocument()
        expect(within(sheet).getByRole('tab', { name: /Needs you/ })).toBeInTheDocument()
        // 高 6: on desktop (sm:) the chat column now makes room for the 440px sheet; the CSS does the rest.
        expect(chatColumn.classList.contains('sm:pr-[452px]')).toBe(true)
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close ledger' }))
        await waitFor(() => expect(screen.queryByTestId('bot-ledger-sheet')).toBeNull())
        expect(chatColumn.classList.contains('sm:pr-[452px]')).toBe(false)
    })

    it('offers nothing on a session that is not a home chat', async () => {
        render(shell([bot({ homeChatSessionId: 'somewhere-else' })]))
        await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument())
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(screen.queryByTestId('bot-ledger-bar')).toBeNull()
        expect(screen.queryByTestId('session-header-ledger')).toBeNull()
    })

    it('offers nothing on a hub that has no bot routes', async () => {
        render(shell([], new ApiError('HTTP 404 Not Found', 404)))
        await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument())
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(screen.queryByTestId('bot-ledger-bar')).toBeNull()
    })
})

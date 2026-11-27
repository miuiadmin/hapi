import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toSessionSummary, type BotSummary, type Session } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(() => {
    cleanup()
    window.localStorage.clear()
})

function session(id: string): Session {
    return {
        id, namespace: 'default', seq: 1, createdAt: 1, lastUserMessageAt: 1, updatedAt: 1,
        active: true, activeAt: 1, thinking: false, thinkingAt: 1,
        metadata: { path: '/p', host: 'mac', name: `Chat ${id}`, machineId: 'm1' },
        metadataVersion: 1, agentState: null, agentStateVersion: 1,
        model: null, modelReasoningEffort: null, effort: null, serviceTier: null
    }
}

function bot(overrides: Partial<BotSummary> = {}): BotSummary {
    return {
        id: 'bot-1',
        name: 'Release manager',
        purpose: '',
        machineId: 'm1',
        homeDir: '~/.hapi/bots/release-manager',
        agent: 'claude',
        model: null,
        permissionMode: 'default',
        homeChatSessionId: 'home-1',
        state: 'active',
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        machineOnline: true,
        homeChatActive: false,
        counts: { needsYou: 3, working: 0, workers: 0 },
        ...overrides
    }
}

function renderList(api: ApiClient | null, listError?: unknown) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onSelect = vi.fn()
    render(
        <QueryClientProvider client={client}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={[session('home-1'), session('other')].map((row) => toSessionSummary(row))}
                        onSelect={onSelect}
                        onNewSession={vi.fn()}
                        onRefresh={vi.fn()}
                        isLoading={false}
                        renderHeader={false}
                        api={api}
                        machineLabelsById={{ m1: 'Studio Mac' }}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
    return { onSelect }
}

describe('SessionList bots section', () => {
    it('is not there without an api or on a hub without bot routes', async () => {
        renderList(null)
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(screen.queryByTestId('bots-section')).toBeNull()
        cleanup()
        renderList({ listBots: vi.fn(async () => { throw new ApiError('HTTP 404 Not Found', 404) }) } as unknown as ApiClient)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(screen.queryByTestId('bots-section')).toBeNull()
        // The ordinary rows are untouched.
        expect(screen.getAllByRole('button', { name: /Chat / })).toHaveLength(2)
    })

    it('sits above the session rows, opens the home chat, and steps aside while searching', async () => {
        const api = {
            listBots: vi.fn(async () => ({ bots: [bot()] })),
            getScratchlistSessionIds: vi.fn(async () => ({ sessionIds: [] }))
        } as unknown as ApiClient
        const { onSelect } = renderList(api)
        const section = await screen.findByTestId('bots-section')
        const botRow = await within(section).findByRole('button', { name: /Release manager/ })
        expect(botRow).toHaveTextContent('Needs you: 3')
        // Above the first session row.
        const firstRow = screen.getAllByRole('button', { name: /Chat / })[0]!
        expect(section.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

        fireEvent.click(botRow)
        expect(onSelect).toHaveBeenCalledWith('home-1')

        // A metadata search hides the section until it is cleared.
        fireEvent.click(screen.getByRole('button', { name: 'Search sessions (title, path, Agent, machine name, ID, and more)' }))
        fireEvent.change(screen.getByPlaceholderText('Search title/path/Agent/machine/ID…'), { target: { value: 'Chat' } })
        await waitFor(() => expect(screen.queryByTestId('bots-section')).toBeNull())
    })
})

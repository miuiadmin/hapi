import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toSessionSummary, type BotSummary, type Session } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

type MachineLike = { id: string; namespace: string; seq: number; createdAt: number; updatedAt: number; active: boolean; activeAt: number; metadata: { displayName: string; host: string; platform: string }; metadataVersion: number; runnerState: null; runnerStateVersion: number }

function machine(id = 'm1'): MachineLike {
    return {
        id, namespace: 'default', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: { displayName: 'Studio Mac', host: 'studio', platform: 'darwin' }, metadataVersion: 1, runnerState: null, runnerStateVersion: 0
    }
}

/** An api of a hub that has bots: a list, a machine to create on, and an agent check that passes. */
function supportingApi(bots: BotSummary[] = [], listDelayMs = 0) {
    return {
        listBots: vi.fn(async () => {
            if (listDelayMs) await new Promise((resolve) => setTimeout(resolve, listDelayMs))
            return { bots }
        }),
        getScratchlistSessionIds: vi.fn(async () => ({ sessionIds: [] })),
        getMachines: vi.fn(async () => ({ machines: [machine()] })),
        getMachineAgentAvailability: vi.fn(async () => ({ agents: [{ agent: 'claude' as const, available: true }] })),
        createBot: vi.fn(async () => ({ bot: bot({ id: 'bot-2', name: 'Gardener', homeChatSessionId: 'home-2' }) }))
    }
}

function renderWithHeader(api: ApiClient | null, options: { machines?: MachineLike[]; sessions?: Session[] } = {}) {
    const machines = options.machines ?? [machine()]
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const onSelect = vi.fn()
    render(
        <QueryClientProvider client={client}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={(options.sessions ?? [session('home-1'), session('other')]).map((row) => toSessionSummary(row))}
                        onSelect={onSelect}
                        onNewSession={vi.fn()}
                        onRefresh={vi.fn()}
                        isLoading={false}
                        api={api}
                        machineLabelsById={{ m1: 'Studio Mac', m2: 'Other Mac' }}
                        machinesById={Object.fromEntries(machines.map((item) => [item.id, item])) as never}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
    return { onSelect }
}

const toolbarSlotIds = () => within(screen.getByTestId('session-list-header-actions'))
    .getAllByTestId(/^session-toolbar-slot-/)
    .map((slot) => slot.getAttribute('data-testid')?.replace('session-toolbar-slot-', ''))

afterEach(() => {
    cleanup()
    window.localStorage.clear()
})

function session(id: string, machineId = 'm1'): Session {
    return {
        id, namespace: 'default', seq: 1, createdAt: 1, lastUserMessageAt: 1, updatedAt: 1,
        active: true, activeAt: 1, thinking: false, thinkingAt: 1,
        metadata: { path: '/p', host: 'mac', name: `Chat ${id}`, machineId },
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

describe('SessionList: the way to make a bot', () => {
    it('is a robot icon in the toolbar, right after New, and not a row in the list', async () => {
        renderWithHeader(supportingApi() as unknown as ApiClient)
        const button = await screen.findByRole('button', { name: 'New bot' })
        expect(within(button).queryByText('New bot')).toBeNull()
        expect(button.querySelector('svg')).not.toBeNull()
        expect(toolbarSlotIds()).toEqual(['view', 'new', 'bots'])
        // Nothing in the list: no block, no row, whatever the number of bots.
        expect(screen.queryByTestId('bots-section')).toBeNull()
    })

    it('is still only the icon when there are bots: the block lists them and offers nothing else', async () => {
        renderWithHeader(supportingApi([bot()]) as unknown as ApiClient)
        const section = await screen.findByTestId('bots-section')
        expect(await within(section).findAllByRole('listitem')).toHaveLength(1)
        expect(within(section).queryByRole('button', { name: 'New bot' })).toBeNull()
        expect(screen.getAllByRole('button', { name: 'New bot' })).toHaveLength(1)
        expect(toolbarSlotIds()).toEqual(['view', 'new', 'bots'])
    })

    it('is not there without an api, on a hub without bot routes, before the hub has answered, or when the list failed', async () => {
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        renderWithHeader(null)
        await wait(10)
        expect(screen.queryByRole('button', { name: 'New bot' })).toBeNull()
        cleanup()

        renderWithHeader({ getScratchlistSessionIds: vi.fn(async () => ({ sessionIds: [] })), listBots: vi.fn(async () => { throw new ApiError('HTTP 404 Not Found', 404) }) } as unknown as ApiClient)
        await wait(20)
        expect(screen.queryByRole('button', { name: 'New bot' })).toBeNull()
        cleanup()

        // Loading: nothing yet, so the icon does not flash in on a hub that turns out not to have bots.
        const slow = supportingApi([], 60)
        renderWithHeader(slow as unknown as ApiClient)
        expect(screen.queryByRole('button', { name: 'New bot' })).toBeNull()
        expect(await screen.findByRole('button', { name: 'New bot' })).toBeTruthy()
        cleanup()

        // The hub has bot routes but the list failed: the block says so; creating is not offered on a guess.
        renderWithHeader({
            getScratchlistSessionIds: vi.fn(async () => ({ sessionIds: [] })),
            listBots: vi.fn(async () => { throw new ApiError('HTTP 500 Internal Server Error: {"error":"db is locked"}', 500, undefined, '{"error":"db is locked"}') })
        } as unknown as ApiClient)
        expect(await screen.findByRole('alert')).toHaveTextContent('The bots list could not be loaded.')
        expect(screen.queryByRole('button', { name: 'New bot' })).toBeNull()
    })

    it('opens the create dialog from the toolbar also while the bots block has stepped aside under a filter', async () => {
        const api = supportingApi([bot()])
        // A machine filter narrows the list, and the bots block goes with it.
        window.localStorage.setItem('hapi-session-list-machine-filter', 'm1')
        renderWithHeader(api as unknown as ApiClient, {
            machines: [machine(), machine('m2')],
            sessions: [session('home-1', 'm1'), session('other', 'm2')]
        })
        // The hub has answered (the icon is there), there is a bot to list, and the block is still aside.
        const button = await screen.findByRole('button', { name: 'New bot' })
        expect(screen.queryByTestId('bots-section')).toBeNull()

        // The action is not list content: it stays, and works.
        fireEvent.click(button)
        const dialog = await screen.findByRole('dialog')
        expect(await within(dialog).findByLabelText('Machine')).toBeTruthy()
        expect(api.createBot).not.toHaveBeenCalled()
    })

    it('closes without creating anything, and after the hub created the bot it closes and opens the home chat', async () => {
        const api = supportingApi()
        const { onSelect } = renderWithHeader(api as unknown as ApiClient)

        fireEvent.click(await screen.findByRole('button', { name: 'New bot' }))
        const dialog = await screen.findByRole('dialog')
        fireEvent.keyDown(dialog, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(api.createBot).not.toHaveBeenCalled()
        expect(onSelect).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'New bot' }))
        const again = await screen.findByRole('dialog')
        fireEvent.change(within(again).getByLabelText('Name'), { target: { value: 'Gardener' } })
        await waitFor(() => expect(within(again).getByRole('button', { name: 'Create bot' })).toBeEnabled())
        fireEvent.click(within(again).getByRole('button', { name: 'Create bot' }))
        await waitFor(() => expect(api.createBot).toHaveBeenCalledWith({ name: 'Gardener', machineId: 'm1', agent: 'claude' }))
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith('home-2'))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })
})

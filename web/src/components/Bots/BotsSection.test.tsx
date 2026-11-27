import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { BotSummary } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { queryKeys } from '@/lib/query-keys'
import { BotsSection } from './BotsSection'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
        homeChatSessionId: 'home-1',
        state: 'active',
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        machineOnline: true,
        homeChatActive: false,
        counts: { needsYou: 0, working: 0, workers: 0 },
        ...overrides
    }
}

function machine(overrides: Partial<Machine> = {}): Machine {
    return {
        id: 'm1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { displayName: 'Studio Mac', host: 'studio', platform: 'darwin' },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 0,
        ...overrides
    } as unknown as Machine
}

const ALL_AGENTS = [
    { agent: 'claude' as const, available: true },
    { agent: 'codex' as const, available: true },
    { agent: 'dsh' as const, available: true },
    { agent: 'pi' as const, available: false, reason: 'not_found' as const }
]

type SetupOptions = {
    bots?: BotSummary[]
    listError?: unknown
    /** Hold the list back so the loading state can be seen. */
    listDelayMs?: number
    machines?: Machine[]
    agents?: Array<{ agent: 'claude' | 'codex' | 'dsh' | 'pi'; available: boolean; reason?: 'not_found' | 'invalid_configuration' }>
    agentError?: Error
    createError?: Error
    created?: BotSummary
}

function setup(options: SetupOptions = {}) {
    const api = {
        listBots: vi.fn(async () => {
            if (options.listDelayMs) await sleep(options.listDelayMs)
            if (options.listError) throw options.listError
            return { bots: options.bots ?? [] }
        }),
        getMachines: vi.fn(async () => ({ machines: options.machines ?? [machine()] })),
        getMachineAgentAvailability: vi.fn(async () => {
            if (options.agentError) throw options.agentError
            return { agents: options.agents ?? ALL_AGENTS }
        }),
        createBot: vi.fn(async () => {
            if (options.createError) throw options.createError
            return { bot: options.created ?? bot({ id: 'bot-2', name: 'Gardener', homeChatSessionId: 'home-2' }) }
        }),
        deleteBot: vi.fn(async () => ({ ok: true as const }))
    }
    const onSelect = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <BotsSection api={api as unknown as ApiClient} onSelect={onSelect} />
            </I18nProvider>
        </QueryClientProvider>
    )
    return { api, onSelect, queryClient }
}

describe('BotsSection', () => {
    it('offers the way to make the first bot when there are none, and nothing else', async () => {
        setup()
        const entry = await screen.findByTestId('bots-new-first')
        expect(entry).toHaveTextContent('New bot')
        // No heading and no rows until there is a bot to list.
        expect(screen.getByTestId('bots-section').querySelector('ul')).toBeNull()
        fireEvent.click(entry)
        expect(await screen.findByRole('dialog')).toBeTruthy()
    })

    it('renders nothing on a hub that has no bot routes', async () => {
        setup({ listError: new ApiError('HTTP 404 Not Found', 404) })
        await sleep(20)
        expect(document.body.textContent).toBe('')
    })

    it('renders nothing while the list is still loading, so the entry does not flash in and out (中 8)', async () => {
        setup({ listDelayMs: 60 })
        expect(screen.queryByTestId('bots-section')).toBeNull()
        expect(screen.queryByTestId('bots-new-first')).toBeNull()
        expect(await screen.findByTestId('bots-new-first')).toBeInTheDocument()
    })

    it('says the list failed to load and offers a retry, instead of reading as "no bots" (中 8)', async () => {
        const body = '{"error":"db is locked"}'
        const { api } = setup({ listError: new ApiError(`HTTP 500 Internal Server Error: ${body}`, 500, undefined, body) })
        const section = await screen.findByTestId('bots-section')
        const alert = await within(section).findByRole('alert')
        expect(alert).toHaveTextContent('The bots list could not be loaded.')
        expect(within(section).queryByTestId('bots-new-first')).toBeNull()
        api.listBots.mockResolvedValueOnce({ bots: [bot()] })
        fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(api.listBots).toHaveBeenCalledTimes(2))
        expect(await within(section).findAllByRole('listitem')).toHaveLength(1)
        expect(within(section).queryByRole('alert')).toBeNull()
    })

    it('lists each bot with its state and the number of things waiting on the owner', async () => {
        setup({
            bots: [
                bot({ id: 'a', name: 'Rel', counts: { needsYou: 2, working: 1, workers: 1 } }),
                bot({ id: 'b', name: 'Gardener', state: 'paused', counts: { needsYou: 0, working: 0, workers: 0 } }),
                bot({ id: 'c', name: 'Broken', state: 'failed', lastError: 'spawn failed', counts: { needsYou: 0, working: 0, workers: 0 } }),
                bot({ id: 'd', name: 'Far', machineOnline: false, counts: { needsYou: 120, working: 0, workers: 0 } }),
                bot({ id: 'e', name: 'Young', state: 'creating', homeChatSessionId: null, counts: { needsYou: 0, working: 0, workers: 0 } }),
                bot({ id: 'f', name: 'Retired', state: 'archived' })
            ]
        })
        const section = await screen.findByTestId('bots-section')
        const rows = await within(section).findAllByRole('listitem')
        // In the hub's order; the archived bot is not listed. Large counts cap at 99+.
        expect(rows.map((row) => row.textContent)).toEqual([
            'RelRunningNeeds you: 22',
            'GardenerPaused',
            'BrokenError',
            'FarMachine offlineNeeds you: 12099+',
            'YoungCreating'
        ])
        expect(within(rows[2]!).getByText('Error')).toHaveClass('text-red-500')
        expect(within(rows[3]!).getByTestId('bot-needs-you-badge')).toHaveTextContent('99+')
        expect(within(section).getByRole('button', { name: 'New bot' })).toBeTruthy()
    })

    it('opens the home chat when a row is clicked', async () => {
        const { onSelect } = setup({ bots: [bot()] })
        const row = await screen.findByRole('button', { name: /Release manager/ })
        fireEvent.click(row)
        expect(onSelect).toHaveBeenCalledWith('home-1')
    })

    it('leaves a bot that has no home chat yet as a plain row', async () => {
        const { onSelect, api } = setup({ bots: [bot({ state: 'creating', homeChatSessionId: null })] })
        const row = await screen.findByRole('listitem')
        expect(row.querySelector('button')).toBeNull()
        // Still being created: nothing to archive yet either.
        expect(within(row).queryByTestId('bot-row-archive')).toBeNull()
        fireEvent.click(within(row).getByText('Release manager'))
        expect(onSelect).not.toHaveBeenCalled()
        expect(api.deleteBot).not.toHaveBeenCalled()
    })

    it('offers a failed bot without a home chat an inline archive, on two clicks (中 4)', async () => {
        const { onSelect, api } = setup({ bots: [bot({ state: 'failed', homeChatSessionId: null, lastError: 'spawn failed' })] })
        const archive = await screen.findByTestId('bot-row-archive')
        fireEvent.click(archive)
        expect(api.deleteBot).not.toHaveBeenCalled()
        expect(await screen.findByRole('button', { name: 'Confirm archive?' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Confirm archive?' }))
        await waitFor(() => expect(api.deleteBot).toHaveBeenCalledWith('bot-1'))
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('a blur on the armed archive button puts it back, and a refused archive is said', async () => {
        const body = '{"error":"cannot archive","code":"bot_not_pausable"}'
        const { api } = setup({ bots: [bot({ state: 'failed', homeChatSessionId: null })] })
        const archive = await screen.findByTestId('bot-row-archive')
        fireEvent.click(archive)
        fireEvent.blur(screen.getByRole('button', { name: 'Confirm archive?' }))
        expect(await screen.findByRole('button', { name: 'Archive' })).toBeInTheDocument()
        expect(api.deleteBot).not.toHaveBeenCalled()

        api.deleteBot.mockRejectedValueOnce(new ApiError(`HTTP 409 Conflict: ${body}`, 409, 'bot_not_pausable', body))
        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        fireEvent.click(screen.getByRole('button', { name: 'Confirm archive?' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('cannot archive')
    })
})

describe('CreateBotDialog', () => {
    async function openDialog(options: SetupOptions = {}) {
        const handles = setup({ bots: [bot()], ...options })
        fireEvent.click(await screen.findByRole('button', { name: 'New bot' }))
        const dialog = await screen.findByRole('dialog')
        return { ...handles, dialog }
    }

    async function fillName(dialog: HTMLElement, name: string) {
        fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: name } })
        const submit = within(dialog).getByRole('button', { name: 'Create bot' })
        await waitFor(() => expect(submit).toBeEnabled())
        return submit
    }

    it('refuses an empty name without calling the hub', async () => {
        const { api, dialog } = await openDialog()
        const submit = within(dialog).getByRole('button', { name: 'Create bot' })
        await waitFor(() => expect(submit).toBeEnabled())
        fireEvent.click(submit)
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a name.')
        expect(api.createBot).not.toHaveBeenCalled()
    })

    it('disables submit and says why when no machine is online', async () => {
        const { api, dialog } = await openDialog({ machines: [machine({ id: 'm0', active: false })] })
        fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Release manager' } })
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('No machine is online.')
        expect(within(dialog).getByRole('button', { name: 'Create bot' })).toBeDisabled()
        expect(api.createBot).not.toHaveBeenCalled()
    })

    it('keeps the chosen machine when it goes offline, says so, and keeps the agent and mode (中 7 ①)', async () => {
        const { api, dialog, queryClient } = await openDialog()
        await within(dialog).findByTestId('create-bot-agent-fixed')
        fireEvent.change(await within(dialog).findByLabelText('Permission mode'), { target: { value: 'plan' } })
        const name = within(dialog).getByLabelText('Name')
        fireEvent.change(name, { target: { value: 'Gardener' } })
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create bot' })).toBeEnabled())

        // The machine drops offline while the dialog is open.
        api.getMachines.mockResolvedValue({ machines: [machine({ active: false }), machine({ id: 'm2', metadata: { displayName: 'Other Mac', host: 'other', platform: 'darwin', happyCliVersion: '0.36.5' } })] })
        await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.machines }) })
        expect(await within(dialog).findByTestId('create-bot-machine-offline')).toHaveTextContent('This machine is offline.')
        expect(within(dialog).getByLabelText('Machine')).toHaveValue('m1')
        expect(within(dialog).getByRole('option', { name: 'Studio Mac (darwin) (offline)' })).toBeInTheDocument()
        expect(within(dialog).getByLabelText('Permission mode')).toHaveValue('plan')
        expect(within(dialog).getByTestId('create-bot-agent-fixed')).toHaveTextContent('Agent: Claude')
        expect(within(dialog).getByRole('button', { name: 'Create bot' })).toBeDisabled()

        // Choosing the other machine is the owner's move, not the form's.
        fireEvent.change(within(dialog).getByLabelText('Machine'), { target: { value: 'm2' } })
        await waitFor(() => expect(within(dialog).queryByTestId('create-bot-machine-offline')).toBeNull())
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create bot' })).toBeEnabled())
        fireEvent.click(within(dialog).getByRole('button', { name: 'Create bot' }))
        await waitFor(() => expect(api.createBot).toHaveBeenCalledWith({ name: 'Gardener', machineId: 'm2', agent: 'claude' }))
    })

    it('offers only supported agents: Claude alone, as a line, and the request names it (BOT_AGENT_FLAVORS)', async () => {
        const { api, dialog } = await openDialog()
        const agentLine = await within(dialog).findByTestId('create-bot-agent-fixed')
        expect(agentLine).toHaveTextContent('Agent: Claude')
        expect(within(dialog).queryByLabelText('Agent')).toBeNull()
        expect(within(dialog).queryByRole('option', { name: /Codex|DeepSeek|Pi/ })).toBeNull()
        const submit = await fillName(dialog, 'Gardener')
        fireEvent.click(submit)
        await waitFor(() => expect(api.createBot).toHaveBeenCalledWith({ name: 'Gardener', machineId: 'm1', agent: 'claude' }))
    })

    it('does not offer creation when the machine cannot run the supported agent (中 7 ②)', async () => {
        const { api, dialog } = await openDialog({ agents: [{ agent: 'claude', available: false, reason: 'not_found' }, { agent: 'codex', available: true }] })
        const alert = await within(dialog).findByRole('alert')
        expect(alert).toHaveTextContent('This machine cannot run a bot: none of the supported agents (Claude) is available on it.')
        expect(within(dialog).queryByLabelText('Agent')).toBeNull()
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create bot' })).toBeDisabled())
        fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Gardener' } })
        expect(within(dialog).getByRole('button', { name: 'Create bot' })).toBeDisabled()
        expect(api.createBot).not.toHaveBeenCalled()
    })

    it('says so when the runner needs an upgrade before it can report agents (中 7 ②)', async () => {
        const { dialog } = await openDialog({ agentError: new ApiError('HTTP 400 Bad Request: {"error":"upgrade","code":"runner_upgrade_required"}', 400, 'runner_upgrade_required') })
        expect(await within(dialog).findByRole('alert')).toHaveTextContent("Upgrade and restart this machine's HAPI runner before creating sessions.")
        expect(within(dialog).queryByRole('button', { name: 'Retry' })).toBeNull()
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create bot' })).toBeDisabled())
    })

    it('offers a retry when the agent check failed, and continues once it works (中 7 ②)', async () => {
        const { api, dialog } = await openDialog({ agentError: new ApiError('HTTP 502 Bad Gateway', 502) })
        const alert = await within(dialog).findByRole('alert')
        expect(alert).toHaveTextContent('Could not check installed Agents.')
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create bot' })).toBeDisabled())

        api.getMachineAgentAvailability.mockResolvedValue({ agents: ALL_AGENTS })
        fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
        expect(await within(dialog).findByTestId('create-bot-agent-fixed')).toHaveTextContent('Agent: Claude')
        await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull())
        const submit = await fillName(dialog, 'Gardener')
        await waitFor(() => expect(submit).toBeEnabled())
    })

    it('previews the default home folder from the name and sends the trimmed request', async () => {
        const { api, dialog } = await openDialog()
        fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  Gardener  ' } })
        fireEvent.change(within(dialog).getByLabelText('What is it for (optional)'), { target: { value: ' Water the plants ' } })
        fireEvent.click(within(dialog).getByRole('button', { name: /Advanced/ }))
        expect(await within(dialog).findByText('Default: ~/.hapi/bots/gardener. A leading ~ is resolved on the machine.')).toBeInTheDocument()

        const submit = await fillName(dialog, '  Gardener  ')
        fireEvent.click(submit)
        await waitFor(() => expect(api.createBot).toHaveBeenCalledTimes(1))
        // The permission mode stays on the hub default: it is not sent.
        expect(api.createBot).toHaveBeenCalledWith({
            name: 'Gardener',
            machineId: 'm1',
            purpose: 'Water the plants',
            agent: 'claude'
        })
    })

    it('tells a name with no letters or digits apart from a name not typed yet (低 ④)', async () => {
        const { api, dialog } = await openDialog()
        fireEvent.click(within(dialog).getByRole('button', { name: /Advanced/ }))
        expect(await within(dialog).findByText('Type a name to see the default folder (~/.hapi/bots/<name>).')).toBeInTheDocument()
        fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '!!!' } })
        expect(await within(dialog).findByText(/This name has no letters or digits to name its folder by/)).toBeInTheDocument()
        const submit = within(dialog).getByRole('button', { name: 'Create bot' })
        await waitFor(() => expect(submit).toBeEnabled())
        fireEvent.click(submit)
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('The name has no letters or digits to name its folder by.')
        expect(api.createBot).not.toHaveBeenCalled()
    })

    it('sends a custom home folder and a permission mode the owner picked', async () => {
        const { api, dialog } = await openDialog()
        fireEvent.click(within(dialog).getByRole('button', { name: /Advanced/ }))
        fireEvent.change(await within(dialog).findByLabelText('Home folder'), { target: { value: '~/bots/gardener' } })
        fireEvent.change(within(dialog).getByLabelText('Permission mode'), { target: { value: 'plan' } })
        const submit = await fillName(dialog, 'Gardener')
        fireEvent.click(submit)
        await waitFor(() => expect(api.createBot).toHaveBeenCalledTimes(1))
        expect(api.createBot).toHaveBeenCalledWith({
            name: 'Gardener',
            machineId: 'm1',
            agent: 'claude',
            permissionMode: 'plan',
            homeDir: '~/bots/gardener'
        })
    })

    it('sends the permission mode only when the owner picks one', async () => {
        const { api, dialog } = await openDialog()
        expect(await within(dialog).findByLabelText('Permission mode')).toHaveValue('')
        fireEvent.change(within(dialog).getByLabelText('Permission mode'), { target: { value: 'acceptEdits' } })
        const submit = await fillName(dialog, 'Gardener')
        fireEvent.click(submit)
        await waitFor(() => expect(api.createBot).toHaveBeenCalledTimes(1))
        expect(api.createBot).toHaveBeenCalledWith({ name: 'Gardener', machineId: 'm1', agent: 'claude', permissionMode: 'acceptEdits' })
    })

    it('closes and opens the new home chat after the hub created the bot', async () => {
        const { onSelect, dialog } = await openDialog()
        const submit = await fillName(dialog, 'Gardener')
        fireEvent.click(submit)
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith('home-2'))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('shows the hub error verbatim and stays open when the hub refuses', async () => {
        const body = '{"error":"a bot with this name already exists"}'
        const { onSelect, dialog } = await openDialog({ createError: new ApiError(`HTTP 409 Conflict: ${body}`, 409, undefined, body) })
        const submit = await fillName(dialog, 'Release manager')
        fireEvent.click(submit)
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('a bot with this name already exists')
        expect(onSelect).not.toHaveBeenCalled()
        expect(within(dialog).getByRole('button', { name: 'Create bot' })).toBeEnabled()
    })
})

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotItem, BotItemEvent, BotSummary, BotWorker, NeedsYouResponse, UpdateBotItemRequest, UpdateBotRequest } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { queryKeys } from '@/lib/query-keys'
import { ToastProvider, useToast } from '@/lib/toast-context'
import { BotLedgerSheet } from './BotLedgerSheet'

type NeedsYouEntry = NeedsYouResponse['entries'][number]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const HUB_REFUSAL = 'item is closed'
const rejection = () => new ApiError(
    `HTTP 409 Conflict: {"error":"${HUB_REFUSAL}","code":"item_closed"}`,
    409,
    'item_closed',
    `{"error":"${HUB_REFUSAL}","code":"item_closed"}`
)

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
        counts: { needsYou: 1, working: 1, workers: 1 },
        ...overrides
    }
}

function item(number: number, overrides: Partial<BotItem> = {}): BotItem {
    return {
        id: `item-${number}`,
        botId: 'bot-1',
        sessionId: 'home-1',
        number,
        title: `Item ${number}`,
        status: 'working',
        detail: `Details of ${number}`,
        ask: null,
        snoozedUntil: null,
        workerSessionId: null,
        createdAt: number,
        updatedAt: number,
        ...overrides
    }
}

const question: Extract<NeedsYouEntry, { kind: 'question' }> = {
    kind: 'question',
    itemId: 'item-3',
    number: 3,
    title: 'Also Android?',
    ask: { question: 'Should I also change the Android side?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 1 },
    workerSessionId: 'worker-1',
    updatedAt: 1
}

const request: NeedsYouEntry = { kind: 'request', sessionId: 'worker-2', requestId: 'req-7', tool: 'Bash', createdAt: 1 }

const events: BotItemEvent[] = [
    { id: 1, itemId: 'item-1', seq: 1, kind: 'created', actor: 'bot', text: '', createdAt: 1 },
    { id: 2, itemId: 'item-1', seq: 2, kind: 'comment', actor: 'bot', text: 'Starting now', createdAt: 2 }
]

function worker(overrides: Partial<BotWorker> = {}): BotWorker {
    return { sessionId: 'worker-1', name: 'android-worker', active: true, thinking: true, pendingRequests: 0, itemNumber: 1, ...overrides }
}

function ToastTitles() {
    const { toasts } = useToast()
    return <div data-testid="toast-titles">{toasts.map((toast) => toast.title).join('|')}</div>
}

type SetupOptions = {
    bot?: BotSummary
    updateError?: Error
    itemsError?: Error
    workersError?: Error
    botError?: Error
    /** The hub refuses a status change, but only after a moment, so the optimistic edit has already moved the card. */
    itemStatusRejection?: boolean
    /** The hub refuses comments after a moment. */
    commentRejection?: boolean
    commentDelayMs?: number
    /** Hold the needs-you feed back so the loading state can be seen. */
    needsYouDelayMs?: number
    workers?: BotWorker[]
}

function setup(options: SetupOptions = {}) {
    let current = options.bot ?? bot()
    let failItems = Boolean(options.itemsError)
    let items: BotItem[] = [
        item(1, { workerSessionId: 'worker-1' }),
        item(2, { status: 'done' }),
        item(3, { status: 'needs_you', ask: question.ask, workerSessionId: 'worker-1' }),
        item(4, { status: 'canceled' })
    ]
    const api = {
        getBot: vi.fn(async () => {
            if (options.botError) throw options.botError
            return { bot: current }
        }),
        listBots: vi.fn(async () => ({ bots: [current] })),
        listBotNeedsYou: vi.fn(async () => {
            if (options.needsYouDelayMs) await sleep(options.needsYouDelayMs)
            return { entries: [request, ...(items.some((entry) => entry.id === 'item-3' && entry.status === 'needs_you') ? [question] : [])] }
        }),
        listBotItems: vi.fn(async () => {
            if (failItems) throw options.itemsError
            return { items }
        }),
        listBotWorkers: vi.fn(async () => {
            if (options.workersError) throw options.workersError
            return { workers: options.workers ?? [worker(), worker({ sessionId: 'worker-2', name: null, active: false, thinking: false, pendingRequests: 2, itemNumber: null })] }
        }),
        listBotItemEvents: vi.fn(async (_botId: string, itemId: string) => ({ events: events.filter((event) => event.itemId === itemId) })),
        updateBot: vi.fn(async (_botId: string, patch: UpdateBotRequest) => {
            if (options.updateError) throw options.updateError
            current = { ...current, state: patch.paused ? 'paused' : 'active' }
            return { bot: current }
        }),
        deleteBot: vi.fn(async () => ({ ok: true as const })),
        commentBotItem: vi.fn(async (_botId: string, itemId: string, _text: string) => {
            if (options.commentDelayMs) await sleep(options.commentDelayMs)
            if (options.commentRejection) throw rejection()
            items = items.map((entry) => entry.id === itemId ? { ...entry, status: 'working', ask: null } : entry)
        }),
        updateBotItem: vi.fn(async (_botId: string, itemId: string, patch: UpdateBotItemRequest) => {
            if (options.itemStatusRejection && patch.status !== undefined) {
                await sleep(40)
                throw rejection()
            }
            items = items.map((entry) => entry.id === itemId
                ? {
                    ...entry,
                    ...(patch.status ? { status: patch.status } : {}),
                    snoozedUntil: patch.snoozedUntil === undefined ? entry.snoozedUntil : patch.snoozedUntil
                }
                : entry)
        }),
        createBotItem: vi.fn(async (_botId: string, body: { title: string; detail?: string }) => {
            items = [...items, item(5, { title: body.title, detail: body.detail ?? '', status: 'planned' })]
        })
    }
    const onOpenChange = vi.fn()
    const onOpenSession = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const ui = (isOpen: boolean) => (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <ToastProvider>
                    <BotLedgerSheet api={api as unknown as ApiClient} botId="bot-1" isOpen={isOpen} onOpenChange={onOpenChange} onOpenSession={onOpenSession} />
                    <ToastTitles />
                </ToastProvider>
            </I18nProvider>
        </QueryClientProvider>
    )
    const view = render(ui(true))
    return {
        api,
        onOpenChange,
        onOpenSession,
        queryClient,
        close: () => view.rerender(ui(false)),
        open: () => view.rerender(ui(true)),
        recoverItems: () => { failItems = false }
    }
}

const HOUR = 3_600_000

function tomorrowNineAm(from: Date): number {
    return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, 9, 0, 0, 0).getTime()
}

/** In progress → expand Item 1. */
async function openItemOne(sheet: HTMLElement) {
    fireEvent.click(within(sheet).getByRole('tab', { name: /In progress/ }))
    const row = await within(sheet).findByRole('listitem', { name: '#1 Item 1' })
    fireEvent.click(within(row).getByRole('button', { name: /Item 1/ }))
    return row
}

afterEach(() => { vi.useRealTimers() })

describe('BotLedgerSheet', () => {
    it('shows the bot, its purpose and state, and pauses and resumes it', async () => {
        const { api } = setup()
        const sheet = await screen.findByRole('dialog')
        expect(await within(sheet).findByText('Release manager')).toBeInTheDocument()
        expect(within(sheet).getByText('Ship every week')).toBeInTheDocument()
        expect(within(sheet).getByText('Running')).toBeInTheDocument()
        expect(within(sheet).getByText(/Paused: it stops handing out work/)).toBeInTheDocument()

        fireEvent.click(within(sheet).getByRole('button', { name: 'Pause bot' }))
        await waitFor(() => expect(api.updateBot).toHaveBeenCalledWith('bot-1', { paused: true }))
        const resume = await within(sheet).findByRole('button', { name: 'Resume bot' })
        expect(within(sheet).getByText('Paused')).toBeInTheDocument()

        fireEvent.click(resume)
        await waitFor(() => expect(api.updateBot).toHaveBeenCalledWith('bot-1', { paused: false }))
        await within(sheet).findByRole('button', { name: 'Pause bot' })
    })

    it('does not offer pause or resume while the bot is being created, nor archiving (低 ①)', async () => {
        setup({ bot: bot({ state: 'creating', purpose: '' }) })
        const sheet = await screen.findByRole('dialog')
        expect(await within(sheet).findByRole('button', { name: 'Pause bot' })).toBeDisabled()
        expect(within(sheet).queryByRole('button', { name: 'Archive this bot' })).toBeNull()
    })

    it('does not offer pause for a failed bot, but does offer archiving it (低 ①)', async () => {
        setup({ bot: bot({ state: 'failed', lastError: 'spawn failed' }) })
        const sheet = await screen.findByRole('dialog')
        expect(await within(sheet).findByRole('button', { name: 'Pause bot' })).toBeDisabled()
        expect(within(sheet).getByText(/spawn failed/)).toBeInTheDocument()
        expect(within(sheet).getByRole('button', { name: 'Archive this bot' })).toBeEnabled()
    })

    it('keeps the bot running and says so when the hub rejects the pause', async () => {
        setup({ updateError: new ApiError('HTTP 500 Internal Server Error: {"error":"db is locked"}', 500, undefined, '{"error":"db is locked"}') })
        const sheet = await screen.findByRole('dialog')
        fireEvent.click(await within(sheet).findByRole('button', { name: 'Pause bot' }))
        expect(await within(sheet).findByRole('alert')).toHaveTextContent('db is locked')
        expect(await within(sheet).findByRole('button', { name: 'Pause bot' })).toBeEnabled()
        expect(within(sheet).queryByText('Paused')).toBeNull()
    })

    it('switches between Needs you, In progress and Done, each with its count', async () => {
        setup()
        const sheet = await screen.findByRole('dialog')
        // The counts arrive with the lists.
        await waitFor(() => expect(within(sheet).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Needs you2', 'In progress1', 'Done2']))

        // Needs you opens first: the request and the question.
        expect(await within(sheet).findByTestId('bot-request')).toHaveTextContent('worker-2')
        expect(within(sheet).getByTestId('bot-question')).toHaveTextContent('Also Android?')

        fireEvent.click(within(sheet).getByRole('tab', { name: /In progress/ }))
        expect(await within(sheet).findByRole('listitem', { name: '#1 Item 1' })).toBeInTheDocument()
        expect(within(sheet).queryByText('Also Android?')).toBeNull()
        expect(within(sheet).queryByTestId('bot-request')).toBeNull()

        fireEvent.click(within(sheet).getByRole('tab', { name: /Done/ }))
        expect(await within(sheet).findByRole('listitem', { name: '#2 Item 2' })).toBeInTheDocument()
        expect(within(sheet).getByRole('listitem', { name: '#4 Item 4' })).toBeInTheDocument()
        expect(within(sheet).queryByRole('listitem', { name: '#1 Item 1' })).toBeNull()
    })

    it('does not say "nothing needs you" while the lists are still loading (中 3)', async () => {
        setup({ needsYouDelayMs: 60 })
        const sheet = await screen.findByRole('dialog')
        expect(await within(sheet).findByTestId('bot-ledger-loading')).toBeInTheDocument()
        expect(within(sheet).queryByText('Nothing needs you right now.')).toBeNull()
        expect(await within(sheet).findByTestId('bot-request')).toHaveTextContent('worker-2')
        expect(within(sheet).queryByTestId('bot-ledger-loading')).toBeNull()
    })

    it('answers a request in its session', async () => {
        const { onOpenChange, onOpenSession } = setup()
        const sheet = await screen.findByRole('dialog')
        fireEvent.click(await within(sheet).findByRole('button', { name: 'Answer' }))
        expect(onOpenSession).toHaveBeenCalledWith('worker-2', 'req-7')
        expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('answers a question by tapping an option, which posts that option as a comment', async () => {
        const { api } = setup()
        const sheet = await screen.findByRole('dialog')
        const recommended = await within(sheet).findByRole('button', { name: 'No (Recommended)' })
        expect(recommended).toHaveTextContent('Recommended')
        fireEvent.click(recommended)
        await waitFor(() => expect(api.commentBotItem).toHaveBeenCalledWith('bot-1', 'item-3', 'No'))
        // The fake hub moved the item back to working: the question leaves the feed.
        await waitFor(() => expect(within(sheet).queryByTestId('bot-question')).toBeNull())
    })

    it('shows the hub\'s words when it refuses an option, with a way to dismiss (中 1)', async () => {
        setup({ commentRejection: true, commentDelayMs: 40 })
        const sheet = await screen.findByRole('dialog')
        fireEvent.click(await within(sheet).findByRole('button', { name: 'No (Recommended)' }))
        const error = await within(sheet).findByRole('alert')
        expect(error).toHaveTextContent(HUB_REFUSAL)
        // The question stays: the answer did not go through.
        expect(within(sheet).getByTestId('bot-question')).toBeInTheDocument()
        fireEvent.click(within(error).getByRole('button', { name: 'Dismiss' }))
        await waitFor(() => expect(within(sheet).queryByRole('alert')).toBeNull())
    })

    it('sends one comment at a time per item: an option in flight locks the box and the other options too (中 2)', async () => {
        const { api } = setup({ commentDelayMs: 80 })
        const sheet = await screen.findByRole('dialog')
        const box = await within(sheet).findByTestId('bot-comment-box-item-3')
        fireEvent.change(within(box).getByLabelText('Comment'), { target: { value: 'Actually, wait' } })
        fireEvent.click(within(sheet).getByRole('button', { name: 'No (Recommended)' }))
        await waitFor(() => expect(within(box).getByLabelText('Comment')).toBeDisabled())
        expect(within(box).getByRole('button', { name: 'Send' })).toBeDisabled()
        expect(within(sheet).getByRole('button', { name: 'Yes' })).toBeDisabled()
        // Once it landed, the question is gone and exactly one comment was posted.
        await waitFor(() => expect(within(sheet).queryByTestId('bot-question')).toBeNull())
        expect(api.commentBotItem).toHaveBeenCalledTimes(1)
    })

    it('expands a question to show the item background', async () => {
        setup()
        const sheet = await screen.findByRole('dialog')
        const background = await within(sheet).findByRole('button', { name: 'Background' })
        expect(within(sheet).queryByText('Details of 3')).toBeNull()
        fireEvent.click(background)
        expect(within(sheet).getByText('Details of 3')).toBeInTheDocument()
        expect(within(sheet).getByRole('button', { name: 'Hide background' })).toBeInTheDocument()
    })

    it('lets the owner decide on a question without answering it: snooze, mark done, cancel (高 2)', async () => {
        const { api } = setup()
        const sheet = await screen.findByRole('dialog')
        const card = await within(sheet).findByTestId('bot-question')

        // Snooze goes at once.
        fireEvent.click(within(card).getByRole('button', { name: 'Snooze' }))
        fireEvent.click(within(card).getByRole('button', { name: 'In an hour' }))
        await waitFor(() => expect(api.updateBotItem).toHaveBeenCalledWith('bot-1', 'item-3', expect.objectContaining({ snoozedUntil: expect.any(Number) })))
        expect(await within(card).findByText(/Snoozed until/)).toBeInTheDocument()

        // Cancel takes a second click.
        fireEvent.click(within(card).getByRole('button', { name: 'Cancel item' }))
        expect(api.updateBotItem).not.toHaveBeenCalledWith('bot-1', 'item-3', { status: 'canceled' })
        fireEvent.click(within(card).getByRole('button', { name: 'Confirm cancel?' }))
        await waitFor(() => expect(api.updateBotItem).toHaveBeenCalledWith('bot-1', 'item-3', { status: 'canceled' }))
        // The fake hub closed it: the question leaves "Needs you".
        await waitFor(() => expect(within(sheet).queryByTestId('bot-question')).toBeNull())
    })

    it('marks a question done on the second click (高 2)', async () => {
        const { api } = setup()
        const sheet = await screen.findByRole('dialog')
        const card = await within(sheet).findByTestId('bot-question')
        fireEvent.click(within(card).getByRole('button', { name: 'Mark done' }))
        expect(api.updateBotItem).not.toHaveBeenCalled()
        fireEvent.click(within(card).getByRole('button', { name: 'Confirm done?' }))
        await waitFor(() => expect(api.updateBotItem).toHaveBeenCalledWith('bot-1', 'item-3', { status: 'done' }))
    })

    it('opens an item to its worker, its log, its decisions and a comment box', async () => {
        const { onOpenSession, api } = setup()
        const sheet = await screen.findByRole('dialog')
        const row = await openItemOne(sheet)
        expect(within(row).getByText('Details of 1')).toBeInTheDocument()
        expect(await within(row).findByText('Bot created the item')).toBeInTheDocument()
        expect(within(row).getByText('Starting now')).toBeInTheDocument()

        fireEvent.click(within(row).getByRole('button', { name: /Worker: android-worker/ }))
        expect(onOpenSession).toHaveBeenCalledWith('worker-1')

        fireEvent.change(within(row).getByLabelText('Comment'), { target: { value: 'Looks good' } })
        fireEvent.click(within(row).getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(api.commentBotItem).toHaveBeenCalledWith('bot-1', 'item-1', 'Looks good'))
    })

    it('snoozes an item for an hour or until tomorrow nine, and stops a snooze (高 1)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(2026, 10, 27, 8, 0, 0))
        try {
            const { api } = setup()
            const sheet = await screen.findByRole('dialog')
            let row = await openItemOne(sheet)

            fireEvent.click(within(row).getByRole('button', { name: 'Snooze' }))
            fireEvent.click(within(row).getByRole('button', { name: 'In an hour' }))
            await waitFor(() => expect(api.updateBotItem).toHaveBeenCalledWith('bot-1', 'item-1', { snoozedUntil: Date.now() + HOUR }))
            expect(await within(sheet).findByText(/Snoozed until/)).toBeInTheDocument()

            fireEvent.click(within(sheet).getByRole('tab', { name: /Done/ }))
            fireEvent.click(within(sheet).getByRole('tab', { name: /In progress/ }))
            row = await openItemOne(sheet)
            fireEvent.click(within(row).getByRole('button', { name: 'Stop snoozing' }))
            await waitFor(() => expect(api.updateBotItem).toHaveBeenCalledWith('bot-1', 'item-1', { snoozedUntil: null }))

            // At 08:00 "Tomorrow 9:00" is tomorrow, not today in an hour.
            fireEvent.click(within(row).getByRole('button', { name: 'Snooze' }))
            fireEvent.click(within(row).getByRole('button', { name: 'Tomorrow 9:00' }))
            await waitFor(() => expect(api.updateBotItem).toHaveBeenCalledWith('bot-1', 'item-1', { snoozedUntil: tomorrowNineAm(new Date(2026, 10, 27, 8, 0, 0)) }))
        } finally {
            vi.useRealTimers()
        }
    })

    it('marks an item done only on the second click, and blur puts the button back (高 3)', async () => {
        const { api } = setup()
        const sheet = await screen.findByRole('dialog')
        const row = await openItemOne(sheet)

        fireEvent.click(within(row).getByRole('button', { name: 'Mark done' }))
        expect(api.updateBotItem).not.toHaveBeenCalled()
        fireEvent.blur(within(row).getByRole('button', { name: 'Confirm done?' }))
        expect(await within(row).findByRole('button', { name: 'Mark done' })).toBeInTheDocument()
        expect(api.updateBotItem).not.toHaveBeenCalled()

        fireEvent.click(within(row).getByRole('button', { name: 'Mark done' }))
        fireEvent.click(within(row).getByRole('button', { name: 'Confirm done?' }))
        await waitFor(() => expect(api.updateBotItem).toHaveBeenCalledWith('bot-1', 'item-1', { status: 'done' }))
        await waitFor(() => expect(within(sheet).queryByRole('listitem', { name: /#1 Item 1/ })).toBeNull())
    })

    it('cancels an item on the second click', async () => {
        const { api } = setup()
        const sheet = await screen.findByRole('dialog')
        const row = await openItemOne(sheet)
        fireEvent.click(within(row).getByRole('button', { name: 'Cancel item' }))
        fireEvent.click(within(row).getByRole('button', { name: 'Confirm cancel?' }))
        await waitFor(() => expect(api.updateBotItem).toHaveBeenCalledWith('bot-1', 'item-1', { status: 'canceled' }))
    })

    it('shows a refused status change on the tab, after the optimistic edit already moved the card, until dismissed (高 3)', async () => {
        const { api } = setup({ itemStatusRejection: true })
        const sheet = await screen.findByRole('dialog')
        const row = await openItemOne(sheet)
        fireEvent.click(within(row).getByRole('button', { name: 'Cancel item' }))
        fireEvent.click(within(row).getByRole('button', { name: 'Confirm cancel?' }))

        // Optimistic: the card left "In progress" at once...
        await waitFor(() => expect(within(sheet).queryByRole('listitem', { name: /#1 Item 1/ })).toBeNull())
        // ...then the hub refused 40ms later: the error is on the tab, naming the item.
        const banner = await within(sheet).findByTestId('bot-action-error')
        expect(banner).toHaveTextContent(`#1 Item 1: ${HUB_REFUSAL}`)
        // The rollback put the item back.
        expect(await within(sheet).findByRole('listitem', { name: /#1 Item 1/ })).toBeInTheDocument()

        // It survives switching tabs; it goes when dismissed.
        fireEvent.click(within(sheet).getByRole('tab', { name: /Done/ }))
        fireEvent.click(within(sheet).getByRole('tab', { name: /In progress/ }))
        expect(within(sheet).getByTestId('bot-action-error')).toHaveTextContent(HUB_REFUSAL)
        fireEvent.click(within(within(sheet).getByTestId('bot-action-error')).getByRole('button', { name: 'Dismiss' }))
        await waitFor(() => expect(within(sheet).queryByTestId('bot-action-error')).toBeNull())
        expect(api.updateBotItem).toHaveBeenCalledTimes(1)
    })

    it('clears the tab error when the next action begins', async () => {
        const { api } = setup({ itemStatusRejection: true })
        const sheet = await screen.findByRole('dialog')
        await openItemOne(sheet)
        fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel item' }))
        fireEvent.click(within(sheet).getByRole('button', { name: 'Confirm cancel?' }))
        await within(sheet).findByTestId('bot-action-error')
        const row = await openItemOne(sheet)
        fireEvent.click(within(row).getByRole('button', { name: 'Snooze' }))
        fireEvent.click(within(row).getByRole('button', { name: 'In an hour' }))
        await waitFor(() => expect(within(sheet).queryByTestId('bot-action-error')).toBeNull())
        expect(api.updateBotItem).toHaveBeenLastCalledWith('bot-1', 'item-1', expect.objectContaining({ snoozedUntil: expect.any(Number) }))
    })

    it('adds an item for the bot', async () => {
        const { api } = setup()
        const sheet = await screen.findByRole('dialog')
        fireEvent.click(within(sheet).getByRole('tab', { name: /In progress/ }))
        fireEvent.click(within(sheet).getByRole('button', { name: 'New item' }))
        const form = within(sheet).getByRole('form', { name: 'New item' })
        fireEvent.click(within(form).getByRole('button', { name: 'Add item' }))
        expect(await within(form).findByRole('alert')).toHaveTextContent('Enter a title.')
        fireEvent.change(within(form).getByLabelText('Title'), { target: { value: '  Decide the logo  ' } })
        fireEvent.change(within(form).getByLabelText('Details (optional)'), { target: { value: 'Two options' } })
        fireEvent.click(within(form).getByRole('button', { name: 'Add item' }))
        await waitFor(() => expect(api.createBotItem).toHaveBeenCalledWith('bot-1', { title: 'Decide the logo', detail: 'Two options' }))
        expect(await within(sheet).findByRole('listitem', { name: '#5 Decide the logo' })).toBeInTheDocument()
    })

    it('keeps what was typed across tabs, and clears it when the ledger closes (高 4)', async () => {
        const { api, close, open } = setup()
        const sheet = await screen.findByRole('dialog')
        fireEvent.change(await within(sheet).findByLabelText('Comment'), { target: { value: 'Half a thought' } })

        fireEvent.click(within(sheet).getByRole('tab', { name: /In progress/ }))
        fireEvent.click(within(sheet).getByRole('button', { name: 'New item' }))
        fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Draft item' } })
        fireEvent.click(within(sheet).getByRole('tab', { name: /Done/ }))
        fireEvent.click(within(sheet).getByRole('tab', { name: /In progress/ }))
        // The form is still open with its text.
        expect(await within(sheet).findByLabelText('Title')).toHaveValue('Draft item')

        fireEvent.click(within(sheet).getByRole('tab', { name: /Needs you/ }))
        expect(await within(sheet).findByLabelText('Comment')).toHaveValue('Half a thought')
        expect(api.commentBotItem).not.toHaveBeenCalled()

        // Closing the ledger clears the drafts and the open form.
        close()
        await waitFor(() => expect(screen.queryByTestId('bot-ledger-sheet')).toBeNull())
        open()
        const reopened = await screen.findByRole('dialog')
        expect(await within(reopened).findByLabelText('Comment')).toHaveValue('')
        fireEvent.click(within(reopened).getByRole('tab', { name: /In progress/ }))
        expect(within(reopened).queryByRole('form', { name: 'New item' })).toBeNull()
    })

    it('lists the workers once expanded and opens one on tap', async () => {
        const { onOpenSession } = setup()
        const sheet = await screen.findByRole('dialog')
        const workers = await within(sheet).findByTestId('bot-workers')
        expect(workers).toHaveTextContent('2 workers, 1 waiting for an answer')
        expect(within(workers).queryByRole('button', { name: /android-worker/ })).toBeNull()
        fireEvent.click(within(workers).getByRole('button', { name: /2 workers/ }))
        const busy = await within(workers).findByRole('button', { name: /android-worker/ })
        expect(busy).toHaveTextContent('Working')
        expect(busy).toHaveTextContent('Item #1')
        const waiting = within(workers).getByRole('button', { name: /worker-/ })
        expect(waiting).toHaveTextContent('Not running')
        expect(waiting).toHaveTextContent('2')
        fireEvent.click(busy)
        expect(onOpenSession).toHaveBeenCalledWith('worker-1')
    })

    it('says "1 worker" for one (低 ③)', async () => {
        setup({ workers: [worker()] })
        const sheet = await screen.findByRole('dialog')
        expect(await within(sheet).findByTestId('bot-workers')).toHaveTextContent('1 worker')
    })

    it('shows the hub error for a list that failed to load, and retries', async () => {
        const body = '{"error":"db is locked"}'
        const { api, recoverItems } = setup({ itemsError: new ApiError(`HTTP 500 Internal Server Error: ${body}`, 500, undefined, body) })
        const sheet = await screen.findByRole('dialog')
        expect(await within(sheet).findByRole('alert')).toHaveTextContent('db is locked')
        expect(api.listBotItems).toHaveBeenCalledTimes(1)

        recoverItems()
        fireEvent.click(within(sheet).getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(api.listBotItems).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(within(sheet).queryByRole('alert')).toBeNull())
        fireEvent.click(within(sheet).getByRole('tab', { name: /In progress/ }))
        expect(await within(sheet).findByRole('listitem', { name: '#1 Item 1' })).toBeInTheDocument()
    })

    it('shows a translated line, not a key or an HTML page, when a read fails without a hub message (高 5)', async () => {
        setup({ workersError: new ApiError('HTTP 502 Bad Gateway: <html>cloudflare</html>', 502) })
        const sheet = await screen.findByRole('dialog')
        const alert = await within(sheet).findByRole('alert')
        expect(alert).toHaveTextContent('Could not load the ledger.')
        expect(alert).not.toHaveTextContent('bots.ledger.loadFailed')
        expect(alert).not.toHaveTextContent('cloudflare')
    })

    it('archives the bot after a confirmation, then closes (中 4)', async () => {
        const { api, onOpenChange } = setup()
        const sheet = await screen.findByRole('dialog')
        fireEvent.click(await within(sheet).findByRole('button', { name: 'Archive this bot' }))
        const confirm = await screen.findByRole('dialog', { name: 'Archive this bot?' })
        expect(api.deleteBot).not.toHaveBeenCalled()
        fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }))
        await waitFor(() => expect(api.deleteBot).toHaveBeenCalledWith('bot-1'))
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    })

    it('keeps the ledger open and says why when archiving is refused', async () => {
        const body = '{"error":"cannot archive while creating","code":"bot_not_pausable"}'
        const { api, onOpenChange } = setup()
        api.deleteBot.mockRejectedValueOnce(new ApiError(`HTTP 409 Conflict: ${body}`, 409, 'bot_not_pausable', body))
        const sheet = await screen.findByRole('dialog')
        fireEvent.click(await within(sheet).findByRole('button', { name: 'Archive this bot' }))
        const confirm = await screen.findByRole('dialog', { name: 'Archive this bot?' })
        fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }))
        expect(await within(confirm).findByText('cannot archive while creating')).toBeInTheDocument()
        expect(onOpenChange).not.toHaveBeenCalledWith(false)
        // The ledger is still there behind the confirm dialog (modal, so hidden from the a11y tree).
        expect(screen.getByTestId('bot-ledger-sheet')).toBeInTheDocument()
    })

    it('puts focus on the panel title when it opens, not on the pause button (中 5)', async () => {
        setup()
        const sheet = await screen.findByRole('dialog')
        await within(sheet).findByText('Release manager')
        expect(document.activeElement).toBe(within(sheet).getByTestId('bot-ledger-title'))
        expect(document.activeElement).not.toBe(within(sheet).getByRole('button', { name: 'Pause bot' }))
    })

    it('hands focus back to the visible ledger entry when it closes (中 5)', async () => {
        const hidden = document.createElement('button')
        hidden.textContent = 'hidden entry'
        hidden.setAttribute('data-ledger-entry', '')
        document.body.appendChild(hidden)
        const entry = document.createElement('button')
        entry.textContent = 'entry'
        entry.setAttribute('data-ledger-entry', '')
        entry.getClientRects = () => [{}] as unknown as DOMRectList
        document.body.appendChild(entry)
        try {
            const { close } = setup()
            const sheet = await screen.findByRole('dialog')
            await within(sheet).findByText('Release manager')
            expect(document.activeElement).not.toBe(entry)
            close()
            await waitFor(() => expect(screen.queryByTestId('bot-ledger-sheet')).toBeNull())
            expect(document.activeElement).toBe(entry)
        } finally {
            entry.remove()
            hidden.remove()
        }
    })

    it('closes with a notice when the bot no longer exists, and refreshes the list (中 6)', async () => {
        const body = '{"error":"no such bot","code":"bot_not_found"}'
        const { api, onOpenChange, queryClient } = setup()
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        const sheet = await screen.findByRole('dialog')
        await within(sheet).findByText('Release manager')
        api.getBot.mockRejectedValue(new ApiError(`HTTP 404 Not Found: ${body}`, 404, 'bot_not_found', body))
        await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.bot('bot-1') }) })
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
        expect(await screen.findByTestId('toast-titles')).toHaveTextContent('This bot no longer exists.')
        // The sidebar's list is asked to refetch, so the entry disappears.
        await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.bots }))
    })

    it('treats a 404 without the hub\'s code as a hub without bot routes: no notice, no closing (中 6)', async () => {
        const { onOpenChange } = setup({ botError: new ApiError('HTTP 404 Not Found', 404) })
        await screen.findByRole('dialog')
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(onOpenChange).not.toHaveBeenCalled()
        expect(screen.getByTestId('toast-titles')).toHaveTextContent('')
    })

    it('closed items are read-only: no comment box, no decisions (中 9)', async () => {
        const { api } = setup()
        const sheet = await screen.findByRole('dialog')
        fireEvent.click(within(sheet).getByRole('tab', { name: /Done/ }))
        const row = await within(sheet).findByRole('listitem', { name: '#2 Item 2' })
        fireEvent.click(within(row).getByRole('button', { name: /Item 2/ }))
        expect(await within(row).findByText('No activity yet.')).toBeInTheDocument()
        expect(within(row).queryByLabelText('Comment')).toBeNull()
        expect(within(row).queryByRole('button', { name: 'Mark done' })).toBeNull()
        expect(within(row).queryByRole('button', { name: 'Cancel item' })).toBeNull()
        expect(within(row).getByText(/This item is closed/)).toBeInTheDocument()
        expect(api.commentBotItem).not.toHaveBeenCalled()
    })
})

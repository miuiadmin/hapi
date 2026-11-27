import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UpdateBotItemRequest } from '@hapi/protocol'
import { apiErrorMessage, type ApiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import {
    invalidateBotLedger,
    invalidateBotSummaries,
    useBot,
    useBotItems,
    useBotMutations,
    useBotNeedsYou,
    useBotWorkers
} from '@/hooks/queries/useBots'
import { botDisplayStatus, splitBotItems, type BotItemTab } from '@/lib/bots'
import { useAddToast } from '@/lib/toast-context'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { BotItemsTab } from './BotItemsTab'
import { BotLedgerContext, type LedgerActionResult } from './BotLedgerContext'
import { BotNeedsYouTab } from './BotNeedsYouTab'
import { BotWorkersList } from './BotWorkersList'
import { focusLedgerEntry } from './ledgerEntry'
import { useLedgerDesktop } from './useLedgerDesktop'

const TABS: readonly BotItemTab[] = ['needsYou', 'inProgress', 'done']

const TAB_LABEL_KEY: Record<BotItemTab, string> = {
    needsYou: 'bots.ledger.tab.needsYou',
    inProgress: 'bots.ledger.tab.inProgress',
    done: 'bots.ledger.tab.done'
}

const STATUS_TONE_CLASS = {
    normal: 'text-[var(--app-hint)]',
    warning: 'text-[var(--app-warning-text)]',
    danger: 'text-red-500'
} as const

const BADGE_CLASS = 'inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold leading-4 text-white tabular-nums'
const ICON_BUTTON_CLASS = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-40'

/** A failed decision on an item, shown on the tab until the next action or dismissed. */
export type LedgerActionError = { text: string; itemId?: string; number?: number | null; title?: string | null }

/** What the ledger keeps across tabs and across the modal / panel remount at the breakpoint. */
export type BotLedgerView = {
    tab: BotItemTab
    setTab: (tab: BotItemTab) => void
    drafts: Readonly<Record<string, string>>
    setDraft: (id: string, text: string) => void
    addingItem: boolean
    setAddingItem: (adding: boolean) => void
    actionError: LedgerActionError | null
    setActionError: (error: LedgerActionError | null) => void
}

function CloseIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
    )
}

function ArchiveIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="3.5" rx="0.8" stroke="currentColor" strokeWidth="1.3" />
            <path d="M3.2 6v5.5a1.5 1.5 0 0 0 1.5 1.5h6.6a1.5 1.5 0 0 0 1.5-1.5V6M6.5 8.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function BotLedgerBody({ api, botId, onOpenChange, onOpenSession, view }: {
    api: ApiClient | null
    botId: string
    onOpenChange: (open: boolean) => void
    onOpenSession: (sessionId: string, requestId?: string) => void
    view: BotLedgerView
}) {
    const { t } = useTranslation()
    const addToast = useAddToast()
    const queryClient = useQueryClient()
    const { bot, isLoading: botLoading, error: botError, failed: botFailed, notFound } = useBot(api, botId)
    const { entries, isLoading: needsYouLoading, error: needsYouError, failed: needsYouFailed } = useBotNeedsYou(api, botId)
    const { items, isLoading: itemsLoading, error: itemsError, failed: itemsFailed } = useBotItems(api, botId)
    const { workers, isLoading: workersLoading, error: workersError, failed: workersFailed } = useBotWorkers(api, botId)
    const { setPaused, updateItem, commentItem, archiveBot, createItem } = useBotMutations(api)
    const [pauseError, setPauseError] = useState<string | null>(null)
    const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
    const [pendingComments, setPendingComments] = useState<ReadonlySet<string>>(new Set())
    const titleRef = useRef<HTMLHeadingElement>(null)
    const { inProgress, done } = useMemo(() => splitBotItems(items, entries), [items, entries])
    // Nothing is called empty until all four reads have landed: "nothing needs you" flashed while a request was still loading reads as all clear.
    const loading = botLoading || needsYouLoading || itemsLoading || workersLoading
    const loadFailed = botFailed || needsYouFailed || itemsFailed || workersFailed
    const loadError = loadFailed
        ? (botError ?? needsYouError ?? itemsError ?? workersError ?? t('bots.ledger.loadFailed'))
        : null
    const status = bot ? botDisplayStatus(bot) : null
    const tabCounts: Record<BotItemTab, number> = { needsYou: entries.length, inProgress: inProgress.length, done: done.length }
    const pausable = Boolean(bot) && bot?.state !== 'creating' && bot?.state !== 'failed' && bot?.state !== 'archived'

    // The bot was archived or deleted elsewhere: say so, drop it from the list, close.
    useEffect(() => {
        if (!notFound) return
        addToast({ title: t('bots.ledger.botGone'), body: '', sessionId: '', url: '' })
        void invalidateBotSummaries(queryClient, botId)
        onOpenChange(false)
    }, [notFound, addToast, queryClient, botId, onOpenChange, t])

    const openSession = useCallback((sessionId: string, requestId?: string) => {
        onOpenChange(false)
        if (requestId) onOpenSession(sessionId, requestId)
        else onOpenSession(sessionId)
    }, [onOpenChange, onOpenSession])

    const sessionLabel = useCallback((sessionId: string) => {
        if (bot && sessionId === bot.homeChatSessionId) return bot.name
        return workers.find((worker) => worker.sessionId === sessionId)?.name ?? sessionId.slice(0, 8)
    }, [bot, workers])

    const patchItem = useCallback(async (itemId: string, changes: UpdateBotItemRequest): Promise<LedgerActionResult> => {
        view.setActionError(null)
        try {
            await updateItem.mutateAsync({ botId, itemId, ...changes })
            return { ok: true }
        } catch (cause) {
            const error = apiErrorMessage(cause, t('bots.ledger.item.actionFailed'))
            const item = items.find((candidate) => candidate.id === itemId)
            view.setActionError({ text: error, itemId, number: item?.number ?? null, title: item?.title ?? null })
            return { ok: false, error }
        }
    }, [updateItem, botId, items, t, view])

    const isItemBusy = useCallback((itemId: string) => Boolean(updateItem.isPending && updateItem.variables?.itemId === itemId), [updateItem])

    const sendComment = useCallback(async (itemId: string, text: string): Promise<LedgerActionResult> => {
        setPendingComments((current) => new Set(current).add(itemId))
        try {
            await commentItem.mutateAsync({ botId, itemId, text })
            return { ok: true }
        } catch (cause) {
            return { ok: false, error: apiErrorMessage(cause, t('bots.ledger.commentFailed')) }
        } finally {
            setPendingComments((current) => {
                const next = new Set(current)
                next.delete(itemId)
                return next
            })
        }
    }, [commentItem, botId, t])

    const isCommentPending = useCallback((itemId: string) => pendingComments.has(itemId), [pendingComments])

    const togglePaused = async () => {
        if (!bot) return
        setPauseError(null)
        try {
            await setPaused.mutateAsync({ botId: bot.id, paused: bot.state !== 'paused' })
        } catch (cause) {
            setPauseError(apiErrorMessage(cause, t('bots.ledger.pauseFailed')))
        }
    }

    const archive = async () => {
        try {
            await archiveBot.mutateAsync(botId)
        } catch (cause) {
            throw new Error(apiErrorMessage(cause, t('bots.ledger.archiveFailed')))
        }
        onOpenChange(false)
    }

    const retry = () => {
        void invalidateBotSummaries(queryClient, botId)
        void invalidateBotLedger(queryClient, botId)
    }

    const ledger = bot ? {
        api,
        bot,
        onOpenSession: openSession,
        sessionLabel,
        drafts: view.drafts,
        setDraft: view.setDraft,
        patchItem,
        isItemBusy,
        sendComment,
        isCommentPending,
        createItem
    } : null

    return (
        <DialogPrimitive.Content
            aria-describedby={undefined}
            data-testid="bot-ledger-sheet"
            // The panel itself takes focus on open (never the pause button: Enter would pause); closing hands focus back to the entry it was opened from.
            onOpenAutoFocus={(event) => {
                event.preventDefault()
                titleRef.current?.focus()
            }}
            onCloseAutoFocus={(event) => {
                event.preventDefault()
                focusLedgerEntry()
            }}
            className={cn(
                'fixed inset-0 z-50 flex flex-col bg-[var(--app-bg)] pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] focus:outline-none',
                // Desktop: a sheet on the right; the chat column makes room for it (SessionChat pads by this width).
                'sm:inset-auto sm:right-0 sm:top-0 sm:h-[100dvh] sm:w-[440px] sm:max-w-full sm:border-l sm:border-[var(--app-border)] sm:shadow-2xl'
            )}
        >
            <header className="flex items-start gap-2 border-b border-[var(--app-border)] px-3 py-2">
                <div className="min-w-0 flex-1">
                    <DialogPrimitive.Title
                        ref={titleRef}
                        tabIndex={-1}
                        className="truncate text-sm font-semibold text-[var(--app-fg)] focus:outline-none"
                        data-testid="bot-ledger-title"
                    >
                        {bot?.name ?? t('bots.ledger.title')}
                    </DialogPrimitive.Title>
                    {bot?.purpose ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-[var(--app-hint)]">{bot.purpose}</p>
                    ) : null}
                    {status ? (
                        <p className={cn('mt-1 text-[11px]', STATUS_TONE_CLASS[status.tone])}>
                            {t(`bots.status.${status.key}`)}
                            {bot?.state === 'failed' && bot.lastError ? <span className="ml-1 text-[var(--app-hint)]">· {bot.lastError}</span> : null}
                        </p>
                    ) : null}
                </div>
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    disabled={!pausable || setPaused.isPending}
                    aria-describedby="bot-ledger-pause-hint"
                    onClick={() => { void togglePaused() }}
                >
                    {t(bot?.state === 'paused' ? 'bots.ledger.resume' : 'bots.ledger.pause')}
                </Button>
                {bot && bot.state !== 'creating' ? (
                    <button
                        type="button"
                        aria-label={t('bots.ledger.archive')}
                        title={t('bots.ledger.archive')}
                        disabled={archiveBot.isPending}
                        onClick={() => setArchiveConfirmOpen(true)}
                        className={ICON_BUTTON_CLASS}
                        data-testid="bot-ledger-archive"
                    >
                        <ArchiveIcon className="h-4 w-4" />
                    </button>
                ) : null}
                <DialogPrimitive.Close aria-label={t('bots.ledger.close')} className={ICON_BUTTON_CLASS}>
                    <CloseIcon className="h-4 w-4" />
                </DialogPrimitive.Close>
            </header>
            <p id="bot-ledger-pause-hint" className="px-3 pt-1.5 text-[11px] text-[var(--app-hint)]">
                {t('bots.ledger.pauseHint')}
            </p>
            {pauseError ? <p role="alert" className="px-3 pt-1 text-xs text-red-500">{pauseError}</p> : null}
            {loadError ? (
                <p role="alert" className="flex items-center gap-2 px-3 pt-1 text-xs text-red-500">
                    <span className="min-w-0 flex-1">{loadError}</span>
                    <button
                        type="button"
                        onClick={retry}
                        className="shrink-0 rounded px-2 py-0.5 text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]"
                    >
                        {t('bots.ledger.retry')}
                    </button>
                </p>
            ) : null}

            <div role="tablist" aria-label={t('bots.ledger.title')} className="mt-1 flex shrink-0 border-b border-[var(--app-border)] px-2">
                {TABS.map((key) => {
                    const selected = view.tab === key
                    const count = tabCounts[key]
                    return (
                        <button
                            key={key}
                            type="button"
                            role="tab"
                            id={`bot-ledger-tab-${key}`}
                            aria-selected={selected}
                            aria-controls="bot-ledger-panel"
                            tabIndex={selected ? 0 : -1}
                            onClick={() => view.setTab(key)}
                            onKeyDown={(event) => {
                                const index = TABS.indexOf(key)
                                const next = event.key === 'ArrowRight'
                                    ? TABS[(index + 1) % TABS.length]
                                    : event.key === 'ArrowLeft'
                                        ? TABS[(index - 1 + TABS.length) % TABS.length]
                                        : null
                                if (!next) return
                                event.preventDefault()
                                view.setTab(next)
                            }}
                            className={cn(
                                'flex min-w-0 flex-1 items-center justify-center gap-1 border-b-2 px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                                selected
                                    ? 'border-[var(--app-link)] text-[var(--app-fg)]'
                                    : 'border-transparent text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                            )}
                        >
                            <span className="truncate">{t(TAB_LABEL_KEY[key])}</span>
                            {count > 0 && !loading ? (
                                <span
                                    className={cn(
                                        'shrink-0 rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular-nums',
                                        key === 'needsYou' ? 'bg-red-600 text-white' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'
                                    )}
                                    data-testid={`bot-ledger-tab-count-${key}`}
                                >
                                    {count > 99 ? '99+' : count}
                                </span>
                            ) : null}
                        </button>
                    )
                })}
            </div>

            {view.actionError ? (
                <div
                    role="alert"
                    className="flex shrink-0 items-start gap-2 border-b border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] px-3 py-2 text-xs text-[var(--app-fg)]"
                    data-testid="bot-action-error"
                >
                    <span className="min-w-0 flex-1 break-words">
                        {view.actionError.number != null
                            ? t('bots.ledger.actionErrorItem', {
                                number: view.actionError.number,
                                title: view.actionError.title ?? '',
                                error: view.actionError.text
                            })
                            : view.actionError.text}
                    </span>
                    <button
                        type="button"
                        aria-label={t('button.dismiss')}
                        onClick={() => view.setActionError(null)}
                        className="shrink-0 rounded px-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    >
                        <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                </div>
            ) : null}

            <div
                role="tabpanel"
                id="bot-ledger-panel"
                aria-labelledby={`bot-ledger-tab-${view.tab}`}
                className="app-scroll-y min-h-0 flex-1 overflow-y-auto"
            >
                {loading ? (
                    <p className="px-3 py-6 text-center text-sm text-[var(--app-hint)]" data-testid="bot-ledger-loading">{t('misc.loading')}</p>
                ) : bot && ledger ? (
                    <BotLedgerContext.Provider value={ledger}>
                        {view.tab === 'needsYou'
                            ? <BotNeedsYouTab entries={entries} items={items} />
                            : (
                                <BotItemsTab
                                    items={view.tab === 'inProgress' ? inProgress : done}
                                    done={view.tab === 'done'}
                                    adding={view.addingItem}
                                    onAddingChange={view.setAddingItem}
                                />
                            )}
                    </BotLedgerContext.Provider>
                ) : null}
            </div>

            {bot && ledger ? (
                <BotLedgerContext.Provider value={ledger}>
                    <BotWorkersList workers={workers} />
                </BotLedgerContext.Provider>
            ) : null}

            <ConfirmDialog
                isOpen={archiveConfirmOpen}
                onClose={() => setArchiveConfirmOpen(false)}
                title={t('bots.ledger.archiveTitle')}
                description={t('bots.ledger.archiveDesc')}
                confirmLabel={t('bots.ledger.archiveConfirm')}
                confirmingLabel={t('bots.ledger.archiveConfirm')}
                onConfirm={archive}
                isPending={archiveBot.isPending}
                destructive
            />
        </DialogPrimitive.Content>
    )
}

/**
 * A bot's ledger, opened from its home chat: what needs the owner, what
 * is in progress, what is done, and the worker sessions behind it. Full
 * screen on a phone; a sheet on the right of the chat on desktop, where
 * the chat column is padded to make room for it. The view state lives
 * here, above Radix's content, so it survives tabs and the remount that
 * comes with crossing the breakpoint; it is cleared when the sheet closes.
 */
export function BotLedgerSheet({ api, botId, isOpen, onOpenChange, onOpenSession }: {
    api: ApiClient | null
    botId: string
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    onOpenSession: (sessionId: string, requestId?: string) => void
}) {
    const desktop = useLedgerDesktop()
    const [tab, setTab] = useState<BotItemTab>('needsYou')
    const [drafts, setDrafts] = useState<Record<string, string>>({})
    const [addingItem, setAddingItem] = useState(false)
    const [actionError, setActionError] = useState<LedgerActionError | null>(null)

    useEffect(() => {
        if (isOpen) return
        setTab('needsYou')
        setDrafts({})
        setAddingItem(false)
        setActionError(null)
    }, [isOpen])

    const setDraft = useCallback((id: string, text: string) => {
        setDrafts((current) => {
            if ((current[id] ?? '') === text) return current
            if (text !== '') return { ...current, [id]: text }
            const next = { ...current }
            delete next[id]
            return next
        })
    }, [])

    const view = useMemo<BotLedgerView>(() => ({
        tab, setTab, drafts, setDraft, addingItem, setAddingItem, actionError, setActionError
    }), [tab, drafts, setDraft, addingItem, actionError])

    return (
        <DialogPrimitive.Root open={isOpen} onOpenChange={onOpenChange} modal={!desktop}>
            <DialogPrimitive.Portal>
                <BotLedgerBody api={api} botId={botId} onOpenChange={onOpenChange} onOpenSession={onOpenSession} view={view} />
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}

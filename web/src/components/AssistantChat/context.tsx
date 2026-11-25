import type { ReactNode } from 'react'
import { createContext, useContext, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { TerminalToolDisplayMode } from '@/hooks/useToolCardDisplayMode'
import type { SessionMetadataSummary } from '@/types/api'

export type OlderHistoryLoadResult = 'loaded' | 'transient-stop' | 'terminal-stop'

/**
 * Status that changes while a session opens or pages through history:
 * `isSyncingTail` flips on every tail-sync step (8~13 times per open),
 * `isLoadingMoreMessages` / `hasMoreMessages` on every page turn.
 *
 * It is published on its own context so only the few components that display
 * it (load-older sentinels, sync capsules) re-render with it. The message rows
 * read the stable context only and no longer re-render for status churn.
 */
export type HappyChatStatusValue = {
    hasMoreMessages: boolean
    isSyncingTail: boolean
    isLoadingMoreMessages: boolean
}

type HappyChatStableValue = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    terminalToolDisplayMode: TerminalToolDisplayMode
    /** Hub-wide AGENT_NOTIFY_SUMMARY chat display; polled once at chat shell. */
    showSessionSummaryInChat: boolean
    disabled: boolean
    allowInactiveFork?: boolean
    onRefresh: () => void
    codexPlanProposalId?: string | null
    onContinuePlan?: (planId: string) => void
    continuedPlanIds?: ReadonlySet<string>
    onRetryMessage?: (localId: string) => void
    historyActionPending?: boolean
    onBranchConversation?: (messageLocalId?: string, messageId?: string) => void
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    assistantForkPoints?: ReadonlyMap<string, string>
    onShareTurn?: (
        messageElement: HTMLElement | string | null,
        clientY?: number,
        fallbackSnapshot?: { html: string; text: string; role?: 'user' | 'assistant' }
    ) => void
    onNestedScrollFollowChange?: (followLatest: boolean) => void
    loadOlderMessagesPreservingScroll: () => Promise<OlderHistoryLoadResult>
}

/**
 * The chat context as the rows see it. The status fields stay in the type
 * (optional) because the provider takes one object holding both halves; they
 * are NOT published on this context — a read through `useHappyChatContext()`
 * yields `undefined`. Read them with `useHappyChatStatus()`.
 */
export type HappyChatContextValue = HappyChatStableValue & Partial<HappyChatStatusValue>

const HappyChatContext = createContext<HappyChatStableValue | null>(null)
const HappyChatStatusContext = createContext<HappyChatStatusValue | null>(null)

const NO_CONTINUED_PLANS: ReadonlySet<string> = new Set()

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    // Keep dismissal outside virtualized cards so recycling cannot revive a menu.
    const [continued, setContinued] = useState<{ sessionId: string; ids: ReadonlySet<string> }>({
        sessionId: props.value.sessionId, ids: new Set()
    })
    const ids = continued.sessionId === props.value.sessionId ? continued.ids : NO_CONTINUED_PLANS
    const {
        api, sessionId, metadata, terminalToolDisplayMode, showSessionSummaryInChat, disabled, allowInactiveFork,
        onRefresh, codexPlanProposalId, onContinuePlan, onRetryMessage, historyActionPending,
        onBranchConversation, onForkConversation, onRewindConversation, isLatestCompletedBoundary,
        assistantForkPoints, onShareTurn, onNestedScrollFollowChange, loadOlderMessagesPreservingScroll,
        hasMoreMessages, isSyncingTail, isLoadingMoreMessages,
    } = props.value
    // One value object for as long as none of these fields change. Before this
    // the object was rebuilt on every render of the thread, which re-rendered
    // every memoized message row each time a sync-status field flipped.
    const value = useMemo<HappyChatStableValue>(() => ({
        api,
        sessionId,
        metadata,
        terminalToolDisplayMode,
        showSessionSummaryInChat,
        disabled,
        allowInactiveFork,
        onRefresh,
        codexPlanProposalId,
        continuedPlanIds: ids,
        onContinuePlan: onContinuePlan ? (planId: string) => {
            if (disabled || codexPlanProposalId !== planId || ids.has(planId)) return
            setContinued({ sessionId, ids: new Set([...ids, planId]) })
            onContinuePlan(planId)
        } : undefined,
        onRetryMessage,
        historyActionPending,
        onBranchConversation,
        onForkConversation,
        onRewindConversation,
        isLatestCompletedBoundary,
        assistantForkPoints,
        onShareTurn,
        onNestedScrollFollowChange,
        loadOlderMessagesPreservingScroll,
    }), [
        api, sessionId, metadata, terminalToolDisplayMode, showSessionSummaryInChat, disabled, allowInactiveFork,
        onRefresh, codexPlanProposalId, ids, onContinuePlan, onRetryMessage, historyActionPending,
        onBranchConversation, onForkConversation, onRewindConversation, isLatestCompletedBoundary,
        assistantForkPoints, onShareTurn, onNestedScrollFollowChange, loadOlderMessagesPreservingScroll,
    ])
    const status = useMemo<HappyChatStatusValue>(() => ({
        hasMoreMessages: hasMoreMessages === true,
        isSyncingTail: isSyncingTail === true,
        isLoadingMoreMessages: isLoadingMoreMessages === true,
    }), [hasMoreMessages, isSyncingTail, isLoadingMoreMessages])
    return (
        <HappyChatContext.Provider value={value}>
            <HappyChatStatusContext.Provider value={status}>
                {props.children}
            </HappyChatStatusContext.Provider>
        </HappyChatContext.Provider>
    )
}

export function useOptionalHappyChatContext(): HappyChatContextValue | null {
    return useContext(HappyChatContext)
}

export function useHappyChatContext(): HappyChatContextValue {
    const ctx = useOptionalHappyChatContext()
    if (!ctx) {
        throw new Error('HappyChatContext is missing')
    }
    return ctx
}

/** Tail-sync / paging status. Only components that display it should subscribe. */
export function useOptionalHappyChatStatus(): HappyChatStatusValue | null {
    return useContext(HappyChatStatusContext)
}

export function useHappyChatStatus(): HappyChatStatusValue {
    const status = useOptionalHappyChatStatus()
    if (!status) {
        throw new Error('HappyChatStatusContext is missing')
    }
    return status
}

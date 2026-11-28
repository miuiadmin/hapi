import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { DecryptedMessage } from '@/types/api'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { EMPTY_STATE } from '@/hooks/queries/useMessages'
import { useScheduledReleaseTick } from '@/hooks/useScheduledReleaseTick'
import { getAbortedSendsVersion, subscribeAbortedSends } from '@/lib/abortedSends'
import { isParkedScheduled, isWaitingForAgent, sortQueuedMessages } from '@/lib/pending-messages'

type RowSelector = (messages: readonly DecryptedMessage[], now: number, sessionId: string) => DecryptedMessage[]

function selectWaiting(messages: readonly DecryptedMessage[], now: number, sessionId: string): DecryptedMessage[] {
    return sortQueuedMessages(messages.filter((row) => isWaitingForAgent(row, now, sessionId)))
}

function selectParked(messages: readonly DecryptedMessage[], now: number, sessionId: string): DecryptedMessage[] {
    return sortQueuedMessages(messages.filter((row) => isParkedScheduled(row, now, sessionId)))
}

function useMessageRows(sessionId: string, select: RowSelector): DecryptedMessage[] {
    const state = useSyncExternalStore(
        useCallback((listener) => subscribeMessageWindow(sessionId, listener), [sessionId]),
        useCallback(() => getMessageWindowState(sessionId), [sessionId]),
        () => EMPTY_STATE
    )
    // A send cancelled in flight leaves this list without the window changing.
    const abortedSendsVersion = useSyncExternalStore(subscribeAbortedSends, getAbortedSendsVersion, getAbortedSendsVersion)
    const now = useScheduledReleaseTick(state.messages)
    return useMemo(() => select(state.messages, now, sessionId), [state, now, sessionId, abortedSendsVersion, select])
}

/**
 * The user messages on their way to the agent, in the order they were sent.
 *
 * Exactly one of them is in the thread, the first: the message the user most recently saw leave the
 * composer and not yet taken. The rest wait in the queue panel above the composer (QueuedMessagesBar),
 * and each takes the thread's place in turn as the one before it is taken. Two messages drawn in
 * the thread at once would read as two sent at once, and one at a time is what is sent.
 */
export function useWaitingMessages(sessionId: string): DecryptedMessage[] {
    return useMessageRows(sessionId, selectWaiting)
}

/** The messages scheduled for a time still ahead: not sent yet, so only in the queue panel. */
export function useParkedScheduled(sessionId: string): DecryptedMessage[] {
    return useMessageRows(sessionId, selectParked)
}

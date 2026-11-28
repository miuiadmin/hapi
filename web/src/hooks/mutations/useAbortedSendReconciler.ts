import { useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { forgetSendAborted, isSendAborted, listAbortedSends, subscribeAbortedSends } from '@/lib/abortedSends'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'

/**
 * How long after a cancel in flight before the hub is asked outright whether it has the message.
 * By then a request that was going to arrive has.
 */
export const ABORTED_SEND_PROBE_DELAY_MS = 1_500

function findRowByLocalId(sessionId: string, localId: string): DecryptedMessage | null {
    for (const message of getMessageWindowState(sessionId).messages) {
        if (message.localId === localId) return message
    }
    return null
}

/**
 * Settles the sends the user cancelled while their POST was in flight (see lib/abortedSends).
 *
 * Stopping the request cannot recall what the hub may already hold, so the cancel is not a fact
 * until the hub has answered for it. Three ways that answer comes, whichever first:
 *
 *  - the hub's row turns up in the window: still waiting for the agent, it is cancelled for real;
 *    already taken, the message was sent after all;
 *  - the hub is asked by local id (after a pause, and again for what a reload left behind): this
 *    catches a row whose echo never reached this page;
 *  - nothing answers for it in ten minutes: the entry is dropped.
 *
 * Either way the user is told how it went, because a cancelled message that still goes out is the
 * one failure they cannot see for themselves. Mount one per open session.
 */
export function useAbortedSendReconciler(
    api: ApiClient | null,
    sessionId: string | null,
    options: { probeDelayMs?: number } = {},
): void {
    const probeDelayMs = options.probeDelayMs ?? ABORTED_SEND_PROBE_DELAY_MS
    const cancelMutation = useCancelQueuedMessage(api)
    const cancelMutationRef = useRef(cancelMutation)
    cancelMutationRef.current = cancelMutation
    const { addToast } = useToast()
    const { t } = useTranslation()
    const wording = useRef({ addToast, t })
    wording.current = { addToast, t }

    useEffect(() => {
        if (!sessionId || !api) return
        let disposed = false
        let probeTimer: ReturnType<typeof setTimeout> | null = null
        /** Local ids with a request on the wire, so a second notification does not repeat it. */
        const cancelling = new Set<string>()
        /** Local ids whose outcome was already told to the user, so it is told once. */
        const reported = new Set<string>()
        /** Probes in a row that the hub did not answer; the next one waits longer. */
        let unansweredProbes = 0

        const say = (key: 'queuedMessages.cancelled' | 'queuedMessages.cancelTooLate' | 'queuedMessages.cancelFailed', localId: string) => {
            if (reported.has(localId)) return
            reported.add(localId)
            wording.current.addToast({ title: wording.current.t(key), body: '', sessionId, url: window.location.href })
        }
        const stillAborted = (localId: string) => !disposed && isSendAborted(sessionId, localId)

        /** The hub's row is in the window: cancel it through the mutation, which also puts the window right. */
        const cancelWindowRow = (localId: string, row: DecryptedMessage) => {
            cancelling.add(localId)
            cancelMutationRef.current.mutateAsync({ sessionId, messageId: row.id, localId, snapshot: row })
                .then((result) => {
                    if (!isSendAborted(sessionId, localId)) return
                    // `cancelled` leaves the row gone. Any other answer put a row back (taken by the
                    // agent, or an outcome still unresolved), and that row is the user's to see.
                    say(result.status === 'invoked' ? 'queuedMessages.cancelTooLate' : result.status === 'cancelled' ? 'queuedMessages.cancelled' : 'queuedMessages.cancelFailed', localId)
                    forgetSendAborted(sessionId, localId)
                }, () => {
                    // useCancelQueuedMessage put the row back: it must show again, with its cancel.
                    say('queuedMessages.cancelFailed', localId)
                    forgetSendAborted(sessionId, localId)
                })
                .finally(() => cancelling.delete(localId))
        }

        const reconcile = () => {
            if (disposed) return
            for (const entry of listAbortedSends(sessionId)) {
                const localId = entry.localId
                if (cancelling.has(localId)) continue
                const row = findRowByLocalId(sessionId, localId)
                // No row yet, or still the device's own copy: the hub's answer is the probe's to get.
                if (!row || row.id === localId) continue
                if (row.invokedAt != null) {
                    // Taken before the cancel could matter: it is a sent message like any other.
                    say('queuedMessages.cancelTooLate', localId)
                    forgetSendAborted(sessionId, localId)
                    continue
                }
                cancelWindowRow(localId, row)
            }
        }

        /** Asks the hub, by local id, about every send still waiting for an answer. */
        const probe = async () => {
            const localIds = listAbortedSends(sessionId).map((entry) => entry.localId).filter((localId) => !cancelling.has(localId))
            if (localIds.length === 0) return
            let state: Awaited<ReturnType<ApiClient['getQueuedState']>>
            try {
                const answer = await api.getQueuedState(sessionId, localIds)
                if (!answer || !Array.isArray(answer.invokedLocalMessages) || !Array.isArray(answer.queuedLocalIds)) {
                    throw new Error('the hub did not say which of these messages it has')
                }
                state = answer
            } catch {
                // Not answered. The question stands, so it is asked again, each time after a
                // longer wait, up to three times; after that what arrives by echo still settles it.
                if (unansweredProbes < 3) scheduleProbe(probeDelayMs * 4 ** unansweredProbes)
                unansweredProbes += 1
                return
            }
            unansweredProbes = 0
            if (disposed) return
            for (const localId of localIds) {
                if (!stillAborted(localId) || cancelling.has(localId)) continue
                const taken = state.invokedLocalMessages.some((message) => message.localId === localId)
                if (taken) {
                    say('queuedMessages.cancelTooLate', localId)
                    forgetSendAborted(sessionId, localId)
                    continue
                }
                const waiting = state.queuedLocalIds.includes(localId)
                    || (state.indeterminateLocalIds ?? []).includes(localId)
                if (!waiting) {
                    // The hub has no such message, so none was sent. The entry stays until it
                    // expires: on a slow line the request could still be on its way.
                    say('queuedMessages.cancelled', localId)
                    continue
                }
                cancelling.add(localId)
                // The hub knows a row by its local id as well as by its own.
                api.cancelMessage(sessionId, localId)
                    .then((result) => {
                        if (result.status === 'invoked') say('queuedMessages.cancelTooLate', localId)
                        else say(result.status === 'cancelled' ? 'queuedMessages.cancelled' : 'queuedMessages.cancelFailed', localId)
                        forgetSendAborted(sessionId, localId)
                    }, () => {
                        // Not answered: asked again on the next pass.
                    })
                    .finally(() => cancelling.delete(localId))
            }
        }
        const scheduleProbe = (delayMs = probeDelayMs) => {
            if (probeTimer !== null) clearTimeout(probeTimer)
            probeTimer = setTimeout(() => { probeTimer = null; void probe() }, delayMs)
        }

        reconcile()
        scheduleProbe()
        const unsubscribeWindow = subscribeMessageWindow(sessionId, reconcile)
        const unsubscribeAborted = subscribeAbortedSends(() => { reconcile(); scheduleProbe() })
        return () => {
            disposed = true
            if (probeTimer !== null) clearTimeout(probeTimer)
            unsubscribeWindow()
            unsubscribeAborted()
        }
    }, [sessionId, api, probeDelayMs])
}

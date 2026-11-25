import { getLiveReasoningStreamId, getReasoningStreamId, getTextLiveStreamId, getTextStreamId } from '@hapi/protocol/messages'
import type { DecryptedMessage } from '@/types/api'
import { randomId } from '@/lib/randomId'

export function makeClientSideId(prefix: string): string {
    return `${prefix}-${randomId()}`
}

export function isUserMessage(msg: DecryptedMessage): boolean {
    const content = msg.content
    if (content && typeof content === 'object' && 'role' in content) {
        return (content as { role: string }).role === 'user'
    }
    return false
}

/** A user message that is still waiting for the CLI ack (messages-consumed).
 *  Strict null on `invokedAt` so a pre-V8 hub response that omits the field
 *  (`undefined`) is treated as already-invoked; only optimistic / V8-loaded
 *  rows that explicitly carry `invokedAt: null` are queued. `failed` rows are
 *  not queued either — they're surfaced as send errors, not pending work. */
export function isQueuedForInvocation(msg: DecryptedMessage): boolean {
    return isUserMessage(msg) && msg.invokedAt === null && msg.status !== 'failed'
}

function isOptimisticMessage(msg: DecryptedMessage): boolean {
    return Boolean(msg.localId && msg.id === msg.localId)
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
    const aTime = a.invokedAt ?? a.createdAt
    const bTime = b.invokedAt ?? b.createdAt

    if (aTime !== bTime) {
        return aTime - bTime
    }

    const aSeq = typeof a.seq === 'number' ? a.seq : null
    const bSeq = typeof b.seq === 'number' ? b.seq : null

    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return aSeq - bSeq
    }
    return a.id.localeCompare(b.id)
}

// Invariant: a message the CLI has consumed (invokedAt set) is delivered, not
// queued. A message delivered immediately — e.g. steered into the active turn —
// can carry a stale optimistic 'queued' status while its invokedAt is already
// set; normalize so the queued clock never lingers on a delivered message.
function clearStaleQueuedStatus(list: DecryptedMessage[]): DecryptedMessage[] {
    return list.map((msg) =>
        msg.status === 'queued' && msg.invokedAt != null
            ? { ...msg, status: 'sent' as DecryptedMessage['status'] }
            : msg
    )
}

/**
 * Whether a row served again is the row the window already holds: the same
 * fingerprint and the same content. A page that brings nothing new then
 * leaves the list as it was, object by object, and the thread is not rendered
 * again for it. Rows without a fingerprint (older hubs, local rows) never
 * count as the same — a fresh object is what there was before — save for the
 * event stream's copy of a labelled row (`sameRowAsHeld`).
 */
function sameMessage(held: DecryptedMessage, served: DecryptedMessage): boolean {
    return held.rowHash !== undefined
        && held.rowHash === served.rowHash
        && JSON.stringify(held) === JSON.stringify(served)
}

/** What the event stream never carries on a row: the fingerprint a page labels it with, and the revision counter. */
const STREAM_ABSENT_FIELDS: ReadonlySet<string> = new Set(['rowHash', 'contentRevision'])

/** A row as JSON with its keys sorted at every level, the named fields left out, and a field that
 *  is null or absent counting for the same thing: a page writes `scheduledAt: null` where the stream
 *  leaves the field out, and both say the row has none. */
function stableJson(value: unknown, skip: ReadonlySet<string>): string {
    if (value === null || value === undefined) return 'null'
    if (typeof value !== 'object') return `${JSON.stringify(value)}`
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, skip)).join(',')}]`
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter((key) => record[key] !== undefined && record[key] !== null && !skip.has(key)).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key], skip)}`).join(',')}}`
}

/**
 * Whether a row served without a fingerprint is the row the window holds.
 * The event stream serves every row that way — it is the hub's own copy of a
 * row a page labelled, minus the fingerprint and the revision counter — and it
 * says nothing the held row does not when everything else about the two is
 * equal, key order aside (the hub builds the stream's copy field by field; a
 * page's row comes off the wire in its own order). Such a copy then leaves the
 * held row in place, fingerprint included, instead of replacing a row the
 * reconcile just checked with one the next open has to fetch again.
 */
function sameRowAsHeld(held: DecryptedMessage, served: DecryptedMessage): boolean {
    if (held.rowHash === undefined || served.rowHash !== undefined) return false
    return stableJson(held, STREAM_ABSENT_FIELDS) === stableJson(served, STREAM_ABSENT_FIELDS)
}

export function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    if (existing.length === 0) {
        return clearStaleQueuedStatus(sweepSettledSnapshots([...incoming])).sort(compareMessages)
    }
    if (incoming.length === 0) {
        return clearStaleQueuedStatus(sweepSettledSnapshots([...existing])).sort(compareMessages)
    }

    const byId = new Map<string, DecryptedMessage>()
    for (const msg of existing) {
        byId.set(msg.id, msg)
    }
    for (const msg of incoming) {
        const existing = byId.get(msg.id)
        if (existing) {
            // Preserve client-only signals the incoming (server) copy can't carry:
            // a late ack timestamp, the live 'steered' marker (not persisted), and
            // force-dismiss of an indeterminate queued row (#1839).
            const preserved: Partial<DecryptedMessage> = {}
            if (existing.invokedAt != null && msg.invokedAt == null) {
                preserved.invokedAt = existing.invokedAt
            }
            if (existing.steered && !msg.steered) {
                preserved.steered = true
            }
            if (
                existing.queueDismissed
                && msg.invokedAt === null
                && msg.deliveryState === 'indeterminate'
            ) {
                preserved.queueDismissed = true
            }
            const merged: DecryptedMessage = Object.keys(preserved).length > 0 ? { ...msg, ...preserved } : msg
            byId.set(msg.id, sameMessage(existing, merged) || sameRowAsHeld(existing, merged) ? existing : merged)
        } else {
            byId.set(msg.id, msg)
        }
    }

    let merged = Array.from(byId.values())

    const incomingStoredLocalIds = new Set<string>()
    for (const msg of incoming) {
        if (msg.localId && !isOptimisticMessage(msg)) {
            incomingStoredLocalIds.add(msg.localId)
        }
    }

    // If we received stored messages with a localId, drop any optimistic bubbles with the same localId.
    // Preserve client-side status (e.g. 'queued') and invokedAt on the replacing server message.
    if (incomingStoredLocalIds.size > 0) {
        const optimisticStatusByLocalId = new Map<string, DecryptedMessage['status']>()
        const optimisticInvokedAtByLocalId = new Map<string, number | null | undefined>()
        const optimisticSteeredByLocalId = new Map<string, boolean>()
        const optimisticQueueDismissedByLocalId = new Map<string, boolean>()
        for (const msg of merged) {
            if (msg.localId && isOptimisticMessage(msg) && incomingStoredLocalIds.has(msg.localId)) {
                if (msg.status) {
                    optimisticStatusByLocalId.set(msg.localId, msg.status)
                }
                if (msg.invokedAt !== undefined) {
                    optimisticInvokedAtByLocalId.set(msg.localId, msg.invokedAt)
                }
                if (msg.steered) {
                    optimisticSteeredByLocalId.set(msg.localId, true)
                }
                if (msg.queueDismissed) {
                    optimisticQueueDismissedByLocalId.set(msg.localId, true)
                }
            }
        }
        merged = merged.filter((msg) => {
            if (!msg.localId || !incomingStoredLocalIds.has(msg.localId)) {
                return true
            }
            return !isOptimisticMessage(msg)
        })
        if (
            optimisticStatusByLocalId.size > 0
            || optimisticInvokedAtByLocalId.size > 0
            || optimisticSteeredByLocalId.size > 0
            || optimisticQueueDismissedByLocalId.size > 0
        ) {
            merged = merged.map((msg) => {
                if (!msg.localId) return msg
                const update: Partial<DecryptedMessage> = {}
                if (optimisticStatusByLocalId.has(msg.localId) && !msg.status) {
                    const optimisticStatus = optimisticStatusByLocalId.get(msg.localId)
                    // Don't carry an optimistic 'queued' status onto a server message
                    // the CLI has already consumed (invokedAt set). This happens when a
                    // message is delivered immediately — e.g. steered into the active
                    // turn — so its server echo arrives pre-invoked; inheriting 'queued'
                    // would pin the queued clock on an already-delivered message.
                    if (optimisticStatus !== 'queued' || msg.invokedAt == null) {
                        update.status = optimisticStatus
                    }
                }
                if (optimisticInvokedAtByLocalId.has(msg.localId) && msg.invokedAt == null) {
                    const optimisticInvokedAt = optimisticInvokedAtByLocalId.get(msg.localId)
                    if (optimisticInvokedAt != null) {
                        update.invokedAt = optimisticInvokedAt
                    }
                }
                // The 'steered' marker is live-only (the hub never persists it), so
                // carry it from the optimistic row onto the replacing server echo —
                // otherwise the ↳ Steered badge vanishes the moment the echo lands.
                if (optimisticSteeredByLocalId.has(msg.localId) && !msg.steered) {
                    update.steered = true
                }
                if (
                    optimisticQueueDismissedByLocalId.has(msg.localId)
                    && msg.invokedAt === null
                    && msg.deliveryState === 'indeterminate'
                    && !msg.queueDismissed
                ) {
                    update.queueDismissed = true
                }
                if (Object.keys(update).length > 0) {
                    return { ...msg, ...update }
                }
                return msg
            })
        }
    }

    // Fallback: if an optimistic message was marked as sent but we didn't get a localId echo,
    // drop it when a server user message appears close in time.
    const optimisticMessages = merged.filter((m) => isOptimisticMessage(m))
    const nonOptimisticMessages = merged.filter((m) => !isOptimisticMessage(m))
    const result: DecryptedMessage[] = [...nonOptimisticMessages]

    for (const optimistic of optimisticMessages) {
        if (optimistic.status === 'sent') {
            // Compare by the position key (invokedAt ?? createdAt). A late ack can
            // attach `invokedAt` long after `createdAt`, so the optimistic copy and
            // the server echo end up at the same byPosition slot — using
            // `createdAt` alone misses that match and renders both as duplicates.
            const optimisticTime = optimistic.invokedAt ?? optimistic.createdAt
            const hasServerUserMessage = nonOptimisticMessages.some((m) =>
                isUserMessage(m) &&
                Math.abs((m.invokedAt ?? m.createdAt) - optimisticTime) < 10_000
            )
            if (hasServerUserMessage) {
                continue
            }
        }
        result.push(optimistic)
    }

    const swept = sweepSettledSnapshots(result)
    const normalized = clearStaleQueuedStatus(swept)
    normalized.sort(compareMessages)
    return normalized
}

/** Whether the row is a snapshot or the settled line of a text or reasoning stream (streamed agents). */
function hasTextOrReasoningStream(message: DecryptedMessage): boolean {
    return getTextStreamId(message.content) !== null || getReasoningStreamId(message.content) !== null
}

/**
 * Live snapshots of streams whose settled line is in the list are dropped.
 * While an agent streams, its text and reasoning arrive as growing snapshots
 * under a stable stream id; the line they settle into carries that id. The hub
 * sweeps a stream's snapshots the moment its line lands, so a page never holds
 * both; the window keeps whichever of the two reaches it first — the snapshot
 * while the stream is still going, the line once it has settled — whichever
 * way round the event stream (a resumed stream replays the snapshot it wrote
 * just before the line) and the pages deliver them. The timeline folds a
 * stream's rows into one block by that id, so nothing visible changes.
 */
function sweepSettledSnapshots(messages: DecryptedMessage[]): DecryptedMessage[] {
    if (!messages.some(hasTextOrReasoningStream)) return messages
    const settledText = new Set<string>()
    const settledReasoning = new Set<string>()
    let snapshots = 0
    for (const message of messages) {
        if (getTextLiveStreamId(message.content) !== null || getLiveReasoningStreamId(message.content) !== null) {
            snapshots += 1
            continue
        }
        const text = getTextStreamId(message.content)
        if (text !== null) settledText.add(text)
        const reasoning = getReasoningStreamId(message.content)
        if (reasoning !== null) settledReasoning.add(reasoning)
    }
    if (snapshots === 0 || (settledText.size === 0 && settledReasoning.size === 0)) return messages
    return messages.filter((message) => {
        const text = getTextLiveStreamId(message.content)
        if (text !== null) return !settledText.has(text)
        const reasoning = getLiveReasoningStreamId(message.content)
        if (reasoning !== null) return !settledReasoning.has(reasoning)
        return true
    })
}

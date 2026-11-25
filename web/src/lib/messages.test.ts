import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { mergeMessages } from '@/lib/messages'

function userMessage(partial: Partial<DecryptedMessage> & { id: string }): DecryptedMessage {
    return {
        id: partial.id,
        localId: partial.localId ?? partial.id,
        seq: partial.seq ?? 1,
        createdAt: partial.createdAt ?? 1_000,
        invokedAt: partial.invokedAt ?? null,
        status: partial.status,
        steered: partial.steered,
        deliveryState: partial.deliveryState,
        queueDismissed: partial.queueDismissed,
        content: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }
}

describe('mergeMessages', () => {
    it('preserves invokedAt when a stale snapshot omits the ack timestamp', () => {
        const invokedAt = 2_000
        const existing = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt })]
        const incoming = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt: null })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.invokedAt).toBe(invokedAt)
    })

    it('does not inherit optimistic "queued" onto an already-invoked server echo (steered message)', () => {
        const optimistic = userMessage({ id: 'local-1', localId: 'local-1', invokedAt: null, status: 'queued' })
        const serverInvoked = userMessage({ id: 'server-1', localId: 'local-1', invokedAt: 2_000 })

        const merged = mergeMessages([optimistic], [serverInvoked])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.invokedAt).toBe(2_000)
        expect(merged[0]?.status).not.toBe('queued')
    })

    it('keeps "queued" while the message is not yet invoked (normal queue mode)', () => {
        const optimistic = userMessage({ id: 'local-2', localId: 'local-2', invokedAt: null, status: 'queued' })
        const serverPending = userMessage({ id: 'server-2', localId: 'local-2', invokedAt: null })

        const merged = mergeMessages([optimistic], [serverPending])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.status).toBe('queued')
    })

    it('carries the live "steered" marker from the optimistic row onto the server echo', () => {
        const optimisticSteered = userMessage({ id: 'local-s', localId: 'local-s', invokedAt: 4_000, status: 'sent', steered: true })
        const serverEcho = userMessage({ id: 'server-s', localId: 'local-s', invokedAt: 4_000 })

        const merged = mergeMessages([optimisticSteered], [serverEcho])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.steered).toBe(true)
    })

    it('preserves "steered" across a refetch that omits it', () => {
        const existing = [userMessage({ id: 'server-s2', localId: 'local-s2', invokedAt: 5_000, steered: true })]
        const incoming = [userMessage({ id: 'server-s2', localId: 'local-s2', invokedAt: 5_000 })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.steered).toBe(true)
    })

    it('preserves queueDismissed across a refetch of an indeterminate row (#1839)', () => {
        const existing = [userMessage({
            id: 'server-d',
            localId: 'local-d',
            invokedAt: null,
            deliveryState: 'indeterminate',
            queueDismissed: true,
        })]
        const incoming = [userMessage({
            id: 'server-d',
            localId: 'local-d',
            invokedAt: null,
            deliveryState: 'indeterminate',
        })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.queueDismissed).toBe(true)
    })

    it('normalizes a stuck queued status on an invoked message', () => {
        const inconsistent = userMessage({ id: 'server-3', localId: 'local-3', invokedAt: 3_000, status: 'queued' })

        const merged = mergeMessages([inconsistent], [])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.status).not.toBe('queued')
    })

    it('replaces a stored row in place when an update re-sends its id (tool-call upsert)', () => {
        const existing: DecryptedMessage = {
            id: 'row-1',
            localId: null,
            seq: 7,
            createdAt: 1_000,
            invokedAt: 1_000,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'call-1', name: 'Read', input: { path: '/a' }, status: 'in_progress' } } },
        }
        const update: DecryptedMessage = {
            ...existing,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'call-1', name: 'Read', input: { path: '/a' }, status: 'completed' } } },
        }

        const merged = mergeMessages([existing], [update])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.content).toEqual(update.content)
        expect(merged[0]?.seq).toBe(7)
    })
})

describe('mergeMessages keeps the rows the window already holds', () => {
    const served = (id: string, text: string, rowHash?: string): DecryptedMessage => ({
        id,
        localId: null,
        seq: 1,
        createdAt: 1_000,
        invokedAt: null,
        ...(rowHash ? { rowHash } : {}),
        content: { role: 'user', content: { type: 'text', text } }
    })

    it('returns the held row when it comes back with the same fingerprint and content', () => {
        const held = served('m1', 'a', 'aaaaaaaaaaaa')
        expect(mergeMessages([held], [served('m1', 'a', 'aaaaaaaaaaaa')])[0]).toBe(held)
    })

    it('takes the served row once its content moved on', () => {
        const held = served('m1', 'a', 'aaaaaaaaaaaa')
        const next = served('m1', 'merged', 'bbbbbbbbbbbb')
        expect(mergeMessages([held], [next])[0]).toBe(next)
        // Same text, other fingerprint: the hub says the row is not what was held.
        expect(mergeMessages([held], [served('m1', 'a', 'cccccccccccc')])[0]).not.toBe(held)
    })

    it('never counts a row without a fingerprint as the same when the held one has none either', () => {
        const held = served('m1', 'a')
        expect(mergeMessages([held], [served('m1', 'a')])[0]).not.toBe(held)
    })

    it('keeps the labelled row when the event stream serves the same row without a fingerprint', () => {
        // The stream's copy of a row a page labelled: no fingerprint, no revision counter, its
        // fields in the order the hub builds them. It says nothing the held row does not.
        const labelled = { ...served('m1', 'a', 'aaaaaaaaaaaa'), contentRevision: 2 }
        const streamed = served('m1', 'a')
        expect(mergeMessages([labelled], [streamed])[0]).toBe(labelled)
        // Key order is not part of a row.
        const reordered = Object.fromEntries(Object.entries(streamed).reverse()) as DecryptedMessage
        expect(mergeMessages([labelled], [reordered])[0]).toBe(labelled)
    })

    it('reads a null the page writes where the stream leaves the field out as the same thing', () => {
        const labelled = { ...served('m1', 'a', 'aaaaaaaaaaaa'), scheduledAt: null, invokedAt: 5_000 }
        const streamed = { ...served('m1', 'a'), invokedAt: 5_000 }
        expect(mergeMessages([labelled], [streamed])[0]).toBe(labelled)
        // A field that is there on one side only, and not null, is a difference.
        expect(mergeMessages([{ ...labelled, localId: 'local-1' }], [streamed])[0]).not.toBe(labelled)
    })

    it('takes the stream\'s copy once the row moved on, fingerprint or no fingerprint', () => {
        const labelled = { ...served('m1', 'a', 'aaaaaaaaaaaa'), contentRevision: 2 }
        expect(mergeMessages([labelled], [served('m1', 'merged')])[0]).not.toBe(labelled)
        expect(mergeMessages([labelled], [{ ...served('m1', 'a'), seq: 2 }])[0]).not.toBe(labelled)
        // A field the held row does not have is news too.
        expect(mergeMessages([labelled], [{ ...served('m1', 'a'), deliveryState: 'indeterminate' as const }])[0]).not.toBe(labelled)
    })

    it('takes the served row when the held one carries more than it, and keeps the client-only signals', () => {
        // A local status is not something the served copy has: the row is not the same.
        const sending = { ...served('m1', 'a', 'aaaaaaaaaaaa'), status: 'sending' as const }
        expect(mergeMessages([sending], [served('m1', 'a', 'aaaaaaaaaaaa')])[0]).not.toBe(sending)
        // A late ack is carried over by the merge, so the held row is exactly what
        // the merge would build: it stays, ack and all.
        const acked = { ...served('m1', 'a', 'aaaaaaaaaaaa'), invokedAt: 1_234 }
        const merged = mergeMessages([acked], [served('m1', 'a', 'aaaaaaaaaaaa')])[0]
        expect(merged).toBe(acked)
        expect(merged?.invokedAt).toBe(1_234)
    })
})

describe('mergeMessages sweeps the snapshots of a settled stream', () => {
    const text = (streamId: string, live: boolean): DecryptedMessage => ({
        id: streamId,
        localId: null,
        seq: live ? 90 : 91,
        createdAt: live ? 1_050 : 1_000,
        invokedAt: live ? 1_050 : 1_000,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: streamId, message: 'block', ...(live ? { live: true, streamSnapshot: true } : {}) } } }
    }) as DecryptedMessage
    const line = (id: string, streamId: string): DecryptedMessage => ({
        id,
        localId: null,
        seq: 92,
        createdAt: 1_001,
        invokedAt: 1_001,
        rowHash: 'hhhhhhhhhhhh',
        content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', streamId, text: 'block' } } }
    }) as DecryptedMessage
    const reasoning = (streamId: string, live: boolean): DecryptedMessage => ({
        id: streamId,
        localId: null,
        seq: live ? 80 : 81,
        createdAt: live ? 1_060 : 1_010,
        invokedAt: live ? 1_060 : 1_010,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'thinking', id: streamId, ...(live ? { live: true } : {}) } } }
    }) as DecryptedMessage

    it('drops the snapshot once its line is there, whichever side each came in on', () => {
        const settled = line('line-1', 'stream-1')
        expect(mergeMessages([text('stream-1', true)], [settled]).map((message) => message.id)).toEqual(['line-1'])
        expect(mergeMessages([settled], [text('stream-1', true)]).map((message) => message.id)).toEqual(['line-1'])
    })

    it('leaves a snapshot whose stream has not settled, and other streams, alone', () => {
        const streaming = text('stream-2', true)
        const other = text('stream-3', true)
        const settled = line('line-1', 'stream-1')
        expect(mergeMessages([streaming, other], [settled]).map((message) => message.id)).toEqual(['line-1', 'stream-2', 'stream-3'])
    })

    it('does the same for a reasoning stream', () => {
        const settledReasoning = { ...reasoning('r-1', false), id: 'r-line', content: { role: 'agent' as const, content: { type: 'output' as const, data: { type: 'assistant' as const, reasoningStreamId: 'r-1', text: 'done' } } } } as DecryptedMessage
        expect(mergeMessages([reasoning('r-1', true)], [settledReasoning]).map((message) => message.id)).toEqual(['r-line'])
    })

    it('is a no-op for rows without streams', () => {
        const held = { id: 'm1', localId: null, seq: 1, createdAt: 1, invokedAt: 1, content: { role: 'user', content: [{ type: 'text', text: 'a' }] } } as DecryptedMessage
        const next = { ...held, content: { role: 'user', content: [{ type: 'text', text: 'b' }] } } as DecryptedMessage
        expect(mergeMessages([held], [next]).map((message) => message.id)).toEqual(['m1'])
    })
})

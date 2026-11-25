import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { clearMessageWindow, getMessageWindowState, ingestIncomingMessages } from '@/lib/message-window-store'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

/** What a resumed session stream replays after the open's own reconcile has
 * run: `message-received` for everything written since its cursor — rows a
 * page just labelled (served again without the fingerprint) and the streamed
 * snapshot the hub swept when its line settled (served again although the hub
 * no longer has it). Neither may leave the window worse than the reconcile
 * left it. */

const touched = new Set<string>()
function sessionId(name: string): string {
    const id = `stream-replay-${name}`
    touched.add(id)
    return id
}

function agentMessage(id: string, seq: number, at: number, rowHash?: string, text = id): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        contentRevision: 1,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: text, id: `stream-${id}` } } },
        createdAt: at,
        invokedAt: at,
        ...(rowHash ? { rowHash } : {})
    } as DecryptedMessage
}

/** Labelled rows `m<from>`…`m<to>`, ten time units apart, fingerprinted `h<seq>`. */
function rows(from: number, to: number): DecryptedMessage[] {
    return Array.from({ length: to - from + 1 }, (_, index) => {
        const seq = from + index
        return agentMessage(`m${seq}`, seq, seq * 10, `h${seq}`)
    })
}

/** The row as the event stream serves it: no fingerprint, no revision counter. */
function streamCopy(message: DecryptedMessage): DecryptedMessage {
    const { rowHash: _rowHash, contentRevision: _contentRevision, ...rest } = message
    return rest as DecryptedMessage
}

/** A streamed text block while it streams (the Claude remote launcher's shape). */
function liveSnapshot(streamId: string, text: string, at: number): DecryptedMessage {
    return {
        id: streamId,
        seq: null,
        localId: null,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: streamId, message: text, live: true, streamSnapshot: true } } },
        createdAt: at,
        invokedAt: null
    } as unknown as DecryptedMessage
}

/** The line the block settles into, carrying the id of the snapshots it supersedes. */
function settledLine(id: string, streamId: string, seq: number, at: number, rowHash: string, text: string): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', streamId, text } } },
        createdAt: at,
        invokedAt: at,
        rowHash
    } as unknown as DecryptedMessage
}

/** A persisted window holding `messages`, its tail at the newest row, read under `epoch`. */
function persistWindow(id: string, messages: DecryptedMessage[], epoch: number): void {
    const newest = messages.at(-1)!
    sessionStorage.setItem(`hapi:message-window:v3:${id}`, JSON.stringify({
        messages,
        hasMore: true,
        oldestPositionAt: messages[0]!.invokedAt,
        oldestPositionSeq: messages[0]!.seq,
        newestPositionAt: newest.invokedAt ?? newest.createdAt,
        newestPositionSeq: newest.seq,
        epoch,
        requiresLatestReset: false
    }))
}

const stateOf = (id: string) => getMessageWindowState(id)
const labelled = (id: string) => stateOf(id).messages.filter((message) => message.rowHash !== undefined).length

beforeEach(() => {
    sessionStorage.clear()
})

afterEach(() => {
    for (const id of touched) clearMessageWindow(id)
    touched.clear()
    sessionStorage.clear()
})

describe('what a resumed stream replays after the open has reconciled', () => {
    it('a row served again without its fingerprint leaves the labelled row held', () => {
        const id = sessionId('labels')
        const cached = rows(31, 100)
        persistWindow(id, cached, 1)
        expect(labelled(id)).toBe(70)
        const before = stateOf(id)

        ingestIncomingMessages(id, [streamCopy(cached[69]!), streamCopy(cached[50]!), streamCopy(cached[0]!)])

        // Fingerprint and object identity both: the thread is not rendered again for these.
        expect(labelled(id)).toBe(70)
        expect(stateOf(id).messages[69]).toBe(before.messages[69])
        expect(stateOf(id).messages[50]?.rowHash).toBe('h81')
    })

    it('a row the stream serves with other content is taken, fingerprint or not', () => {
        const id = sessionId('changed')
        const cached = rows(31, 100)
        persistWindow(id, cached, 1)

        ingestIncomingMessages(id, [{ ...streamCopy(cached[69]!), content: { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'merged', id: 'stream-m100' } } } }])

        expect(labelled(id)).toBe(69)
        expect(stateOf(id).messages[69]?.rowHash).toBeUndefined()
    })

    it('the snapshot of a stream whose settled line the window already holds is not added', () => {
        const id = sessionId('snapshot-settled')
        const line = settledLine('line-1', 'stream-1', 101, 1_000, 'h101', 'the whole block')
        persistWindow(id, [...rows(31, 100), line], 2)
        const before = stateOf(id)

        ingestIncomingMessages(id, [liveSnapshot('stream-1', 'the whole block', 1_050)])

        const after = stateOf(id)
        expect(after).toBe(before)
        expect(after.messages.map((message) => message.id)).not.toContain('stream-1')
    })

    it('a snapshot is taken while its stream has not settled: streaming goes on', () => {
        const id = sessionId('snapshot-streaming')
        persistWindow(id, rows(31, 100), 1)
        ingestIncomingMessages(id, [liveSnapshot('stream-9', 'part', 1_050)])
        expect(stateOf(id).messages.at(-1)?.id).toBe('stream-9')

        // The next snapshot of the stream replaces the one before it.
        ingestIncomingMessages(id, [liveSnapshot('stream-9', 'partial', 1_060)])
        expect(stateOf(id).messages.filter((message) => message.id === 'stream-9')).toHaveLength(1)

        // The line settles and arrives live: it is taken, and the snapshot it supersedes leaves the window,
        // as it left the hub.
        const line = settledLine('line-9', 'stream-9', 101, 990, undefined as unknown as string, 'partial')
        ingestIncomingMessages(id, [line])
        expect(stateOf(id).messages.map((message) => message.id)).toEqual([...rows(31, 99).map((message) => message.id), 'line-9', 'm100'])

        // What the hub's replay then still carries — the stream's last snapshot — is not taken.
        const before = stateOf(id)
        ingestIncomingMessages(id, [liveSnapshot('stream-9', 'partial', 1_070)])
        expect(stateOf(id)).toBe(before)
    })

    it('a snapshot the replay delivered before its line leaves the window when the line lands', () => {
        // The line sits further back than the first page's twenty rows: the reconcile fetches it by id,
        // and a resumed stream may replay the snapshot before that answer lands.
        const id = sessionId('snapshot-first')
        persistWindow(id, rows(31, 100), 1)
        ingestIncomingMessages(id, [liveSnapshot('stream-1', 'the whole block', 1_050)])
        expect(stateOf(id).messages.at(-1)?.id).toBe('stream-1')

        ingestIncomingMessages(id, [settledLine('line-1', 'stream-1', 101, 1_000, 'h101', 'the whole block')])

        expect(stateOf(id).messages.map((message) => message.id)).not.toContain('stream-1')
        expect(stateOf(id).messages.at(-1)?.id).toBe('line-1')
    })

    it('a snapshot of another stream than the settled line the window holds is taken', () => {
        const id = sessionId('snapshot-other-stream')
        persistWindow(id, [...rows(31, 100), settledLine('line-1', 'stream-1', 101, 1_000, 'h101', 'block')], 2)

        ingestIncomingMessages(id, [liveSnapshot('stream-2', 'the next block', 1_050)])

        expect(stateOf(id).messages.at(-1)?.id).toBe('stream-2')
    })
})

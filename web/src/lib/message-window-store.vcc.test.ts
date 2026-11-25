import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { resetReconcilePageForTests } from '@/api/reconcilePage'
import {
    INITIAL_PAGE_SIZE,
    activateMessageWindow,
    clearMessageWindow,
    getMessageWindowState,
    syncTailMessages,
} from '@/lib/message-window-store'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

// v-chain-cache (adversarial verification of x3): a queued row the hub had acknowledged (id !== localId) that
// another client cancelled while this client was away. The open's reconcile — the stale-epoch page — no longer
// lists it; it must leave the window without waiting for the session's event stream.

const touched = new Set<string>()
function sessionId(name: string): string {
    const id = `vcc-cancel-${name}`
    touched.add(id)
    return id
}
type Query = NonNullable<Parameters<ApiClient['getMessages']>[1]>

function agentMessage(id: string, seq: number, at: number, rowHash?: string): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: id, id: `stream-${id}` } } },
        createdAt: at,
        invokedAt: at,
        ...(rowHash ? { rowHash } : {})
    } as DecryptedMessage
}
function rows(from: number, to: number): DecryptedMessage[] {
    return Array.from({ length: to - from + 1 }, (_, index) => {
        const seq = from + index
        return agentMessage(`m${seq}`, seq, seq * 10, `h${seq}`)
    })
}
function basePage(direction: 'latest' | 'after', epoch: number): MessagesResponse['page'] {
    return {
        direction, limit: 200, epoch, reset: false, nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null,
        snapshotHeadAt: null, snapshotHeadSeq: null, hasMore: false
    }
}
const latest = (messages: DecryptedMessage[], epoch: number, overrides: Partial<MessagesResponse['page']> = {}): MessagesResponse => (
    { messages, page: { ...basePage('latest', epoch), ...overrides } }
)
/** A user row the hub has stored and acknowledged: its own id, the client's localId, not invoked yet. */
function serverQueuedRow(id: string, localId: string, seq: number, createdAt: number, rowHash: string): DecryptedMessage {
    return {
        id,
        localId,
        seq,
        createdAt,
        invokedAt: null,
        status: 'queued',
        rowHash,
        content: { role: 'user', content: { type: 'text', text: 'queued prompt' } }
    } as DecryptedMessage
}
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
function createApi(getMessages: ApiClient['getMessages']): ApiClient {
    return { getMessages, getMessageContext: async () => null } as unknown as ApiClient
}
async function openWindow(api: ApiClient, id: string): Promise<void> {
    await syncTailMessages(api, id)
    await syncTailMessages(api, id)
}
const idsOf = (id: string) => getMessageWindowState(id).messages.map((message) => message.id)

beforeEach(() => {
    resetReconcilePageForTests()
    sessionStorage.clear()
})
afterEach(() => {
    for (const id of touched) clearMessageWindow(id)
    touched.clear()
    sessionStorage.clear()
    resetReconcilePageForTests()
})

describe('v-chain-cache: an open that finds the epoch moved on and a server-queued row gone', () => {
    it('drops the acknowledged queued row the page no longer lists (cancelled on another client)', async () => {
        const id = sessionId('cancelled')
        const cached = [...rows(21, 100), serverQueuedRow('srv-q', 'local-q', 101, 1005, 'hq')]
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        const page = rows(31, 100)
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
            if (query.limit === INITIAL_PAGE_SIZE) {
                return latest(rows(81, 100), 2, { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: true, nextBeforeAt: 810, nextBeforeSeq: 81 })
            }
            return latest(page, 2, { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: true, nextBeforeAt: 310, nextBeforeSeq: 31 })
        })

        await openWindow(api, id)

        expect(idsOf(id)).toEqual(rows(21, 100).map((message) => message.id))
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null })
    })

    it('keeps a queued row the page still lists, and the client\'s own optimistic one', async () => {
        const id = sessionId('kept')
        const acknowledged = serverQueuedRow('srv-q', 'local-q', 101, 1005, 'hq')
        const optimistic = {
            id: 'local-opt', localId: 'local-opt', seq: null, createdAt: 1006, invokedAt: null, status: 'queued',
            content: { role: 'user', content: { type: 'text', text: 'not sent yet' } }
        } as DecryptedMessage
        persistWindow(id, [...rows(21, 100), acknowledged, optimistic], 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        const page = [...rows(31, 100), acknowledged]
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
            if (query.limit === INITIAL_PAGE_SIZE) {
                return latest([...rows(81, 100), acknowledged], 2, { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: true, nextBeforeAt: 810, nextBeforeSeq: 81 })
            }
            return latest(page, 2, { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: true, nextBeforeAt: 310, nextBeforeSeq: 31 })
        })

        await openWindow(api, id)

        expect(idsOf(id)).toEqual([...rows(21, 100).map((message) => message.id), 'srv-q', 'local-opt'])
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null })
    })
})

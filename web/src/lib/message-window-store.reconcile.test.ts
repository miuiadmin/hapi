import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { resetReconcilePageForTests, takeReconcilePageMark, type ReconcileMark } from '@/api/reconcilePage'
import {
    clearMessageWindow,
    getMessageWindowState,
    recoverWindowAfterGapResume,
    syncTailMessages
} from '@/lib/message-window-store'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

const touched = new Set<string>()
function sessionId(name: string): string {
    const id = `reconcile-store-${name}`
    touched.add(id)
    return id
}

function agentMessage(id: string, seq: number, at: number, rowHash?: string): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: { type: 'codex', data: { type: 'reasoning', message: id, id: `stream-${id}` } }
        },
        createdAt: at,
        invokedAt: at,
        ...(rowHash ? { rowHash } : {})
    } as DecryptedMessage
}

function page(direction: 'latest' | 'after', epoch: number, overrides: Partial<MessagesResponse['page']> = {}): MessagesResponse['page'] {
    return {
        direction,
        limit: 200,
        epoch,
        reset: false,
        nextBeforeAt: null,
        nextBeforeSeq: null,
        nextAfterAt: null,
        nextAfterSeq: null,
        snapshotHeadAt: null,
        snapshotHeadSeq: null,
        hasMore: false,
        ...overrides
    }
}

const latest = (messages: DecryptedMessage[], pageOverride: Partial<MessagesResponse['page']> = {}): MessagesResponse => (
    { messages, page: page('latest', 1, pageOverride) }
)
const after = (messages: DecryptedMessage[], pageOverride: Partial<MessagesResponse['page']> = {}): MessagesResponse => (
    { messages, page: page('after', 1, { nextAfterAt: 1001, nextAfterSeq: 2, snapshotHeadAt: 1001, snapshotHeadSeq: 2, ...pageOverride }) }
)

function createApi(getMessages: ApiClient['getMessages']): ApiClient {
    return { getMessages, getMessageContext: async () => null } as unknown as ApiClient
}

const ids = () => getMessageWindowState(current).messages.map((message) => message.id)
let current = ''

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

describe('the gap-recovery page is marked for the transport', () => {
    it('carries the session epoch and what the window holds, with each row\'s fingerprint', async () => {
        current = sessionId('mark')
        const marks: Array<ReconcileMark | null> = []
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) return after([])
            // The cold open's page comes first; the next latest page is the reconcile.
            if (ids().length === 0) return latest([agentMessage('m1', 1, 1000, '111111111111'), agentMessage('m2', 2, 1001)])
            marks.push(takeReconcilePageMark(current))
            return latest([])
        })

        await syncTailMessages(api, current)
        expect(takeReconcilePageMark(current)).toBeNull()
        await recoverWindowAfterGapResume(api, current)
        // The mark is gone once used: a later full page is never narrowed by it.
        expect(takeReconcilePageMark(current)).toBeNull()

        expect(marks).toHaveLength(1)
        expect(marks[0]?.epoch).toBe(1)
        expect(marks[0]?.rows).toEqual(new Map([['m1', '111111111111'], ['m2', undefined]]))
    })

    it('an empty answer leaves the window as it is and completes the recovery', async () => {
        current = sessionId('unchanged')
        let reconciles = 0
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) return after([])
            return ids().length === 0
                ? latest([agentMessage('m1', 1, 1000, '111111111111'), agentMessage('m2', 2, 1001, '222222222222')])
                : (reconciles += 1, latest([], { hasMore: true, nextBeforeAt: 998, nextBeforeSeq: 0 }))
        })
        await syncTailMessages(api, current)
        const listBefore = getMessageWindowState(current).messages
        const versionBefore = getMessageWindowState(current).messagesVersion
        await recoverWindowAfterGapResume(api, current)

        expect(reconciles).toBe(1)
        expect(ids()).toEqual(['m1', 'm2'])
        expect(getMessageWindowState(current)).toMatchObject({
            isSyncingTail: false,
            warning: null,
            hasMore: true
        })
        // Nothing new to show: the list is the very same one, so the thread is not rendered again for it.
        const settled = getMessageWindowState(current)
        expect(settled.messages).toBe(listBefore)
        expect(settled.messagesVersion).toBe(versionBefore)
    })

    it('a re-entry whose first page is what the window already holds does not hand out a new list either', async () => {
        current = sessionId('same-rows')
        const served = () => [agentMessage('m1', 1, 1000, '111111111111'), agentMessage('m2', 2, 1001, '222222222222')]
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) return after([])
            return latest(served(), { nextBeforeAt: 998, nextBeforeSeq: 0 })
        })
        // Open, leave, come back: the store restores the window from storage and asks for its first page again.
        await syncTailMessages(api, current)
        const list = getMessageWindowState(current).messages
        const version = getMessageWindowState(current).messagesVersion
        const second = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) return after([])
            return latest(served(), { nextBeforeAt: 998, nextBeforeSeq: 0 })
        })
        await recoverWindowAfterGapResume(second, current)
        expect(getMessageWindowState(current).messages).toBe(list)
        expect(getMessageWindowState(current).messagesVersion).toBe(version)
    })
})

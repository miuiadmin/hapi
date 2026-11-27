import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import { REREGISTER_WINDOW_MS } from './sessionReceipts'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeReceipt(store: Store, overrides: Partial<Parameters<Store['sessionReceipts']['insert']>[0]> = {}) {
    return store.sessionReceipts.insert({
        childSessionId: 'worker',
        parentSessionId: 'bot',
        taskLocalId: 'task-1',
        kind: 'turn_end',
        now: 100,
        ...overrides
    })
}

describe('SessionReceiptStore', () => {
    it('inserts a pending receipt and finds it again for the same message', () => {
        const store = makeStore()
        const receipt = makeReceipt(store)
        expect(receipt).toMatchObject({
            childSessionId: 'worker', parentSessionId: 'bot', taskLocalId: 'task-1', kind: 'turn_end',
            state: 'pending', createdAt: 100, deliveredAt: null
        })
        expect(store.sessionReceipts.get(receipt.id)?.id).toBe(receipt.id)
        expect(store.sessionReceipts.findLive('worker', 'bot', 'task-1', 100)?.id).toBe(receipt.id)
        expect(store.sessionReceipts.findLive('worker', 'bot', 'task-2', 100)).toBeNull()
        expect(store.sessionReceipts.findLive('other', 'bot', 'task-1', 100)).toBeNull()
    })

    it('finds the receipt of the same message while it is being delivered and for a while after, then not', () => {
        const store = makeStore()
        const receipt = makeReceipt(store)

        // Claimed by a delivery in flight: a registration retried now must not start a second reply.
        expect(store.sessionReceipts.claim(receipt.id)).toBe(true)
        expect(store.sessionReceipts.findLive('worker', 'bot', 'task-1', 100)?.id).toBe(receipt.id)
        expect(store.sessionReceipts.markDelivered(receipt.id, 500)).toBe(true)
        // Just delivered: the sender may not have seen the first response.
        expect(store.sessionReceipts.findLive('worker', 'bot', 'task-1', 500 + REREGISTER_WINDOW_MS)?.id).toBe(receipt.id)
        // Long after: the same local id is a new message.
        expect(store.sessionReceipts.findLive('worker', 'bot', 'task-1', 500 + REREGISTER_WINDOW_MS + 1)).toBeNull()
    })

    it('lists what is unsettled, mid-delivery included, but not what was settled', () => {
        const store = makeStore()
        const a = makeReceipt(store)
        const b = makeReceipt(store, { taskLocalId: 'task-2', now: 101 })
        const c = makeReceipt(store, { taskLocalId: 'task-3', now: 102 })
        expect(store.sessionReceipts.claim(a.id)).toBe(true)
        expect(store.sessionReceipts.claim(b.id)).toBe(true)
        expect(store.sessionReceipts.markDelivered(b.id, 500)).toBe(true)
        expect(store.sessionReceipts.markUndeliverable(c.id, 'failed', 500)).toBe(true)

        // Only the one the previous process died while sending: a restart has to see it to finish it.
        expect(store.sessionReceipts.listUnsettled().map((r) => r.id)).toEqual([a.id])
        expect(store.sessionReceipts.listPendingForChild('worker')).toEqual([])
        expect(store.sessionReceipts.listPendingChildSessions('bot')).toEqual(['worker'])
    })

    it('lists pending receipts by child, by parent and overall', () => {
        const store = makeStore()
        const a = makeReceipt(store)
        const b = makeReceipt(store, { taskLocalId: 'task-2', now: 101 })
        const other = makeReceipt(store, { childSessionId: 'worker-2', parentSessionId: 'bot-2', now: 102 })

        expect(store.sessionReceipts.listPendingForChild('worker').map((r) => r.id)).toEqual([a.id, b.id])
        expect(store.sessionReceipts.listPendingForParent('bot').map((r) => r.id)).toEqual([a.id, b.id])
        expect(store.sessionReceipts.listUnsettled().map((r) => r.id)).toEqual([a.id, b.id, other.id])
        expect(store.sessionReceipts.listPendingChildSessions('bot')).toEqual(['worker', 'worker'])

        expect(store.sessionReceipts.claim(a.id)).toBe(true)
        // Claimed is no longer waiting, but it is not settled either.
        expect(store.sessionReceipts.listPendingForChild('worker').map((r) => r.id)).toEqual([b.id])
        expect(store.sessionReceipts.listUnsettled().map((r) => r.id)).toEqual([a.id, b.id, other.id])
        expect(store.sessionReceipts.listPendingChildSessions('bot')).toEqual(['worker', 'worker'])
        expect(store.sessionReceipts.markDelivered(a.id, 500)).toBe(true)
        expect(store.sessionReceipts.listPendingForChild('worker').map((r) => r.id)).toEqual([b.id])
        expect(store.sessionReceipts.get(a.id)).toMatchObject({ state: 'delivered', deliveredAt: 500 })
        expect(store.sessionReceipts.listUnsettled().map((r) => r.id)).toEqual([b.id, other.id])
    })

    it('hands a receipt to exactly one trigger', () => {
        const store = makeStore()
        const receipt = makeReceipt(store)
        expect(store.sessionReceipts.claim(receipt.id)).toBe(true)
        expect(store.sessionReceipts.claim(receipt.id)).toBe(false)
        expect(store.sessionReceipts.listPendingForChild('worker')).toEqual([])

        // Released: the parent's machine was offline.
        expect(store.sessionReceipts.release(receipt.id)).toBe(true)
        expect(store.sessionReceipts.listPendingForChild('worker')).toHaveLength(1)
        expect(store.sessionReceipts.release(receipt.id)).toBe(false)

        expect(store.sessionReceipts.claim(receipt.id)).toBe(true)
        expect(store.sessionReceipts.markDelivered(receipt.id, 900)).toBe(true)
        expect(store.sessionReceipts.markDelivered(receipt.id, 901)).toBe(false)
    })

    it('settles an undeliverable receipt and prunes old settled rows', () => {
        const store = makeStore()
        const old = makeReceipt(store, { now: 10 })
        const fresh = makeReceipt(store, { taskLocalId: 'task-2', now: 5_000_000 })
        expect(store.sessionReceipts.markUndeliverable(old.id, 'failed', 20)).toBe(true)
        expect(store.sessionReceipts.markUndeliverable(old.id, 'expired', 30)).toBe(false)
        expect(store.sessionReceipts.markUndeliverable(fresh.id, 'expired', 30)).toBe(true)
        expect(store.sessionReceipts.get(fresh.id)?.state).toBe('expired')

        expect(store.sessionReceipts.deleteSettledBefore(1000)).toBe(1)
        expect(store.sessionReceipts.get(old.id)).toBeNull()
        expect(store.sessionReceipts.get(fresh.id)).not.toBeNull()
    })

    it('moves receipts with a merged-away session', () => {
        const store = makeStore()
        makeReceipt(store)
        makeReceipt(store, { childSessionId: 'worker-2', parentSessionId: 'bot-2', taskLocalId: 'task-2' })
        expect(store.sessionReceipts.transfer('worker', 'survivor')).toBe(1)
        expect(store.sessionReceipts.transfer('bot-2', 'survivor')).toBe(1)
        expect(store.sessionReceipts.listPendingForChild('survivor').map((r) => r.taskLocalId)).toEqual(['task-1'])
        expect(store.sessionReceipts.listPendingForParent('survivor').map((r) => r.taskLocalId)).toEqual(['task-2'])
    })
})

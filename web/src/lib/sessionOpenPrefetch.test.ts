import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { RECONCILE_MIN_LABELLED_ROWS } from '@/api/reconcilePage'
import { INITIAL_PAGE_SIZE, clearMessageWindow } from '@/lib/message-window-store'
import * as openTrace from '@/lib/sessionOpenTrace'
import { prefetchSessionOpenPage } from '@/lib/sessionOpenPrefetch'
import type { DecryptedMessage } from '@/types/api'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn(), getLevel: vi.fn(() => 1) },
    bindTelemetryClient: vi.fn()
}))

const touched = new Set<string>()

beforeEach(() => {
    sessionStorage.clear()
})

afterEach(() => {
    for (const id of touched) clearMessageWindow(id)
    touched.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
})

/** A persisted window of `count` fingerprinted rows read under `epoch`. */
function persistWindow(count: number, epoch: number): string {
    const id = `prefetch-open-${Math.random().toString(36).slice(2)}`
    touched.add(id)
    const messages: DecryptedMessage[] = Array.from({ length: count }, (_, index) => ({
        id: `m${index + 1}`,
        seq: index + 1,
        localId: null,
        content: { role: 'agent', content: { type: 'text', text: `row ${index + 1}` } },
        createdAt: (index + 1) * 10,
        invokedAt: (index + 1) * 10,
        rowHash: `h${index + 1}`
    })) as DecryptedMessage[]
    sessionStorage.setItem(`hapi:message-window:v3:${id}`, JSON.stringify({
        messages,
        hasMore: true,
        oldestPositionAt: 10,
        oldestPositionSeq: 1,
        newestPositionAt: count * 10,
        newestPositionSeq: count,
        epoch,
        requiresLatestReset: false
    }))
    return id
}

describe('prefetchSessionOpenPage', () => {
    it('starts the first page on the tap, after readying the request log for it', () => {
        const ready = vi.spyOn(openTrace, 'prepareSessionOpenResourceTimings').mockImplementation(() => {})
        const prefetchMessages = vi.fn()
        const api = { prefetchMessages } as unknown as ApiClient

        prefetchSessionOpenPage(api, 'session-1')

        expect(prefetchMessages).toHaveBeenCalledWith('session-1', { limit: INITIAL_PAGE_SIZE })
        expect(INITIAL_PAGE_SIZE).toBe(20)
        // The request is on the wire only once the log cannot be emptied under it.
        expect(ready.mock.invocationCallOrder[0]!).toBeLessThan(prefetchMessages.mock.invocationCallOrder[0]!)
    })

    it('does nothing without a transport that can prefetch', () => {
        const ready = vi.spyOn(openTrace, 'prepareSessionOpenResourceTimings').mockImplementation(() => {})
        expect(() => prefetchSessionOpenPage(null, 'session-1')).not.toThrow()
        expect(() => prefetchSessionOpenPage({} as ApiClient, 'session-1')).not.toThrow()
        expect(ready).not.toHaveBeenCalled()
    })

    it('starts the reconcile\'s fingerprint list next to the first page, for the persisted window\'s epoch', () => {
        vi.spyOn(openTrace, 'prepareSessionOpenResourceTimings').mockImplementation(() => {})
        const prefetchMessages = vi.fn()
        const prefetchReconcileManifest = vi.fn()
        const api = { prefetchMessages, prefetchReconcileManifest } as unknown as ApiClient
        const id = persistWindow(RECONCILE_MIN_LABELLED_ROWS + 10, 5)

        prefetchSessionOpenPage(api, id)

        expect(prefetchMessages).toHaveBeenCalledWith(id, { limit: INITIAL_PAGE_SIZE })
        // The list leaves right after the first page, not after it lands.
        expect(prefetchReconcileManifest).toHaveBeenCalledTimes(1)
        expect(prefetchReconcileManifest).toHaveBeenCalledWith(id, 5)
        expect(prefetchMessages.mock.invocationCallOrder[0]!).toBeLessThan(prefetchReconcileManifest.mock.invocationCallOrder[0]!)
    })

    it('starts no list for a window the list would not pay for: a cold session, or too few fingerprinted rows', () => {
        vi.spyOn(openTrace, 'prepareSessionOpenResourceTimings').mockImplementation(() => {})
        const prefetchMessages = vi.fn()
        const prefetchReconcileManifest = vi.fn()
        const api = { prefetchMessages, prefetchReconcileManifest } as unknown as ApiClient
        const cold = 'prefetch-open-cold'
        touched.add(cold)
        const few = persistWindow(RECONCILE_MIN_LABELLED_ROWS - 1, 5)

        prefetchSessionOpenPage(api, cold)
        prefetchSessionOpenPage(api, few)

        expect(prefetchMessages).toHaveBeenCalledTimes(2)
        expect(prefetchReconcileManifest).not.toHaveBeenCalled()
    })

    it('does without the list on a transport that cannot prefetch it', () => {
        vi.spyOn(openTrace, 'prepareSessionOpenResourceTimings').mockImplementation(() => {})
        const id = persistWindow(RECONCILE_MIN_LABELLED_ROWS + 1, 5)
        const prefetchMessages = vi.fn()
        expect(() => prefetchSessionOpenPage({ prefetchMessages } as unknown as ApiClient, id)).not.toThrow()
        expect(prefetchMessages).toHaveBeenCalledWith(id, { limit: INITIAL_PAGE_SIZE })
    })
})

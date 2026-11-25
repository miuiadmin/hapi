import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { INITIAL_PAGE_SIZE } from '@/lib/message-window-store'
import * as openTrace from '@/lib/sessionOpenTrace'
import { prefetchSessionOpenPage } from '@/lib/sessionOpenPrefetch'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn(), getLevel: vi.fn(() => 1) },
    bindTelemetryClient: vi.fn()
}))

afterEach(() => {
    vi.restoreAllMocks()
})

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
})

import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import {
    EAGER_PREFETCH_TOP_N,
    MAX_PREFETCH_IN_FLIGHT,
    PREFETCH_FAILURE_BACKOFF_MS,
    prefetchBackoffMs,
    useEagerSessionPrefetch
} from './useEagerSessionPrefetch'

function row(id: string, active = false): SessionSummary {
    return { id, active } as unknown as SessionSummary
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

const detail = { session: { id: 'x' } }

let queryClient: QueryClient
let getSession: ReturnType<typeof vi.fn>
const api = { getSession: vi.fn() } as unknown as ApiClient

async function flush(ms = 0): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function setup(sessions: SessionSummary[], options: { eager?: boolean; baseline?: boolean } = {}) {
    const wrapper = ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    return renderHook(
        ({ list, eager, baseline }: { list: SessionSummary[]; eager: boolean; baseline: boolean }) =>
            useEagerSessionPrefetch(api, list, eager, baseline),
        { wrapper, initialProps: { list: sessions, eager: options.eager ?? true, baseline: options.baseline ?? false } }
    )
}

beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    getSession = vi.fn().mockResolvedValue(detail)
    Object.defineProperty(api, 'getSession', { value: getSession, configurable: true, writable: true })
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('prefetchBackoffMs', () => {
    it('steps down the back-off list per consecutive failure and stays at the cap', () => {
        expect(PREFETCH_FAILURE_BACKOFF_MS).toEqual([2_000, 5_000, 15_000, 30_000])
        expect([0, 1, 2, 3, 4, 9].map(prefetchBackoffMs)).toEqual([2_000, 2_000, 5_000, 15_000, 30_000, 30_000])
    })
})

describe('useEagerSessionPrefetch', () => {
    it('prefetches active sessions and the top rows, and leaves a warm cache alone', async () => {
        const list = [row('top-1'), row('top-2'), row('busy-1', true), row('top-3'), row('other-1'), row('busy-2', true), row('other-2')]
        const { rerender } = setup(list)
        await flush(EAGER_PREFETCH_TOP_N * 1000)

        const prefetched = getSession.mock.calls.map(([id]) => id).sort()
        // The first five rows (top-1, top-2, busy-1, top-3, other-1) plus the
        // active ones outside them (busy-2); other-2 is neither.
        expect(prefetched).toEqual(['busy-1', 'busy-2', 'other-1', 'top-1', 'top-2', 'top-3'])
        expect(queryClient.getQueryData(queryKeys.session('top-1'))).toEqual(detail)

        // The list refreshes (new array identity): fresh entries are not re-fetched.
        getSession.mockClear()
        rerender({ list: [...list], eager: true, baseline: false })
        await flush(1000)
        expect(getSession).not.toHaveBeenCalled()
    })

    it('is a no-op unless eager or baseline mode is on; baseline covers every row', async () => {
        const off = setup([row('a', true)], { eager: false })
        await flush(1000)
        expect(getSession).not.toHaveBeenCalled()
        off.unmount()

        setup([row('a'), row('b'), row('c')], { eager: false, baseline: true })
        await flush(3000)
        expect(getSession.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b', 'c'])
    })

    it(`never keeps more than ${MAX_PREFETCH_IN_FLIGHT} prefetches on the wire, however slow the link`, async () => {
        const pending: Array<ReturnType<typeof deferred<typeof detail>>> = []
        getSession.mockImplementation(() => { const d = deferred<typeof detail>(); pending.push(d); return d.promise })
        setup([row('s1', true), row('s2', true), row('s3', true), row('s4', true), row('s5', true), row('s6', true)])

        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(1)
        await flush(200)
        expect(getSession).toHaveBeenCalledTimes(2)
        // A stuck link: ten seconds later nothing else has been queued behind the two.
        await flush(10_000)
        expect(getSession).toHaveBeenCalledTimes(MAX_PREFETCH_IN_FLIGHT)

        // The first one completes: exactly one more follows, 200ms later.
        await act(async () => { pending[0].resolve(detail) })
        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(MAX_PREFETCH_IN_FLIGHT)
        await flush(200)
        expect(getSession).toHaveBeenCalledTimes(MAX_PREFETCH_IN_FLIGHT + 1)
    })

    it('hands a slot back when a prefetch never settles, so the batch is not wedged', async () => {
        const hanging = deferred<typeof detail>()
        getSession.mockImplementation(() => hanging.promise)
        setup([row('s1', true), row('s2', true), row('s3', true)])
        await flush(200)
        expect(getSession).toHaveBeenCalledTimes(2)

        // Both hang past the slot timeout; the batch then resumes one at a time.
        await flush(20_000)
        expect(getSession.mock.calls.map(([id]) => id)).toEqual(['s1', 's2', 's3'])
        hanging.resolve(detail)
    })

    it('backs off after a failure instead of stacking requests on a dead connection', async () => {
        getSession.mockRejectedValue(new TypeError('Failed to fetch'))
        const { rerender } = setup([row('s1', true), row('s2', true), row('s3', true)])

        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(1)
        // The 200ms slot of the stagger arrives inside the back-off window: skipped.
        await flush(200)
        expect(getSession).toHaveBeenCalledTimes(1)

        // The list keeps refreshing (SSE replay, polling); none of it restarts prefetching.
        rerender({ list: [row('s0', true), row('s1', true), row('s2', true)], eager: true, baseline: false })
        await flush(1000)
        rerender({ list: [row('s1', true), row('s2', true)], eager: true, baseline: false })
        await flush(500)
        expect(getSession).toHaveBeenCalledTimes(1)

        // Back-off over (2s for the first failure): the next refresh tries again…
        await flush(600)
        rerender({ list: [row('s9', true), row('s1', true)], eager: true, baseline: false })
        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(2)
        // …and a second consecutive failure waits longer (5s) this time.
        rerender({ list: [row('s8', true)], eager: true, baseline: false })
        await flush(3000)
        rerender({ list: [row('s7', true)], eager: true, baseline: false })
        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(2)
        await flush(2100)
        rerender({ list: [row('s6', true)], eager: true, baseline: false })
        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(3)
    })

    it('starts the back-off over after a success', async () => {
        getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'))
        const { rerender } = setup([row('s1', true)])
        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(1)

        await flush(2100)
        getSession.mockResolvedValueOnce(detail)
        rerender({ list: [row('s2', true)], eager: true, baseline: false })
        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(2)

        // Next failure is a "first" failure again: 2s, not the third step (15s).
        getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'))
        await flush(2100)
        rerender({ list: [row('s3', true)], eager: true, baseline: false })
        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(3)
        await flush(7000)
        rerender({ list: [row('s4', true)], eager: true, baseline: false })
        await flush(0)
        expect(getSession).toHaveBeenCalledTimes(4)
    })

    it('prefetches nothing while the browser is offline', async () => {
        const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
        const { rerender } = setup([row('s1', true)])
        await flush(1000)
        expect(getSession).not.toHaveBeenCalled()

        onLine.mockReturnValue(true)
        rerender({ list: [row('s1', true), row('s2', true)], eager: true, baseline: false })
        await flush(1000)
        expect(getSession.mock.calls.map(([id]) => id).sort()).toEqual(['s1', 's2'])
    })
})

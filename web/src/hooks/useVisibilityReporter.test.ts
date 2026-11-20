import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client'
import { useVisibilityReporter } from '@/hooks/useVisibilityReporter'
import {
    markSubscriptionTornDown,
    resetSubscriptionLivenessForTests,
    reviveSubscription
} from '@/lib/sseSubscriptionLiveness'

function setVisibilityState(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: state,
    })
}

function deferred<T>(): {
    promise: Promise<T>
    resolve: (value: T) => void
} {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve
    })
    return { promise, resolve }
}

afterEach(() => {
    setVisibilityState('visible')
})

describe('useVisibilityReporter', () => {
    it('preserves a hidden transition that arrives while a visible report is pending', async () => {
        const visibleReport = deferred<void>()
        const api = {
            setVisibility: vi.fn()
                .mockImplementationOnce(() => visibleReport.promise)
                .mockResolvedValue(undefined),
        } as unknown as ApiClient

        setVisibilityState('visible')
        renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-1' }))

        expect(api.setVisibility).toHaveBeenCalledWith({
            subscriptionId: 'sub-1',
            visibility: 'visible',
        })

        setVisibilityState('hidden')
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })

        expect(api.setVisibility).toHaveBeenCalledTimes(1)

        await act(async () => {
            visibleReport.resolve(undefined)
        })

        expect(api.setVisibility).toHaveBeenNthCalledWith(2, {
            subscriptionId: 'sub-1',
            visibility: 'hidden',
        })
    })

    it('preserves a visible transition that arrives while a hidden report is pending', async () => {
        const hiddenReport = deferred<void>()
        const api = {
            setVisibility: vi.fn()
                .mockImplementationOnce(() => hiddenReport.promise)
                .mockResolvedValue(undefined),
        } as unknown as ApiClient

        setVisibilityState('hidden')
        renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-1' }))

        expect(api.setVisibility).toHaveBeenCalledWith({
            subscriptionId: 'sub-1',
            visibility: 'hidden',
        })

        setVisibilityState('visible')
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })

        expect(api.setVisibility).toHaveBeenCalledTimes(1)

        await act(async () => {
            hiddenReport.resolve(undefined)
        })

        expect(api.setVisibility).toHaveBeenNthCalledWith(2, {
            subscriptionId: 'sub-1',
            visibility: 'visible',
        })
    })

    it('does not let a previous subscription unlock a new report', async () => {
        const oldReport = deferred<void>()
        const newReport = deferred<void>()
        const api = {
            setVisibility: vi.fn()
                .mockImplementationOnce(() => oldReport.promise)
                .mockImplementationOnce(() => newReport.promise)
                .mockResolvedValue(undefined),
        } as unknown as ApiClient

        setVisibilityState('visible')
        const { rerender } = renderHook(
            ({ subscriptionId }) => useVisibilityReporter({ api, subscriptionId }),
            { initialProps: { subscriptionId: 'sub-old' } },
        )

        rerender({ subscriptionId: 'sub-new' })
        expect(api.setVisibility).toHaveBeenCalledTimes(2)

        await act(async () => {
            oldReport.resolve(undefined)
        })

        setVisibilityState('hidden')
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(api.setVisibility).toHaveBeenCalledTimes(2)

        await act(async () => {
            newReport.resolve(undefined)
        })

        expect(api.setVisibility).toHaveBeenNthCalledWith(3, {
            subscriptionId: 'sub-new',
            visibility: 'hidden',
        })
    })

    it('stops reporting for a subscription after a 404 rejection', async () => {
        vi.useFakeTimers()
        try {
            const api = {
                setVisibility: vi.fn().mockRejectedValue(new ApiError('HTTP 404 Not Found', 404)),
            } as unknown as ApiClient

            setVisibilityState('visible')
            renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-gone' }))

            await act(async () => {
                await vi.advanceTimersByTimeAsync(0)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(1)

            // No retry for a permanent rejection, and later visibility changes
            // stay silent for this subscription id.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(1)

            setVisibilityState('hidden')
            act(() => {
                document.dispatchEvent(new Event('visibilitychange'))
            })
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('resumes reporting once a new subscription id replaces a rejected one', async () => {
        vi.useFakeTimers()
        try {
            const api = {
                setVisibility: vi.fn()
                    .mockRejectedValueOnce(new ApiError('HTTP 404 Not Found', 404))
                    .mockResolvedValue(undefined),
            } as unknown as ApiClient

            setVisibilityState('visible')
            const { rerender } = renderHook(
                ({ subscriptionId }) => useVisibilityReporter({ api, subscriptionId }),
                { initialProps: { subscriptionId: 'sub-old' } },
            )

            await act(async () => {
                await vi.advanceTimersByTimeAsync(0)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(1)

            rerender({ subscriptionId: 'sub-new' })
            await act(async () => {
                await vi.advanceTimersByTimeAsync(0)
            })

            expect(api.setVisibility).toHaveBeenCalledTimes(2)
            expect(api.setVisibility).toHaveBeenNthCalledWith(2, {
                subscriptionId: 'sub-new',
                visibility: 'visible',
            })
        } finally {
            vi.useRealTimers()
        }
    })

    it('retries transient failures with exponential backoff', async () => {
        vi.useFakeTimers()
        try {
            const api = {
                setVisibility: vi.fn()
                    .mockRejectedValueOnce(new Error('network down'))
                    .mockRejectedValueOnce(new ApiError('HTTP 502 Bad Gateway', 502))
                    .mockResolvedValue(undefined),
            } as unknown as ApiClient

            setVisibilityState('visible')
            renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-1' }))

            expect(api.setVisibility).toHaveBeenCalledTimes(1)

            // First retry after 2s.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(2)

            // Second retry after 4s more; nothing in between.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(2)
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(3)

            // Third attempt succeeds; no further calls.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(3)
        } finally {
            vi.useRealTimers()
        }
    })

    it('stops retrying a transient failure after the attempt budget is exhausted', async () => {
        vi.useFakeTimers()
        try {
            const api = {
                setVisibility: vi.fn().mockRejectedValue(new Error('network down')),
            } as unknown as ApiClient

            setVisibilityState('visible')
            renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-1' }))

            // 1 initial attempt + 5 retries = 6 calls; delays 2s, 4s, 8s, 16s, 32s.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 16_000 + 32_000 + 1_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(6)

            // Budget exhausted: no further retries for this report.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(120_000)
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(6)

            // A new visibility transition starts a fresh budget.
            setVisibilityState('hidden')
            act(() => {
                document.dispatchEvent(new Event('visibilitychange'))
            })
            expect(api.setVisibility).toHaveBeenCalledTimes(7)
            expect(api.setVisibility).toHaveBeenNthCalledWith(7, {
                subscriptionId: 'sub-1',
                visibility: 'hidden',
            })
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('useVisibilityReporter wake discipline (reconnect skipping)', () => {
    afterEach(() => {
        resetSubscriptionLivenessForTests()
    })

    it('seeds from the connection URL declaration and skips the redundant first POST', async () => {
        const api = {
            setVisibility: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        // The reconnect's URL carried visibility=visible, which the hub
        // applied as the fresh subscription's initial state: the reporter's
        // first report for the new id used to re-POST it anyway.
        setVisibilityState('visible')
        renderHook(() => useVisibilityReporter({
            api,
            subscriptionId: 'sub-new',
            declaredVisibility: 'visible'
        }))

        expect(api.setVisibility).not.toHaveBeenCalled()

        // A real state change still reports.
        setVisibilityState('hidden')
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(api.setVisibility).toHaveBeenCalledTimes(1)
        expect(api.setVisibility).toHaveBeenNthCalledWith(1, {
            subscriptionId: 'sub-new',
            visibility: 'hidden',
        })
    })

    it('POSTs when the tab state differs from what the URL declared', () => {
        const api = {
            setVisibility: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        // URL declared visible, but the tab flipped hidden before the
        // reporter caught up: the hub's seed is now wrong and must be fixed.
        setVisibilityState('hidden')
        renderHook(() => useVisibilityReporter({
            api,
            subscriptionId: 'sub-new',
            declaredVisibility: 'visible'
        }))

        expect(api.setVisibility).toHaveBeenCalledTimes(1)
        expect(api.setVisibility).toHaveBeenCalledWith({
            subscriptionId: 'sub-new',
            visibility: 'hidden',
        })
    })

    it('skips the doomed POST against a subscription useSSE just tore down', () => {
        const api = {
            setVisibility: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        // Simulates the wake ordering: useSSE's visibilitychange listener ran
        // first and closed the stale connection; the reporter's listener runs
        // in the same dispatch, before React delivers the null subscriptionId.
        markSubscriptionTornDown('sub-old')
        setVisibilityState('visible')
        renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-old' }))

        expect(api.setVisibility).not.toHaveBeenCalled()

        // While the id stays marked dead, later transitions stay silent…
        setVisibilityState('hidden')
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(api.setVisibility).not.toHaveBeenCalled()

        // …and reporting resumes the moment the id is live again.
        reviveSubscription('sub-old')
        setVisibilityState('visible')
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(api.setVisibility).toHaveBeenCalledTimes(1)
        expect(api.setVisibility).toHaveBeenCalledWith({
            subscriptionId: 'sub-old',
            visibility: 'visible',
        })
    })

    it('omits declaredVisibility seeds fall back to reporting (older callers)', () => {
        const api = {
            setVisibility: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        setVisibilityState('visible')
        renderHook(() => useVisibilityReporter({ api, subscriptionId: 'sub-1' }))

        // No declaration → no seed → the first report POSTs as before.
        expect(api.setVisibility).toHaveBeenCalledTimes(1)
        expect(api.setVisibility).toHaveBeenCalledWith({
            subscriptionId: 'sub-1',
            visibility: 'visible',
        })
    })
})

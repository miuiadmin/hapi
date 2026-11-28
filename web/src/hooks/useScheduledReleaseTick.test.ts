import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { useScheduledReleaseTick } from './useScheduledReleaseTick'

function row(id: string, scheduledAt: number | null, invokedAt: number | null = null): DecryptedMessage {
    return {
        id, localId: `local-${id}`, createdAt: 1, seq: 1, scheduledAt, invokedAt,
        content: { role: 'user', content: { type: 'text', text: id } },
    } as DecryptedMessage
}

describe('useScheduledReleaseTick', () => {
    let start: number
    beforeEach(() => {
        vi.useFakeTimers()
        start = Date.now()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('moves when the earliest row still ahead is due, and only then', async () => {
        const messages = [row('soon', start + 1_000), row('later', start + 5_000)]
        const { result } = renderHook(() => useScheduledReleaseTick(messages))
        expect(result.current).toBe(start)

        await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
        const firstTick = result.current
        expect(firstTick).toBeGreaterThanOrEqual(start + 1_000)

        // Still ahead of the second row: the clock stays where it is.
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
        expect(result.current).toBe(firstTick)

        await act(async () => { await vi.advanceTimersByTimeAsync(3_100) })
        expect(result.current).toBeGreaterThanOrEqual(start + 5_000)
    })

    it('catches up when a row arrives that the wall clock says is due', async () => {
        const { result, rerender } = renderHook(({ messages }) => useScheduledReleaseTick(messages), {
            initialProps: { messages: [] as DecryptedMessage[] },
        })
        expect(result.current).toBe(start)
        // An hour later a row is synced that was due half an hour ago.
        await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000) })
        rerender({ messages: [row('overdue', start + 30 * 60_000)] })
        await act(async () => { await Promise.resolve() })
        expect(result.current).toBeGreaterThanOrEqual(start + 30 * 60_000)
    })

    it('sets no timer when no queued row is still ahead', async () => {
        const messages = [row('taken', start + 1_000, 5), row('past', start - 1_000), row('now', null)]
        const { result } = renderHook(() => useScheduledReleaseTick(messages))
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
        expect(result.current).toBe(start)
    })
})

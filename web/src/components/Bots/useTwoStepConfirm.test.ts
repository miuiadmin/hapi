import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIRM_WINDOW_MS, useTwoStepConfirm } from './useTwoStepConfirm'

describe('useTwoStepConfirm', () => {
    afterEach(() => { vi.useRealTimers() })

    it('fires on the second click within the window, not the first', () => {
        const onConfirm = vi.fn()
        const { result } = renderHook(() => useTwoStepConfirm(onConfirm))
        act(() => result.current.onClick())
        expect(result.current.armed).toBe(true)
        expect(onConfirm).not.toHaveBeenCalled()
        act(() => result.current.onClick())
        expect(onConfirm).toHaveBeenCalledTimes(1)
        expect(result.current.armed).toBe(false)
    })

    it('disarms when the window runs out', () => {
        vi.useFakeTimers()
        const onConfirm = vi.fn()
        const { result } = renderHook(() => useTwoStepConfirm(onConfirm, 1_000))
        act(() => result.current.onClick())
        act(() => { vi.advanceTimersByTime(999) })
        expect(result.current.armed).toBe(true)
        act(() => { vi.advanceTimersByTime(1) })
        expect(result.current.armed).toBe(false)
        act(() => result.current.onClick())
        expect(onConfirm).not.toHaveBeenCalled()
        expect(result.current.armed).toBe(true)
    })

    it('disarms on blur, and the default window is seconds, not minutes', () => {
        const onConfirm = vi.fn()
        const { result } = renderHook(() => useTwoStepConfirm(onConfirm))
        act(() => result.current.onClick())
        act(() => result.current.onBlur())
        expect(result.current.armed).toBe(false)
        expect(CONFIRM_WINDOW_MS).toBeGreaterThanOrEqual(3_000)
        expect(CONFIRM_WINDOW_MS).toBeLessThanOrEqual(6_000)
    })

    it('calls the latest onConfirm, not the one from the first render', () => {
        const first = vi.fn()
        const second = vi.fn()
        const { result, rerender } = renderHook(({ onConfirm }) => useTwoStepConfirm(onConfirm), { initialProps: { onConfirm: first } })
        act(() => result.current.onClick())
        rerender({ onConfirm: second })
        act(() => result.current.onClick())
        expect(first).not.toHaveBeenCalled()
        expect(second).toHaveBeenCalledTimes(1)
    })
})

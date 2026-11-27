import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { ToastProvider, useAddToast, useOptionalAddToast, useToast } from './toast-context'

const wrap = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>

describe('useOptionalAddToast', () => {
    it('returns null outside a ToastProvider, where useAddToast throws', () => {
        const outside = renderHook(() => useOptionalAddToast())
        expect(outside.result.current).toBeNull()
        expect(() => renderHook(() => useAddToast())).toThrow(/ToastProvider/)
    })

    it('returns the provider\'s addToast inside one', () => {
        const { result } = renderHook(
            () => ({ optional: useOptionalAddToast(), required: useAddToast(), context: useToast() }),
            { wrapper: wrap }
        )
        expect(typeof result.current.optional).toBe('function')
        expect(result.current.optional).toBe(result.current.required)
        expect(result.current.optional).toBe(result.current.context.addToast)
    })
})

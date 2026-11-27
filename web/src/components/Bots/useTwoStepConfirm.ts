import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the second click may take after the first. */
export const CONFIRM_WINDOW_MS = 4_000

/**
 * Two clicks for an action the hub cannot undo (an item marked done or
 * canceled, a bot archived): the first click arms it and the button asks
 * to confirm; the second within the window fires. Blur, or the window
 * running out, puts the button back.
 */
export function useTwoStepConfirm(onConfirm: () => void, windowMs: number = CONFIRM_WINDOW_MS) {
    const [armed, setArmed] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const confirmRef = useRef(onConfirm)
    confirmRef.current = onConfirm

    const clearTimer = () => {
        if (timer.current) {
            clearTimeout(timer.current)
            timer.current = null
        }
    }

    const disarm = useCallback(() => {
        clearTimer()
        setArmed(false)
    }, [])

    const onClick = useCallback(() => {
        clearTimer()
        if (armed) {
            setArmed(false)
            confirmRef.current()
            return
        }
        setArmed(true)
        timer.current = setTimeout(() => {
            timer.current = null
            setArmed(false)
        }, windowMs)
    }, [armed, windowMs])

    useEffect(() => clearTimer, [])

    return { armed, onClick, onBlur: disarm }
}

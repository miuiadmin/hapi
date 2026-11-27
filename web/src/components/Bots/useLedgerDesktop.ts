import { useEffect, useState } from 'react'

/**
 * Tailwind's `sm:` breakpoint, read from JS: the ledger is a modal sheet
 * below it and a non-modal side panel from it up, and both the CSS and
 * this have to agree at exactly 640px. (`useNarrowViewport` is
 * `max-width: 640px`, which still counts 640 as narrow while Tailwind's
 * `sm:` already applies there; a mismatch flips Radix between its modal
 * and non-modal content components and remounts the whole panel.)
 */
export const LEDGER_DESKTOP_QUERY = '(min-width: 640px)'

export function useLedgerDesktop(): boolean {
    const [isDesktop, setIsDesktop] = useState(() => (
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia(LEDGER_DESKTOP_QUERY).matches
    ))

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return
        }
        const mql = window.matchMedia(LEDGER_DESKTOP_QUERY)
        const update = () => setIsDesktop(mql.matches)
        update()
        mql.addEventListener('change', update)
        return () => mql.removeEventListener('change', update)
    }, [])

    return isDesktop
}

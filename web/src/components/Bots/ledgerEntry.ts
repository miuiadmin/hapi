/**
 * The ledger's entry buttons carry this attribute: the header icon (from
 * `sm:` up) and the row under the header (below). Which one is on screen
 * depends on the stylesheet, so focus-return picks the one that has layout.
 */
export const LEDGER_ENTRY_ATTRIBUTE = 'data-ledger-entry'

/** Moves focus to the visible ledger entry; false when there is none. */
export function focusLedgerEntry(): boolean {
    if (typeof document === 'undefined') return false
    const entries = document.querySelectorAll<HTMLButtonElement>(`[${LEDGER_ENTRY_ATTRIBUTE}]`)
    for (const entry of entries) {
        if (entry.disabled) continue
        if (entry.getClientRects().length > 0) {
            entry.focus()
            return true
        }
    }
    return false
}

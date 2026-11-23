import { useCallback, useEffect, useState } from 'react'

/**
 * Sidebar "In progress" pin policy (ships with session-attached jobs #1404).
 *
 * Degree of float, not a yes/no:
 * - off  — everything stays in project directories
 * - jobs — only sessions with a running attachedJob (outliving work)
 * - all  — jobs + agent working/pending (UI: "Working & pending"; storage key
 *          stays `all` for migration). Quiet connected (socket up, idle) never floats.
 *
 * This fork keeps the section opt-in. Unset / never configured defaults to
 * `off` (upstream stands on `jobs`, tiann/hapi#1424): sessions stay in their
 * project directory groups and "Running" is only the row status. Devices that
 * already carry upstream's default are restored once — see
 * PIN_IN_PROGRESS_RESTORE_MARKER_KEY. After that a stored value is honoured as
 * written; Settings → Display is the only thing that changes it.
 */

export type PinInProgressMode = 'off' | 'jobs' | 'all'

export const PIN_IN_PROGRESS_MODES: readonly PinInProgressMode[] = ['off', 'jobs', 'all'] as const

/** New default when the preference has never been set. */
export const DEFAULT_PIN_IN_PROGRESS_MODE: PinInProgressMode = 'off'

export const PIN_IN_PROGRESS_STORAGE_KEY = 'hapi-pin-in-progress-sessions'

/**
 * One-time restore marker.
 *
 * Upstream #1424 wrote its own `jobs` default — and its mapping of the legacy
 * switch's "on", `all` — under the very key a real choice uses, so a device
 * cannot tell "never chosen" from "chosen". The first load of a build carrying
 * this marker resets a stored `jobs` / `all` to `off`. From then on the marker
 * is set and the stored value is honoured as written, including a deliberate
 * `jobs` / `all` picked in Settings afterwards.
 */
export const PIN_IN_PROGRESS_RESTORE_MARKER_KEY = 'hapi-pin-in-progress-restored-v1'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) {
        return null
    }
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) {
        return
    }
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors
    }
}

/**
 * Parse stored value.
 * - absent / null → `off` (fork default)
 * - legacy `true` → `all`
 * - legacy `false` → `off`
 * - `off` | `jobs` | `all` → as written
 */
export function parsePinInProgressMode(raw: string | null): PinInProgressMode {
    if (raw === null || raw === '') {
        return DEFAULT_PIN_IN_PROGRESS_MODE
    }
    if (raw === 'true') {
        return 'all'
    }
    if (raw === 'false') {
        return 'off'
    }
    if (raw === 'off' || raw === 'jobs' || raw === 'all') {
        return raw
    }
    return DEFAULT_PIN_IN_PROGRESS_MODE
}

export function getInitialPinInProgressMode(): PinInProgressMode {
    const raw = safeGetItem(PIN_IN_PROGRESS_STORAGE_KEY)
    const stored = parsePinInProgressMode(raw)
    let mode = stored
    if (safeGetItem(PIN_IN_PROGRESS_RESTORE_MARKER_KEY) !== '1') {
        safeSetItem(PIN_IN_PROGRESS_RESTORE_MARKER_KEY, '1')
        // Reset only once the marker is confirmed stored: a browser that cannot
        // persist it must not override a choice on every single load.
        if ((raw === 'jobs' || raw === 'all') && safeGetItem(PIN_IN_PROGRESS_RESTORE_MARKER_KEY) === '1') {
            mode = 'off'
        }
    }
    // Persist what was resolved: a reset value, and the legacy true/false and
    // never-set forms (upstream removed the key on false, so those devices
    // already look like unset).
    if (mode !== stored || raw === null || raw === '' || raw === 'true' || raw === 'false') {
        safeSetItem(PIN_IN_PROGRESS_STORAGE_KEY, mode)
    }
    return mode
}

/** @deprecated Use getInitialPinInProgressMode — boolean form treated `all` as true. */
export function getInitialPinInProgressSessions(): boolean {
    return getInitialPinInProgressMode() !== 'off'
}

export function getPinInProgressModeOptions(): ReadonlyArray<{
    value: PinInProgressMode
    labelKey: string
}> {
    return [
        { value: 'off', labelKey: 'settings.display.pinInProgressMode.off' },
        { value: 'jobs', labelKey: 'settings.display.pinInProgressMode.jobs' },
        { value: 'all', labelKey: 'settings.display.pinInProgressMode.all' },
    ]
}

export function usePinInProgressSessions(): {
    pinInProgressMode: PinInProgressMode
    setPinInProgressMode: (value: PinInProgressMode) => void
    /** True when mode is not off (any pin bucket may show). */
    pinInProgressSessions: boolean
    /** @deprecated Prefer setPinInProgressMode. `true`→all, `false`→off. */
    setPinInProgressSessions: (value: boolean) => void
} {
    const [pinInProgressMode, setPinInProgressModeState] = useState<PinInProgressMode>(
        getInitialPinInProgressMode
    )

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== PIN_IN_PROGRESS_STORAGE_KEY) {
                return
            }
            setPinInProgressModeState(parsePinInProgressMode(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setPinInProgressMode = useCallback((value: PinInProgressMode) => {
        setPinInProgressModeState(value)
        // Always persist so an explicit Off is distinct from never-set→jobs default
        // after the user has opened Settings and chosen.
        safeSetItem(PIN_IN_PROGRESS_STORAGE_KEY, value)
    }, [])

    const setPinInProgressSessions = useCallback((value: boolean) => {
        setPinInProgressMode(value ? 'all' : 'off')
    }, [setPinInProgressMode])

    return {
        pinInProgressMode,
        setPinInProgressMode,
        pinInProgressSessions: pinInProgressMode !== 'off',
        setPinInProgressSessions
    }
}

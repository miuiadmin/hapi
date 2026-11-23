import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    DEFAULT_PIN_IN_PROGRESS_MODE,
    PIN_IN_PROGRESS_RESTORE_MARKER_KEY,
    PIN_IN_PROGRESS_STORAGE_KEY,
    getInitialPinInProgressMode,
    parsePinInProgressMode
} from './usePinInProgressSessions'

describe('parsePinInProgressMode', () => {
    it('defaults unset to off — sessions stay in their directory groups (fork default)', () => {
        expect(parsePinInProgressMode(null)).toBe('off')
        expect(parsePinInProgressMode('')).toBe('off')
        expect(DEFAULT_PIN_IN_PROGRESS_MODE).toBe('off')
    })

    it('migrates legacy boolean strings', () => {
        expect(parsePinInProgressMode('true')).toBe('all')
        expect(parsePinInProgressMode('false')).toBe('off')
    })

    it('accepts explicit tri-state values', () => {
        expect(parsePinInProgressMode('off')).toBe('off')
        expect(parsePinInProgressMode('jobs')).toBe('jobs')
        expect(parsePinInProgressMode('all')).toBe('all')
    })

    it('falls back to off on garbage', () => {
        expect(parsePinInProgressMode('maybe')).toBe('off')
    })
})

describe('getInitialPinInProgressMode', () => {
    afterEach(() => {
        localStorage.removeItem(PIN_IN_PROGRESS_STORAGE_KEY)
        localStorage.removeItem(PIN_IN_PROGRESS_RESTORE_MARKER_KEY)
        vi.restoreAllMocks()
    })

    it('resolves and persists the off default for a never-set device', () => {
        localStorage.removeItem(PIN_IN_PROGRESS_STORAGE_KEY)
        expect(getInitialPinInProgressMode()).toBe('off')
        expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('off')
    })

    it('rewrites legacy false to persisted off', () => {
        localStorage.setItem(PIN_IN_PROGRESS_STORAGE_KEY, 'false')
        expect(getInitialPinInProgressMode()).toBe('off')
        expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('off')
    })

    it('keeps an explicit off as off and still plants the restore marker', () => {
        localStorage.setItem(PIN_IN_PROGRESS_STORAGE_KEY, 'off')
        expect(getInitialPinInProgressMode()).toBe('off')
        expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('off')
        expect(localStorage.getItem(PIN_IN_PROGRESS_RESTORE_MARKER_KEY)).toBe('1')
    })

    it('maps legacy true to all and leaves that switch position alone', () => {
        localStorage.setItem(PIN_IN_PROGRESS_STORAGE_KEY, 'true')
        expect(getInitialPinInProgressMode()).toBe('all')
        expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('all')
    })

    it.each(['jobs', 'all'] as const)(
        'restores a stored %s to off once — upstream wrote it for devices that never chose it',
        (stored) => {
            localStorage.setItem(PIN_IN_PROGRESS_STORAGE_KEY, stored)
            expect(getInitialPinInProgressMode()).toBe('off')
            expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('off')
            expect(localStorage.getItem(PIN_IN_PROGRESS_RESTORE_MARKER_KEY)).toBe('1')

            // One-time only: the same value picked in Settings afterwards sticks.
            localStorage.setItem(PIN_IN_PROGRESS_STORAGE_KEY, stored)
            expect(getInitialPinInProgressMode()).toBe(stored)
            expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe(stored)
        }
    )

    it('does not reset anything when the restore marker cannot be persisted', () => {
        localStorage.setItem(PIN_IN_PROGRESS_STORAGE_KEY, 'jobs')
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
        expect(getInitialPinInProgressMode()).toBe('jobs')
        expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('jobs')
        expect(localStorage.getItem(PIN_IN_PROGRESS_RESTORE_MARKER_KEY)).toBeNull()
    })
})

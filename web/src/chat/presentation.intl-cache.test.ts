import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    formatMessageTimestamp,
    formatMessageTimestampTitle,
    formatOutlineTimestamp,
    formatResetTime,
    formatUnixTimestamp,
} from './presentation'

// The timestamp formatters use cached Intl.DateTimeFormat instances (one per
// options + locale) instead of building one on every call. Each output must stay
// identical to the Date.prototype.toLocale* call it replaced, for any locale the
// process happens to default to.

/** 64 instants ~1 hour apart, so every minute/hour combination is hit several times. */
const INSTANTS: Date[] = Array.from({ length: 64 }, (_, i) => new Date(new Date(2026, 0, 5, 0, 7).getTime() + i * 3_671_000))

const TIME_H23 = { hour: '2-digit' as const, minute: '2-digit' as const, hourCycle: 'h23' as const }
const TITLE_OPTIONS = {
    year: 'numeric' as const,
    month: 'short' as const,
    day: 'numeric' as const,
    hour: 'numeric' as const,
    minute: '2-digit' as const,
    second: '2-digit' as const,
}

describe('cached Intl formatters match the toLocale* calls they replaced', () => {
    it('formatUnixTimestamp: seconds and milliseconds', () => {
        for (const date of INSTANTS) {
            const ms = date.getTime()
            expect(formatUnixTimestamp(Math.floor(ms / 1000))).toBe(date.toLocaleString())
            expect(formatUnixTimestamp(ms)).toBe(date.toLocaleString())
        }
        expect(formatUnixTimestamp(NaN)).toBe('NaN')
    })

    it('formatMessageTimestampTitle', () => {
        for (const date of INSTANTS) {
            expect(formatMessageTimestampTitle(date)).toBe(date.toLocaleString(undefined, TITLE_OPTIONS))
        }
        expect(formatMessageTimestampTitle(new Date(NaN))).toBe('Invalid Date')
    })

    it('formatMessageTimestamp: same day, same year, other year', () => {
        const now = new Date(2026, 5, 15, 14, 30)
        for (const date of INSTANTS) {
            const expected = formatReference(date, now)
            expect(formatMessageTimestamp(date, now)).toBe(expected)
        }
        const otherYear = new Date(2025, 11, 31, 23, 59)
        expect(formatMessageTimestamp(otherYear, now)).toBe(formatReference(otherYear, now))
        expect(formatMessageTimestamp(new Date(NaN), now)).toBe('Invalid Date')
    })

    it('formatResetTime: today shows the time only, other days the date too', () => {
        const today = new Date()
        today.setHours(9, 5, 0, 0)
        const otherDay = new Date(2020, 2, 3, 9, 5)
        expect(formatResetTime(today.getTime())).toBe(today.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
        expect(formatResetTime(otherDay.getTime())).toBe(otherDay.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
    })

    it('formatOutlineTimestamp: every supported locale', () => {
        const now = new Date(2026, 6, 21, 12, 0)
        const sameDay = new Date(2026, 6, 21, 9, 55)
        const sameYear = new Date(2026, 8, 9, 10, 31)
        const otherYear = new Date(2025, 8, 9, 10, 31)
        for (const locale of ['en', 'zh-CN', 'ru', 'ja'] as const) {
            const time = (d: Date) => d.toLocaleTimeString(locale, TIME_H23)
            expect(formatOutlineTimestamp(sameDay, locale, now)).toBe(time(sameDay))
            const expectedSameYear = { en: `09/09 ${time(sameYear)}`, 'zh-CN': `09月09日 ${time(sameYear)}`, ja: `09月09日 ${time(sameYear)}`, ru: `09.09 ${time(sameYear)}` }[locale]
            const expectedOtherYear = { en: `2025/09/09 ${time(otherYear)}`, 'zh-CN': `2025年09月09日 ${time(otherYear)}`, ja: `2025年09月09日 ${time(otherYear)}`, ru: `09.09.2025 ${time(otherYear)}` }[locale]
            expect(formatOutlineTimestamp(sameYear, locale, now)).toBe(expectedSameYear)
            expect(formatOutlineTimestamp(otherYear, locale, now)).toBe(expectedOtherYear)
        }
    })

    it('returns the same string on repeated calls (the cache does not drift)', () => {
        const date = INSTANTS[10]
        const first = formatMessageTimestamp(date, new Date(2026, 0, 5))
        for (let i = 0; i < 50; i += 1) expect(formatMessageTimestamp(date, new Date(2026, 0, 5))).toBe(first)
        expect(first).toBe(date.toLocaleTimeString(undefined, TIME_H23))
    })
})

/** The pre-cache implementation, kept here as the reference. */
function formatReference(date: Date, now: Date): string {
    const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate()
    if (sameDay) return date.toLocaleTimeString(undefined, TIME_H23)
    const sameYear = date.getFullYear() === now.getFullYear()
    if (sameYear) {
        return date.toLocaleString(undefined, { month: 'short', day: 'numeric', ...TIME_H23 })
    }
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', ...TIME_H23 })
}

describe('the formatters follow the time zone (v1-F1)', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('a zone with the same offset at the epoch but other rules is followed: Denver → Phoenix', () => {
        // Both are UTC-7 on 1970-01-01; in July Denver is on daylight time (UTC-6) and Phoenix is not.
        const previous = process.env.TZ
        try {
            process.env.TZ = 'America/Denver'
            const summerNoonUtc = new Date(Date.UTC(2026, 6, 1, 12, 0))
            expect(formatMessageTimestamp(summerNoonUtc, new Date(Date.UTC(2026, 6, 1, 18, 0)))).toBe('06:00')

            process.env.TZ = 'America/Phoenix'
            // Thirty seconds later, at the throttled check point.
            const later = Date.now() + 31_000
            vi.spyOn(Date, 'now').mockReturnValue(later)
            expect(formatMessageTimestamp(summerNoonUtc, new Date(Date.UTC(2026, 6, 1, 18, 0)))).toBe('05:00')
        } finally {
            if (previous === undefined) delete process.env.TZ
            else process.env.TZ = previous
            vi.restoreAllMocks()
            // Let the next test start from a clean slate whatever the clock says.
            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
            formatUnixTimestamp(0)
        }
    })
})

/**
 * Time helpers for the bot tools: agent-facing timestamps (ISO plus a
 * relative hint) and the two shorthands the tools accept — durations like
 * `90m` / `2h` / `1d` / `1h30m` and points in time like `2026-11-28T09:00:00+08:00`
 * or `in 30m`.
 */

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60 * MS_PER_SECOND
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR
const MS_PER_WEEK = 7 * MS_PER_DAY

const DURATION_UNITS: ReadonlyArray<[unit: string, ms: number]> = [
    ['w', MS_PER_WEEK],
    ['d', MS_PER_DAY],
    ['h', MS_PER_HOUR],
    ['m', MS_PER_MINUTE],
    ['s', MS_PER_SECOND],
    ['ms', 1]
]

const DURATION_TOKEN = /(\d+)(ms|s|m|h|d|w)/y

/** `90m`, `2h`, `1d`, `1w`, `45s`, `1h30m`. Whole string must be a duration; bare numbers are refused. */
export function parseDurationMs(text: string): number | null {
    const trimmed = text.trim().toLowerCase().replace(/\s+/g, '')
    if (!trimmed) return null
    let cursor = 0
    let total = 0
    let tokens = 0
    while (cursor < trimmed.length) {
        DURATION_TOKEN.lastIndex = cursor
        const match = DURATION_TOKEN.exec(trimmed)
        if (!match || match.index !== cursor) return null
        const amount = Number(match[1])
        const scale = DURATION_UNITS.find(([candidate]) => candidate === match[2])?.[1]
        if (!Number.isFinite(amount) || !scale) return null
        total += amount * scale
        tokens += 1
        cursor += match[0].length
    }
    if (tokens === 0) return null
    return Number.isFinite(total) && total > 0 ? Math.round(total) : null
}

/** `2h`, `1h30m`, `45s`, `90m`. Anything under a second shows as seconds. */
export function humanizeDuration(ms: number): string {
    if (!Number.isFinite(ms)) return '?'
    const sign = ms < 0 ? '-' : ''
    let rest = Math.round(Math.abs(ms))
    const parts: string[] = []
    for (const [unit, scale] of DURATION_UNITS) {
        if (unit === 'ms') continue
        const count = Math.floor(rest / scale)
        if (count > 0) {
            parts.push(`${count}${unit}`)
            rest -= count * scale
        }
    }
    if (parts.length === 0) return `${sign}${Math.max(1, Math.round(Math.abs(ms) / MS_PER_SECOND))}s`
    return sign + parts.join('')
}

/** `2026-11-28` — a bare calendar date. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A point in time: ISO 8601, `in 30m` / `+1h` (relative to `now`), or a bare
 * duration (also relative). A date without a clock time (`2026-11-28`) means
 * midnight in the machine's local zone, the way a person says "on the 28th" —
 * not UTC midnight. Bare digits are refused on purpose — a stray `30` would
 * otherwise become 30 ms past the epoch. Returns epoch ms.
 */
export function parsePointInTime(text: string, now: number): number | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    const relative = /^(?:in\s+|\+)(.+)$/i.exec(trimmed)
    const candidate = relative ? relative[1]! : trimmed
    const isRelative = Boolean(relative) || parseDurationMs(candidate) !== null
    if (isRelative) {
        const duration = parseDurationMs(candidate)
        return duration === null ? null : now + duration
    }
    if (/^\d+$/.test(candidate)) return null
    const dateOnly = DATE_ONLY.exec(candidate)
    if (dateOnly) {
        const year = Number(dateOnly[1])
        const month = Number(dateOnly[2]) - 1
        const day = Number(dateOnly[3])
        const local = new Date(year, month, day)
        // Date rolls an impossible day over (Feb 30 → Mar 2); refuse it instead.
        return local.getFullYear() === year && local.getMonth() === month && local.getDate() === day ? local.getTime() : null
    }
    const parsed = Date.parse(candidate)
    return Number.isNaN(parsed) ? null : parsed
}

/** `2026-11-28T01:00:00.000Z (in 2h)` — ISO for a model to compare, relative for a human. */
export function formatWhen(ms: number | null | undefined, now: number = Date.now()): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '(none)'
    const iso = new Date(ms).toISOString()
    const delta = ms - now
    if (Math.abs(delta) < MS_PER_SECOND) return `${iso} (now)`
    return delta > 0
        ? `${iso} (in ${humanizeDuration(delta)})`
        : `${iso} (overdue by ${humanizeDuration(-delta)})`
}

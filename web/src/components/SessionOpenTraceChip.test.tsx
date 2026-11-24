import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionOpenTraceChip, formatOpenTraceBytes, formatOpenTraceMs } from './SessionOpenTraceChip'
import { I18nProvider } from '@/lib/i18n-context'
import {
    beginSessionOpenTrace,
    endSessionOpenTrace,
    noteSessionOpenFirstRow,
    noteSessionOpenPage,
    resetSessionOpenTrace,
    scheduleSessionOpenSettle
} from '@/lib/sessionOpenTrace'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn(), getLevel: vi.fn(() => 1) },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const getLevel = vi.mocked(telemetryClient.getLevel)
const SESSION = 'open-trace-chip-session'

function resource(
    name: string,
    start: number,
    end: number,
    sizes: { transferSize: number; encodedBodySize: number; decodedBodySize: number },
    status = 200
): PerformanceResourceTiming {
    return {
        name,
        entryType: 'resource',
        startTime: start,
        duration: end - start,
        requestStart: start,
        responseStart: status === 0 ? 0 : start + (end - start) / 2,
        responseEnd: end,
        responseStatus: status,
        ...sizes
    } as PerformanceResourceTiming
}

function serve(...entries: PerformanceResourceTiming[]): void {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(entries as unknown as PerformanceEntry[])
}

/** Advance fake time and let React commit what the frame callbacks changed. */
async function pass(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
    })
}

function chip(): HTMLElement | null {
    return screen.queryByTestId('session-open-trace')
}

beforeEach(() => {
    vi.useFakeTimers()
    // One presented frame every 16ms of fake time.
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
        setTimeout(() => callback(performance.now()), 16)
    })
    resetSessionOpenTrace()
    getLevel.mockReturnValue(1)
})

afterEach(() => {
    cleanup()
    resetSessionOpenTrace()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

function renderChip(): void {
    render(<I18nProvider><SessionOpenTraceChip sessionId={SESSION} /></I18nProvider>)
}

describe('SessionOpenTraceChip', () => {
    it('is a bar of its own from the start, and shows the open in progress', async () => {
        renderChip()
        // The bar keeps its place before any open was recorded, so nothing below it moves later.
        expect(chip()?.dataset.state).toBe('none')
        expect(chip()).toHaveTextContent('No open recorded for this session yet')

        act(() => { beginSessionOpenTrace(SESSION, false) })
        expect(chip()?.dataset.state).toBe('loading')
        expect(chip()).toHaveTextContent('Opening…')

        await pass(200)
        act(() => { noteSessionOpenFirstRow(SESSION) })
        await pass(32)
        expect(chip()).toHaveTextContent('Opening · first row 232ms')
    })

    it('shows when the first row was on screen, when the tail was current, and what the open cost', async () => {
        serve(
            resource('/api/sessions/open-trace-chip-session', 2, 40, { transferSize: 900, encodedBodySize: 800, decodedBodySize: 5_200 }),
            resource('/api/sessions/open-trace-chip-session/messages?limit=20&minConversation=1', 45, 245, { transferSize: 12_300, encodedBodySize: 12_000, decodedBodySize: 90_000 })
        )
        renderChip()
        act(() => { beginSessionOpenTrace(SESSION, false) })
        await pass(245)
        act(() => {
            noteSessionOpenPage(SESSION, 'latest', 200)
            noteSessionOpenFirstRow(SESSION)
        })
        await pass(32)
        await pass(13)
        act(() => { scheduleSessionOpenSettle(SESSION, 200) })

        // Not before the tail stayed current for the grace window.
        await pass(499)
        expect(chip()?.dataset.state).toBe('loading')
        await pass(1)

        expect(chip()?.dataset.state).toBe('settled')
        expect(chip()).toHaveTextContent('First row 277ms · current 290ms · 2 requests · 13KB · 200 rows')

        fireEvent.click(screen.getByRole('button', { expanded: false }))
        const rows = screen.getAllByRole('row')
        expect(rows).toHaveLength(3)
        expect(rows[1]).toHaveTextContent('Session detail')
        expect(rows[1]).toHaveTextContent('+2ms')
        expect(rows[1]).toHaveTextContent('19ms')
        expect(rows[1]).toHaveTextContent('38ms')
        expect(rows[1]).toHaveTextContent('900B')
        expect(rows[2]).toHaveTextContent('Latest page')
        expect(rows[2]).toHaveTextContent('+45ms')
        expect(rows[2]).toHaveTextContent('200ms')
        expect(rows[2]).toHaveTextContent('12KB')
        expect(rows[2]).toHaveTextContent('200')

        fireEvent.click(screen.getByRole('button', { expanded: true }))
        expect(screen.queryByRole('table')).toBeNull()
    })

    it('says when the user left before the tail arrived', async () => {
        serve(
            resource('/api/sessions/open-trace-chip-session/messages?limit=20', 5, 9_005, { transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 }, 0)
        )
        renderChip()
        act(() => { beginSessionOpenTrace(SESSION, true) })
        await pass(100)
        act(() => { noteSessionOpenFirstRow(SESSION) })
        await pass(32)
        act(() => { endSessionOpenTrace(21) })

        expect(chip()?.dataset.state).toBe('left')
        expect(chip()).toHaveTextContent('from cache · First row 132ms · left before the tail arrived')

        fireEvent.click(screen.getByRole('button'))
        const rows = screen.getAllByRole('row')
        expect(rows[1]).toHaveTextContent('Latest page (failed)')
        expect(rows[1]).toHaveTextContent('9.0s')
    })

    it('is not rendered while developer mode is off, and cannot be expanded without a trace', () => {
        getLevel.mockReturnValue(0)
        renderChip()
        act(() => { beginSessionOpenTrace(SESSION, false) })
        expect(chip()).toBeNull()

        cleanup()
        getLevel.mockReturnValue(1)
        renderChip()
        fireEvent.click(screen.getByRole('button'))
        expect(screen.queryByRole('table')).toBeNull()
        expect(chip()).toHaveTextContent('No open recorded for this session yet')
    })

    it('formats sizes and durations for reading', () => {
        expect(formatOpenTraceMs(132)).toBe('132ms')
        expect(formatOpenTraceMs(2_400)).toBe('2.4s')
        expect(formatOpenTraceBytes(900)).toBe('900B')
        expect(formatOpenTraceBytes(2_450)).toBe('2.4KB')
        expect(formatOpenTraceBytes(12_300)).toBe('12KB')
        expect(formatOpenTraceBytes(13_200)).toBe('13KB')
        expect(formatOpenTraceBytes(2 * 1024 * 1024 + 300 * 1024)).toBe('2.3MB')
    })
})

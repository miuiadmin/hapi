// v-render-b verification: the shared scheduler must keep exactly ONE pump chain, even when a debounce
// wave fires while the pump is still draining. fireWave() calls drainOneHighlight() unconditionally, and
// drainOneHighlight() nulls `pumpTimer` on entry, so the handle of the pending pump timer is lost and a
// second chain starts: from then on k blocks are pumped per clamp interval instead of one.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearHighlightCache, __highlightSchedulerForTest as S } from './shiki'

beforeEach(() => { vi.useFakeTimers(); clearHighlightCache() })
afterEach(() => { clearHighlightCache(); vi.useRealTimers() })

const step = (n = 1) => { for (let i = 0; i < n; i += 1) vi.advanceTimersToNextTimer() }

it('keeps a single pump chain when a debounce wave fires while cached blocks are still being pumped', () => {
    const ran: string[] = []
    S.enqueueHighlight(() => { ran.push('a') })
    S.enqueueHighlight(() => { ran.push('b') })
    S.enqueueHighlight(() => { ran.push('c') })
    // An uncached block's debounce (150 ms) comes due in the same task as the pump's first task.
    S.scheduleHighlight(() => { ran.push('d') }, 0)
    expect(S.state()).toEqual({ waveTimer: true, pumpTimer: true, waiting: 1, ready: 3 })
    step()                                  // pump task (a), then the wave's timer task in the same tick
    expect(S.state()).toMatchObject({ waveTimer: false, waiting: 0 })
    // Exactly one pump timer may be pending now (the task for "b"): the wave must not start a 2nd chain.
    expect(vi.getTimerCount()).toBe(1)
    expect(ran).toEqual(['a'])
    step()
    expect(ran).toEqual(['a', 'b'])
    step()
    expect(ran).toEqual(['a', 'b', 'c'])
    step()
    expect(ran).toEqual(['a', 'b', 'c', 'd'])
    step(4)
    expect(vi.getTimerCount()).toBe(0)      // nothing left behind once the queue is empty
    expect(S.state()).toEqual({ waveTimer: false, pumpTimer: false, waiting: 0, ready: 0 })
})

it('does not stack chains when several waves fire during one long pump', () => {
    const ran: number[] = []
    for (let i = 0; i < 12; i += 1) S.enqueueHighlight(() => { ran.push(i) })
    for (let wave = 0; wave < 5; wave += 1) {
        S.scheduleHighlight(() => { ran.push(100 + wave) }, 0)
        step()                              // one pump task, then this wave's timer task
    }
    // Five waves fired during the pump: still exactly one pump chain (one block per task)…
    expect(vi.getTimerCount()).toBe(1)
    expect(S.state()).toMatchObject({ waveTimer: false })
    step(60)
    expect(ran).toHaveLength(17)             // every job ran once
    expect(ran.filter((x) => x < 100)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])   // enqueued jobs keep their order
    expect(ran.filter((x) => x >= 100)).toEqual([100, 101, 102, 103, 104])                  // so do the waves' jobs
    expect(vi.getTimerCount()).toBe(0)
})

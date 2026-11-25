// Research prototype (exp/xb): highlight cache, visible-only highlighting, one block per task.
// The existing hook tests (shiki-hooks.test.tsx) pin the ungated 150ms behaviour and stay untouched.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HighlighterCore } from 'shiki/core'
import { getLanguageHighlighter } from './shiki-loader'
import { HIGHLIGHT_CACHE_CHAR_BUDGET, HIGHLIGHT_CACHE_MAX_ENTRY_CHARS, clearHighlightCache, useShikiHighlightedLines } from './shiki'

vi.mock('./shiki-loader', () => ({ getLanguageHighlighter: vi.fn() }))
const load = vi.mocked(getLanguageHighlighter)
const highlighter = {
    codeToHast: vi.fn((code: string) => ({ type: 'root', children: [{ type: 'text', value: code }] })),
} as unknown as HighlighterCore

type Intersection = (entries: Array<{ isIntersecting: boolean }>) => void
let callback: Intersection | null
let observed: Element | null
let observers: number
let roots: Array<Element | null>
// jsdom has no IntersectionObserver: one the test drives by hand.
function bringIntoView(isIntersecting: boolean) {
    if (!callback || !observed) return
    callback([{ isIntersecting }])
}

beforeEach(() => {
    vi.useFakeTimers()
    clearHighlightCache()
    load.mockReset().mockResolvedValue(highlighter)
    callback = null
    observed = null
    observers = 0
    roots = []
    vi.stubGlobal('IntersectionObserver', class {
        constructor(cb: Intersection, options: { root: Element | null }) { callback = cb; observers += 1; roots.push(options.root) }
        observe(el: Element) { observed = el }
        unobserve() {}
        disconnect() { if (observed) callback = null }
        takeRecords() { return [] }
    })
})
afterEach(() => {
    cleanup()
    clearHighlightCache()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

/** A host ref the way CodeBlock / SyntaxHighlighter pass theirs: the block's own element. */
function hostRef(tag = 'div'): { current: Element | null } {
    return { current: document.createElement(tag) }
}

describe('highlight cache', () => {
    it('does not tokenize the same code twice across mounts', async () => {
        const first = renderHook(() => useShikiHighlightedLines('const a = 1', 'ts'))
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(first.result.current).not.toBeNull()
        expect(load).toHaveBeenCalledTimes(1)
        first.unmount()

        const second = renderHook(() => useShikiHighlightedLines('const a = 1', 'ts'))
        // Cache hit: applied in the next pump task, no debounce, no loader call.
        await act(() => vi.advanceTimersByTimeAsync(1))
        expect(second.result.current).not.toBeNull()
        expect(load).toHaveBeenCalledTimes(1)
    })

    it('keys by language and by code, and keeps the two renderers apart', async () => {
        const lines = renderHook(() => useShikiHighlightedLines('x = 1', 'python'))
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(lines.result.current).toEqual([expect.anything()])
        lines.unmount()

        // Same text, another language: a miss.
        const otherLang = renderHook(() => useShikiHighlightedLines('x = 1', 'rust'))
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(load).toHaveBeenCalledTimes(2)
        otherLang.unmount()

        // Another text: a miss.
        const otherCode = renderHook(() => useShikiHighlightedLines('x = 2', 'python'))
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(load).toHaveBeenCalledTimes(3)
    })

    it('evicts the least recently used entry past 200', async () => {
        const mount = async (code: string) => {
            const hook = renderHook(() => useShikiHighlightedLines(code, 'python'))
            await act(() => vi.advanceTimersByTimeAsync(150))
            hook.unmount()
        }
        for (let i = 0; i < 200; i += 1) await mount(`code-${i}`)
        expect(load).toHaveBeenCalledTimes(200)
        // Touch the oldest so it stays; the second-oldest becomes the eviction victim.
        await mount('code-0')
        expect(load).toHaveBeenCalledTimes(200)
        await mount('code-200') // 201 distinct live entries → evicts code-1
        expect(load).toHaveBeenCalledTimes(201)

        await mount('code-0') // still cached (was touched)
        expect(load).toHaveBeenCalledTimes(201)
        await mount('code-1') // evicted → tokenized again
        expect(load).toHaveBeenCalledTimes(202)
        await mount('code-199') // still cached
        expect(load).toHaveBeenCalledTimes(202)
    })
})

describe('visible-only highlighting', () => {
    it('does not start until the block is near the viewport, then debounces 150ms', async () => {
        const host = hostRef()
        const { result } = renderHook(() => useShikiHighlightedLines('const a = 1', 'ts', host))
        expect(observers).toBe(1)
        expect(observed).toBe(host.current)
        await act(() => vi.advanceTimersByTimeAsync(2000))
        expect(load).not.toHaveBeenCalled()
        expect(result.current).toBeNull()

        bringIntoView(true)
        await act(() => vi.advanceTimersByTimeAsync(149))
        expect(load).not.toHaveBeenCalled()
        await act(() => vi.advanceTimersByTimeAsync(1))
        expect(load).toHaveBeenCalledTimes(1)
        expect(load).toHaveBeenCalledWith('typescript')
        expect(result.current).not.toBeNull()
    })

    it('cancels the debounce when the block leaves and restarts it when it is back', async () => {
        const { result } = renderHook(() => useShikiHighlightedLines('const a = 1', 'ts', hostRef()))
        bringIntoView(true)
        await act(() => vi.advanceTimersByTimeAsync(100))
        bringIntoView(false)
        await act(() => vi.advanceTimersByTimeAsync(500))
        expect(load).not.toHaveBeenCalled()
        expect(result.current).toBeNull()

        bringIntoView(true)
        await act(() => vi.advanceTimersByTimeAsync(100))
        expect(load).not.toHaveBeenCalled()
        await act(() => vi.advanceTimersByTimeAsync(50))
        expect(load).toHaveBeenCalledTimes(1)
    })

    it('applies a cached result as soon as the block is visible, without the debounce', async () => {
        const warm = renderHook(() => useShikiHighlightedLines('const a = 1', 'ts'))
        await act(() => vi.advanceTimersByTimeAsync(150))
        warm.unmount()
        expect(load).toHaveBeenCalledTimes(1)

        const { result } = renderHook(() => useShikiHighlightedLines('const a = 1', 'ts', hostRef()))
        await act(() => vi.advanceTimersByTimeAsync(1000))
        expect(result.current).toBeNull() // off-screen: stays plain text, cache or not
        bringIntoView(true)
        await act(() => vi.advanceTimersByTimeAsync(1)) // one pump task
        expect(result.current).not.toBeNull()
        expect(load).toHaveBeenCalledTimes(1)
    })

    it('uses the nearest thread viewport as the observation root', () => {
        const thread = document.createElement('div')
        thread.setAttribute('data-hapi-thread-viewport', 'true')
        const block = document.createElement('div')
        thread.appendChild(block)
        document.body.appendChild(thread)
        renderHook(() => useShikiHighlightedLines('const a = 1', 'ts', { current: block }))
        expect(roots).toEqual([thread])
        renderHook(() => useShikiHighlightedLines('const b = 2', 'ts', hostRef()))
        expect(roots[1]).toBeNull() // no thread around: the document viewport
    })

    it('keeps highlighting new text on an already visible block without waiting for the observer', async () => {
        const { result, rerender } = renderHook(({ code }) => useShikiHighlightedLines(code, 'ts', hostRef()), {
            initialProps: { code: 'const a = 1' },
        })
        bringIntoView(true)
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(result.current).not.toBeNull()
        const before = load.mock.calls.length

        // Streaming: new text on the same, still visible block. The 150ms window starts at once
        // (no wait for the fresh observer's first callback), and the old tokens are not shown.
        rerender({ code: 'const a = 1\nconst b = 2' })
        expect(result.current).toBeNull()
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(load).toHaveBeenCalledTimes(before + 1)
        expect(result.current).not.toBeNull() // tokens for the new text (the stub emits one line)
    })

    it('still stops that optimistic start when the fresh observer reports the block off-screen', async () => {
        const { result, rerender } = renderHook(({ code }) => useShikiHighlightedLines(code, 'ts', hostRef()), {
            initialProps: { code: 'const a = 1' },
        })
        bringIntoView(true)
        await act(() => vi.advanceTimersByTimeAsync(150))
        expect(result.current).not.toBeNull()
        const before = load.mock.calls.length

        rerender({ code: 'const a = 1\nconst b = 2' })
        bringIntoView(false) // the user scrolled away in the same frame the text changed
        await act(() => vi.advanceTimersByTimeAsync(500))
        expect(load).toHaveBeenCalledTimes(before)
        expect(result.current).toBeNull()
    })
})

describe('one block per task', () => {
    it('runs the first due block in the timer task and each further one in its own task', async () => {
        const blocks = ['a', 'b', 'c'].map((code) => renderHook(() => useShikiHighlightedLines(code, 'python')))
        await act(() => vi.advanceTimersByTimeAsync(149))
        expect(load).not.toHaveBeenCalled()
        await act(() => vi.advanceTimersByTimeAsync(1))
        expect(load).toHaveBeenCalledTimes(1) // first block, same task as the timer
        await act(() => vi.advanceTimersByTimeAsync(1))
        expect(load).toHaveBeenCalledTimes(2) // second block, next task
        await act(() => vi.advanceTimersByTimeAsync(1))
        expect(load).toHaveBeenCalledTimes(3)
        for (const block of blocks) expect(block.result.current).not.toBeNull()
        blocks.forEach((block) => block.unmount())
    })

    it('drops a block that unmounted before its window elapsed', async () => {
        const gone = renderHook(() => useShikiHighlightedLines('gone', 'python'))
        await act(() => vi.advanceTimersByTimeAsync(100))
        gone.unmount()
        await act(() => vi.advanceTimersByTimeAsync(500))
        expect(load).not.toHaveBeenCalled()
    })
})

describe('verify-fix (v-render-b): what the cache keeps', () => {
    async function mount(code: string, lang = 'python', host?: { current: Element | null }) {
        const hook = renderHook(() => useShikiHighlightedLines(code, lang, host))
        bringIntoView(true)
        await act(() => vi.advanceTimersByTimeAsync(150))
        return hook
    }

    it(`VRB-02: a block over ${150_000} characters of code is not cached`, async () => {
        const huge = 'x'.repeat(HIGHLIGHT_CACHE_MAX_ENTRY_CHARS + 1)
        await mount(huge)
        expect(load).toHaveBeenCalledTimes(1)
        await mount(huge)
        expect(load).toHaveBeenCalledTimes(2)
    })

    it('VRB-02: the cache is bounded in code characters — past the budget the least recently used block goes', async () => {
        const size = 100_000
        const blocks = Math.ceil(HIGHLIGHT_CACHE_CHAR_BUDGET / size) + 1
        const codes = Array.from({ length: blocks }, (_, index) => `${index}`.padEnd(4, '.') + 'y'.repeat(size - 4))
        for (const code of codes) await mount(code)
        expect(load).toHaveBeenCalledTimes(blocks)
        // `blocks × size` characters is over the budget: the first block was evicted, the last is still there.
        await mount(codes[0]!)
        expect(load).toHaveBeenCalledTimes(blocks + 1)
        await mount(codes[codes.length - 1]!)
        expect(load).toHaveBeenCalledTimes(blocks + 1)
    })
})

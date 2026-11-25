import { getLanguageHighlighter } from './shiki-loader'
import type { HighlighterCore } from 'shiki/core'
import type { Root, RootContent } from 'hast'
import { useState, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

export const SHIKI_THEMES = {
    light: 'github-light',
    dark: 'github-dark',
} as const

// Alias common code fence language names to canonical names
export const langAlias: Record<string, string> = {
    sh: 'shellscript',
    bash: 'shellscript',
    zsh: 'shellscript',
    shell: 'shellscript',
    ps1: 'powershell',
    ps: 'powershell',
    properties: 'ini',
    kts: 'kotlin',
    'c#': 'csharp',
    dockerfile: 'docker',
    js: 'javascript',
    ts: 'typescript',
    mjs: 'javascript',
    cjs: 'javascript',
    mts: 'typescript',
    cts: 'typescript',
    yml: 'yaml',
    md: 'markdown',
    htm: 'html',
    pgsql: 'sql',
    mysql: 'sql',
    postgres: 'sql',
    gql: 'graphql',
    py: 'python',
    rs: 'rust',
    kt: 'kotlin',
    cs: 'csharp',
    makefile: 'make',
}

function resolveLanguage(lang: string | undefined): string {
    if (!lang) return 'text'
    const cleaned = lang.toLowerCase().trim()
    const lower = cleaned.startsWith('language-') ? cleaned.slice('language-'.length) : cleaned
    if (lower === 'text' || lower === 'plaintext' || lower === 'txt') return 'text'
    return langAlias[lower] ?? lower
}

/**
 * Normalize code the way the line renderer counts lines: a single trailing
 * newline is dropped so `"a\n"` is one line, not one line plus an empty
 * one. Shared by the highlighted and plain-text-fallback paths so both
 * produce the same number of lines.
 */
function stripTrailingNewline(code: string): string {
    return code.endsWith('\n') ? code.slice(0, -1) : code
}

/**
 * Split raw code into logical lines for the plain-text fallback (when
 * highlighting is unavailable). Mirrors the normalization applied before
 * highlighting so line numbers line up on both paths.
 */
export function splitCodeLines(code: string): string[] {
    return stripTrailingNewline(code).split('\n')
}

/**
 * Split an inline shiki hast tree into per-logical-line child arrays.
 *
 * With `structure: 'inline'`, shiki emits a flat list of token `<span>`s
 * with `<br>` elements marking line breaks (verified against the bundled
 * shiki version). Grouping on those `<br>` boundaries yields one child
 * array per source line, so each line can be rendered in its own grid row
 * with an aligned line number — even when the line wraps.
 *
 * The number of returned groups always equals `splitCodeLines(code).length`:
 * N lines have N-1 `<br>`s between them, so N-1 splits produce N groups
 * (including interior empty lines).
 */
export function splitHastLines(hast: Root): RootContent[][] {
    const lines: RootContent[][] = []
    let current: RootContent[] = []
    for (const child of hast.children) {
        if (child.type === 'element' && child.tagName === 'br') {
            lines.push(current)
            current = []
        } else {
            current.push(child)
        }
    }
    lines.push(current)
    return lines
}

function highlightToLineNodes(highlighter: HighlighterCore, code: string, lang: string): ReactNode[] {
    const hast = highlighter.codeToHast(stripTrailingNewline(code), {
        lang,
        themes: SHIKI_THEMES,
        defaultColor: false,
        structure: 'inline',
    })

    return splitHastLines(hast as Root).map((children) => {
        const lineRoot: Root = { type: 'root', children }
        return toJsxRuntime(lineRoot, { jsx, jsxs, Fragment }) as ReactNode
    })
}

function highlightToNode(highlighter: HighlighterCore, code: string, lang: string): ReactNode {
    const hast = highlighter.codeToHast(code, {
        lang,
        themes: SHIKI_THEMES,
        defaultColor: false,
        structure: 'inline',
    })
    return toJsxRuntime(hast, { jsx, jsxs, Fragment })
}

// ---------------------------------------------------------------------------
// Research prototype (exp/xb): highlight result cache + visible-only highlighting + one block per task.
// Everything below only changes *when* a block is highlighted; what gets rendered is the same.
// ---------------------------------------------------------------------------

/** Cached blocks per renderer. One entry is a React node tree (a few hundred spans), so 200 ≈ a few MB. */
const HIGHLIGHT_CACHE_LIMIT = 200

/** LRU keyed by `lang + '\0' + code`; one instance per render function (they return different shapes). */
class HighlightCache {
    private readonly entries = new Map<string, unknown>()

    get(key: string): unknown {
        const value = this.entries.get(key)
        if (value === undefined) return undefined
        // Re-insert so the key becomes the most recently used.
        this.entries.delete(key)
        this.entries.set(key, value)
        return value
    }

    set(key: string, value: unknown): void {
        this.entries.delete(key)
        this.entries.set(key, value)
        while (this.entries.size > HIGHLIGHT_CACHE_LIMIT) {
            const oldest = this.entries.keys().next().value
            if (oldest === undefined) break
            this.entries.delete(oldest)
        }
    }

    clear(): void {
        this.entries.clear()
    }
}
// Module-level (survives every mount/unmount, i.e. every session open) and keyed by the two
// module-level render functions, so a plain Map is fine.
const highlightCaches = new Map<Function, HighlightCache>()
function cacheFor(render: Function): HighlightCache {
    let cache = highlightCaches.get(render)
    if (!cache) {
        cache = new HighlightCache()
        highlightCaches.set(render, cache)
    }
    return cache
}
const highlightCacheKey = (lang: string, code: string): string => lang + '\0' + code

/**
 * Shared scheduler, one block per macrotask.
 *
 * `scheduleHighlight(run, 150)` is the per-block debounce: a block registers a deadline 150ms
 * after it became visible, and one shared timer is armed for the earliest deadline. When it
 * fires, every job whose deadline has passed is run in order — the first one right there in the
 * timer task (a lone block keeps the original 150ms timing), each following one in its own
 * `setTimeout(0)` task, so the browser can fit a frame or a scroll between two blocks instead
 * of running every continuation back-to-back in one long task.
 */
type HighlightJob = { due: number; run: () => void }
/** Debounce windows still running. */
let waitingHighlights: HighlightJob[] = []
let waveTimer: ReturnType<typeof setTimeout> | null = null
/** Jobs whose window has elapsed; the pump runs one per task. */
const readyHighlights: HighlightJob[] = []
let pumpTimer: ReturnType<typeof setTimeout> | null = null

function syncWaveTimer(): void {
    if (waveTimer !== null) {
        clearTimeout(waveTimer)
        waveTimer = null
    }
    if (waitingHighlights.length === 0) return
    let next = Infinity
    for (const job of waitingHighlights) if (job.due < next) next = job.due
    waveTimer = setTimeout(fireWave, Math.max(0, next - Date.now()))
}

function fireWave(): void {
    waveTimer = null
    const now = Date.now()
    const stillWaiting: HighlightJob[] = []
    for (const job of waitingHighlights) {
        if (job.due <= now) readyHighlights.push(job)
        else stillWaiting.push(job)
    }
    waitingHighlights = stillWaiting
    syncWaveTimer()
    // verify-fix (v-render-b): only kick the pump when it is idle — drainOneHighlight() nulls the pending
    // pump timer's handle on entry, so calling it while a pump task is pending would start a second chain.
    if (pumpTimer === null) drainOneHighlight()
}

function drainOneHighlight(): void {
    pumpTimer = null
    const job = readyHighlights.shift()
    if (job) job.run()
    if (readyHighlights.length > 0) pumpTimer = setTimeout(drainOneHighlight, 0)
}

/** Run `run` after `delayMs`, in a task of its own. Returns an idempotent cancel. */
function scheduleHighlight(run: () => void, delayMs: number): () => void {
    const job: HighlightJob = { due: Date.now() + delayMs, run }
    waitingHighlights.push(job)
    syncWaveTimer()
    return () => {
        const index = waitingHighlights.indexOf(job)
        if (index !== -1) {
            waitingHighlights.splice(index, 1)
            syncWaveTimer()
        }
    }
}

/** Run `run` in the next pump task: never in the caller's React effect or observer callback. */
function enqueueHighlight(run: () => void): void {
    readyHighlights.push({ due: 0, run })
    if (pumpTimer === null) pumpTimer = setTimeout(drainOneHighlight, 0)
}

/** Test seam (v-render-b verification only): the scheduler's pieces, unmodified. */
export const __highlightSchedulerForTest = {
    scheduleHighlight,
    enqueueHighlight,
    fireWave,
    state: () => ({ waveTimer: waveTimer !== null, pumpTimer: pumpTimer !== null, waiting: waitingHighlights.length, ready: readyHighlights.length }),
}

/** Test hook: forget every cached block and drop everything still scheduled. */
export function clearHighlightCache(): void {
    for (const cache of highlightCaches.values()) cache.clear()
    waitingHighlights = []
    readyHighlights.length = 0
    if (waveTimer !== null) {
        clearTimeout(waveTimer)
        waveTimer = null
    }
    if (pumpTimer !== null) {
        clearTimeout(pumpTimer)
        pumpTimer = null
    }
}

/** How far outside the thread viewport a block still counts as visible (one screen, like the spec says). */
const VISIBILITY_ROOT_MARGIN = '100% 0px'
/** Attribute on the thread's scroll container (HappyThread.tsx); the nearest one is the IO root. */
const THREAD_VIEWPORT_SELECTOR = '[data-hapi-thread-viewport]'

function useHighlightedCode<T>(
    code: string,
    language: string | undefined,
    render: (highlighter: HighlighterCore, code: string, lang: string) => T,
    host?: RefObject<Element | null>
): T | null {
    const lang = useMemo(() => resolveLanguage(language), [language])
    const [result, setResult] = useState<{ code: string; lang: string; value: T } | null>(null)
    // Without a host element there is nothing to observe: the block counts as visible from the start.
    const visibleRef = useRef(host === undefined)

    useEffect(() => {
        let cancelled = false
        let pending: (() => void) | null = null
        let observer: IntersectionObserver | null = null
        let started = false
        const key = highlightCacheKey(lang, code)
        const cache = cacheFor(render)

        // `apply` only ever runs from a pump task (never from this effect body), so flushing
        // synchronously is legal there and keeps each block's DOM work inside its own task.
        const apply = (value: T) => {
            flushSync(() => {
                setResult({ code, lang, value })
            })
        }

        async function highlight() {
            try {
                const highlighter = await getLanguageHighlighter(lang)
                if (cancelled || !highlighter) return
                const value = render(highlighter, code, lang)
                if (cancelled) return
                cache.set(key, value)
                apply(value)
            } catch {
                // Offline/chunk/tokenization failures retain readable plain text.
                if (!cancelled) setResult(null)
            }
        }

        // Called once the block is (known to be) visible. Idempotent until `stop()`.
        const start = () => {
            if (started || cancelled) return
            started = true
            const cached = cache.get(key) as T | undefined
            if (cached !== undefined) {
                // Already tokenized: no debounce needed, the text is final by construction.
                enqueueHighlight(() => {
                    if (cancelled || !started) return
                    apply(cached)
                })
                return
            }
            // Preserve the streaming debounce, now counted from the moment the block became
            // visible; do not display tokens for an older input.
            pending = scheduleHighlight(() => {
                pending = null
                highlight()
            }, 150)
        }
        const stop = () => {
            started = false
            if (pending) {
                pending()
                pending = null
            }
        }

        const element = host?.current ?? null
        if (element && typeof IntersectionObserver !== 'undefined') {
            observer = new IntersectionObserver((entries) => {
                if (cancelled) return
                const entry = entries[entries.length - 1]
                if (entry.isIntersecting) {
                    visibleRef.current = true
                    start()
                } else {
                    visibleRef.current = false
                    stop()
                }
            }, { root: element.closest(THREAD_VIEWPORT_SELECTOR), rootMargin: VISIBILITY_ROOT_MARGIN })
            observer.observe(element)
            // Re-run with new text (streaming) on a block we have already seen visible: do not wait
            // for the observer's first callback (a frame) before starting the debounce. A "not
            // intersecting" first callback still stops it.
            if (visibleRef.current) start()
        } else {
            visibleRef.current = true
            start()
        }
        return () => {
            cancelled = true
            stop()
            observer?.disconnect()
        }
    }, [code, lang, render])

    return result?.code === code && result.lang === lang ? result.value : null
}

/** Highlight supported fences on demand; null means use the plain-text fallback. */
export function useShikiHighlighter(code: string, language: string | undefined): ReactNode | null {
    return useHighlightedCode(code, language, highlightToNode)
}

/**
 * Highlight one ReactNode per logical line, preserving line numbers and wrapping.
 * Pass `host` (the block's own DOM element) to only highlight once it is near the thread viewport.
 */
export function useShikiHighlightedLines(
    code: string,
    language: string | undefined,
    host?: RefObject<Element | null>
): ReactNode[] | null {
    return useHighlightedCode(code, language, highlightToLineNodes, host)
}

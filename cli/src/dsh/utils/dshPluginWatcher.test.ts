import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { DSH_PLUGIN_WATCH_FILES, DshPluginWatcher, resolveDshProfileDir } from './dshPluginWatcher'

const DIR = '/home/tester/.dsh/profiles/acp'

/** Injectable mtime store: absent path → null, exactly like a failed stat. */
function fakeStat() {
    const mtimes = new Map<string, number>()
    return {
        stat: vi.fn(async (path: string): Promise<number | null> => mtimes.get(path) ?? null),
        set: (file: string, mtimeMs: number | undefined) => {
            if (mtimeMs === undefined) mtimes.delete(join(DIR, file))
            else mtimes.set(join(DIR, file), mtimeMs)
        }
    }
}

function makeWatcher(
    stat: ReturnType<typeof fakeStat>,
    onTrigger: () => void,
    opts: { pollIntervalMs?: number; debounceMs?: number } = {}
) {
    return new DshPluginWatcher({
        onTrigger,
        profileDir: DIR,
        pollIntervalMs: opts.pollIntervalMs ?? 1000,
        debounceMs: opts.debounceMs ?? 2000,
        statFile: stat.stat
    })
}

describe('resolveDshProfileDir', () => {
    it('defaults to the acp profile under the dsh home', () => {
        expect(resolveDshProfileDir({}, '/home/tester')).toBe(DIR)
    })

    it('prefers an explicit HAPI_DSH_PROFILE_DIR', () => {
        expect(resolveDshProfileDir({ HAPI_DSH_PROFILE_DIR: ' /custom/profile ' }, '/home/tester')).toBe('/custom/profile')
    })
})

describe('DshPluginWatcher', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('tracks the plugin manifest, patch overlay, and lockfile by default', () => {
        expect([...DSH_PLUGIN_WATCH_FILES]).toEqual(['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'])
    })

    it('does not fire for a profile that existed before the watch started', async () => {
        const stat = fakeStat()
        stat.set('package.json', 1)
        const onTrigger = vi.fn()
        makeWatcher(stat, onTrigger).start()

        await vi.advanceTimersByTimeAsync(10_000)
        expect(onTrigger).not.toHaveBeenCalled()
    })

    it('does not fire while the directory has no tracked files at all', async () => {
        const stat = fakeStat()
        const onTrigger = vi.fn()
        makeWatcher(stat, onTrigger).start()

        await vi.advanceTimersByTimeAsync(10_000)
        expect(onTrigger).not.toHaveBeenCalled()
    })

    it('fires once after a tracked file changes and the directory settles', async () => {
        const stat = fakeStat()
        stat.set('package.json', 1)
        const onTrigger = vi.fn()
        makeWatcher(stat, onTrigger).start()
        await vi.advanceTimersByTimeAsync(1000) // baseline poll

        stat.set('pnpm-lock.yaml', 42) // plugin install rewrote the lockfile
        await vi.advanceTimersByTimeAsync(1000 + 2000)

        expect(onTrigger).toHaveBeenCalledTimes(1)
    })

    it('fires when a tracked file appears or disappears', async () => {
        const stat = fakeStat()
        const onTrigger = vi.fn()
        makeWatcher(stat, onTrigger).start()
        await vi.advanceTimersByTimeAsync(1000)

        stat.set('cordis.patch.yml', 7) // missing → present
        await vi.advanceTimersByTimeAsync(3000)
        expect(onTrigger).toHaveBeenCalledTimes(1)

        stat.set('cordis.patch.yml', undefined) // present → missing
        await vi.advanceTimersByTimeAsync(3000)
        expect(onTrigger).toHaveBeenCalledTimes(2)
    })

    it('debounces a burst of rewrites into a single trigger', async () => {
        const stat = fakeStat()
        stat.set('package.json', 1)
        const onTrigger = vi.fn()
        makeWatcher(stat, onTrigger).start()
        await vi.advanceTimersByTimeAsync(1000)

        // Three rewrites one poll apart: each restarts the quiet window.
        stat.set('package.json', 2)
        await vi.advanceTimersByTimeAsync(1000)
        stat.set('package.json', 3)
        await vi.advanceTimersByTimeAsync(1000)
        stat.set('pnpm-lock.yaml', 9)
        await vi.advanceTimersByTimeAsync(1500) // inside the restarted window
        expect(onTrigger).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(2000) // quiet for a full window
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })

    it('never refires for a standing difference (no reload loop)', async () => {
        const stat = fakeStat()
        stat.set('package.json', 1)
        const onTrigger = vi.fn()
        makeWatcher(stat, onTrigger).start()
        await vi.advanceTimersByTimeAsync(1000)

        stat.set('package.json', 2)
        await vi.advanceTimersByTimeAsync(3000)
        expect(onTrigger).toHaveBeenCalledTimes(1)

        // The changed file stays changed: transition semantics mean no
        // further trigger, no matter how long the polls keep running.
        await vi.advanceTimersByTimeAsync(60_000)
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })

    it('stops firing after stop()', async () => {
        const stat = fakeStat()
        stat.set('package.json', 1)
        const onTrigger = vi.fn()
        const watcher = makeWatcher(stat, onTrigger)
        watcher.start()
        await vi.advanceTimersByTimeAsync(1000)

        stat.set('package.json', 2)
        await vi.advanceTimersByTimeAsync(1000) // transition seen, debounce armed
        watcher.stop()
        await vi.advanceTimersByTimeAsync(10_000)

        expect(onTrigger).not.toHaveBeenCalled()
    })
})

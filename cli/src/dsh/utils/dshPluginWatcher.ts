import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Files inside the DSH profile directory whose mtimes move when dsh's
 * plugin_manager installs or removes bundles: the plugin manifest
 * (package.json), the cordis patch overlay the manager rewrites, and the
 * pnpm lockfile. Only transitions of these three count — other churn in the
 * directory (node_modules writes, logs) stays invisible, and a file that is
 * merely ABSENT from start to finish never fires.
 */
export const DSH_PLUGIN_WATCH_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'] as const

/**
 * Resolve the DSH profile directory whose mutations mean "a plugin was
 * installed/removed". Defaults to `~/.dsh/profiles/acp` (the profile the
 * official CLI boots via `--profile acp`); `HAPI_DSH_PROFILE_DIR` overrides
 * it for custom HAPI_DSH_ACP_COMMAND wrappers with their own layout.
 */
export function resolveDshProfileDir(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string {
    const override = env.HAPI_DSH_PROFILE_DIR?.trim()
    if (override) return override
    return join(home, '.dsh', 'profiles', 'acp')
}

/** mtime (ms) of each tracked file; null = missing (stat failure or absent). */
export type DshPluginSnapshot = Record<string, number | null>

async function statMtime(path: string): Promise<number | null> {
    try {
        return (await stat(path)).mtimeMs
    } catch {
        return null
    }
}

function snapshotsDiffer(a: DshPluginSnapshot, b: DshPluginSnapshot): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
        if (a[key] !== b[key]) return true
    }
    return false
}

export type DshPluginWatcherOptions = {
    /** Fired once after tracked files stopped moving for `debounceMs`. */
    onTrigger: () => void
    /** Directory to watch (default: resolveDshProfileDir()). */
    profileDir?: string
    /** Tracked file names inside the directory (default: DSH_PLUGIN_WATCH_FILES). */
    files?: readonly string[]
    /** Poll cadence in ms (default 1000). */
    pollIntervalMs?: number
    /** Quiet window after the last transition before firing (default 2000). */
    debounceMs?: number
    /** Injectable mtime probe for tests (default: fs stat, null on error). */
    statFile?: (path: string) => Promise<number | null>
}

/**
 * Polling watcher over the DSH profile directory that turns "the plugin
 * manifest/patch/lockfile just moved" into a single debounced trigger.
 *
 * Firing is TRANSITION-based: a poll only counts when the snapshot differs
 * from the previous poll's snapshot, and every trigger consumes the change
 * (the new snapshot becomes the baseline). A standing difference therefore
 * never re-fires — which is the no-loop guarantee the plugin reload needs:
 * respawning the dsh child does not touch these files, and even if the
 * rebooted child did rewrite one once, that single transition fires at most
 * once instead of starting a cycle.
 *
 * Polling (rather than fs.watch) keeps the watcher portable across network
 * homes and trivially testable with an injected stat function.
 */
export class DshPluginWatcher {
    private readonly dir: string
    private readonly files: readonly string[]
    private readonly pollIntervalMs: number
    private readonly debounceMs: number
    private readonly statFile: (path: string) => Promise<number | null>
    private readonly onTrigger: () => void

    private last: DshPluginSnapshot = {}
    private dirty = false
    /** False until the first poll lands: that poll only primes the baseline. */
    private primed = false
    private pollTimer: ReturnType<typeof setInterval> | null = null
    private debounceTimer: ReturnType<typeof setTimeout> | null = null
    private pollInFlight = false

    constructor(options: DshPluginWatcherOptions) {
        this.onTrigger = options.onTrigger
        this.dir = options.profileDir ?? resolveDshProfileDir()
        this.files = options.files ?? DSH_PLUGIN_WATCH_FILES
        this.pollIntervalMs = options.pollIntervalMs ?? 1000
        this.debounceMs = options.debounceMs ?? 2000
        this.statFile = options.statFile ?? statMtime
    }

    /** Begin polling; the first poll only establishes the baseline. */
    start(): void {
        if (this.pollTimer) return
        this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs)
        void this.pollOnce()
    }

    stop(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer)
            this.pollTimer = null
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = null
        }
        this.dirty = false
        // A later start() re-primes against whatever is on disk then, so a
        // change that landed while stopped never replays as a trigger.
        this.primed = false
        this.last = {}
    }

    private async pollOnce(): Promise<void> {
        // Never overlap polls: a slow stat under a wedged home must not queue
        // up behind itself; the next interval simply skips.
        if (this.pollInFlight) return
        this.pollInFlight = true
        try {
            const next: DshPluginSnapshot = {}
            for (const file of this.files) {
                next[file] = await this.statFile(join(this.dir, file))
            }
            if (!this.primed) {
                // The first poll is the baseline: pre-existing files must not
                // read as an install the moment the session starts.
                this.primed = true
                this.last = next
                return
            }
            if (!snapshotsDiffer(this.last, next)) return
            this.last = next
            this.dirty = true
            // Restart the quiet window on every transition: an install that
            // rewrites manifest and lockfile a second apart settles into one
            // trigger once the directory goes quiet.
            if (this.debounceTimer) clearTimeout(this.debounceTimer)
            this.debounceTimer = setTimeout(() => {
                this.debounceTimer = null
                if (!this.dirty) return
                this.dirty = false
                this.onTrigger()
            }, this.debounceMs)
        } finally {
            this.pollInFlight = false
        }
    }
}

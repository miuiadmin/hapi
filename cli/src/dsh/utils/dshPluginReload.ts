import type { AgentMessage } from '@/agent/types'
import { DshPluginWatcher, resolveDshProfileDir, type DshPluginWatcherOptions } from './dshPluginWatcher'
import { DshPluginToolTracker } from './dshPluginTools'

/** What the coordinator needs from the DSH launcher. Kept as callbacks so
 * every gate reads the launcher's live state without binding the util to the
 * launcher class. */
export type DshPluginReloadHost = {
    /** Re-run the backend on a fresh dsh child, resuming the same durable
     * dshSessionId (the launcher's respawnBackend). */
    respawn: () => Promise<void>
    /** Show one status line to the user (session event + local log). */
    notify: (message: string) => void
    /** True while a prompt is running on the backend — reloads are deferred
     * until the turn settles so an install mid-turn never kills it. */
    isPromptActive: () => boolean
    /** True while the launcher is already rebuilding the backend. */
    isRespawning: () => boolean
    /** False when the session is exiting or has no live backend. */
    isAlive: () => boolean
}

export type DshPluginReloadOptions = {
    /** Minimum spacing between reload respawns (default 10s). A trigger that
     * lands inside the window is dropped — see the class doc. */
    reloadCooldownMs?: number
    /** Passed through to the directory watcher (tests inject stat/intervals). */
    watcher?: Omit<DshPluginWatcherOptions, 'onTrigger'>
    /** Clock injectable for tests (default Date.now). */
    now?: () => number
}

/**
 * "Install-and-use" for DSH plugins: reload the dsh child once the installed
 * plugin set changes, because dsh reads its profile only at process spawn.
 *
 * Two independent signals funnel into one deferred reload:
 *  1. the profile directory watcher (package.json / cordis.patch.yml /
 *     pnpm-lock.yaml mtimes, debounced — see DshPluginWatcher), and
 *  2. a successful plugin_manager tool result with a mutating action (see
 *     DshPluginToolTracker) — double insurance, since either alone can miss
 *     (the tool result fires before every file settles; the watcher misses
 *     installs that rewrite no tracked file).
 *
 * Loop safety: respawning dsh does not write the tracked files, and the
 * watcher only fires on transitions (a standing difference never re-fires),
 * so a reload cannot re-trigger itself. The cooldown is the belt on top: if
 * the rebooted child DID rewrite a file once at boot, that trigger lands
 * inside the window and is dropped — at most one dropped trigger per boot,
 * never a cycle. The cost of dropping is that a genuine install landing
 * within the cooldown of a finished reload waits for the next signal; an
 * acceptable trade against a respawn loop.
 *
 * A reload never interrupts a running turn: mid-turn signals only mark the
 * reload pending, and the launcher settles it after the turn completes (an
 * idle-time signal settles immediately).
 */
export class DshPluginReloadCoordinator {
    private readonly host: DshPluginReloadHost
    private readonly reloadCooldownMs: number
    private readonly now: () => number
    private readonly tools = new DshPluginToolTracker()
    private watcher: DshPluginWatcher | null = null
    private pending = false
    private settling = false
    private lastReloadAt = -Infinity

    constructor(host: DshPluginReloadHost, options: DshPluginReloadOptions = {}) {
        this.host = host
        this.reloadCooldownMs = options.reloadCooldownMs ?? 10_000
        this.now = options.now ?? Date.now
        this.watcher = new DshPluginWatcher({
            ...(options.watcher ?? {}),
            profileDir: options.watcher?.profileDir ?? resolveDshProfileDir(),
            onTrigger: () => this.requestReload()
        })
    }

    start(): void {
        this.watcher?.start()
    }

    stop(): void {
        this.watcher?.stop()
        this.watcher = null
        this.tools.reset()
        this.pending = false
    }

    /** Feed every agent message from the backend stream; a successful
     * mutating plugin_manager result requests a reload. */
    observeAgentMessage(message: AgentMessage): void {
        if (this.tools.observe(message)) {
            this.requestReload()
        }
    }

    private requestReload(): void {
        this.pending = true
        // Fire-and-forget: an idle-time signal reloads immediately; a
        // mid-prompt signal is a cheap no-op here and settles after the turn.
        // The catch mirrors armModelsReadiness: respawn failures are already
        // surfaced through notify inside settle, so the floating promise must
        // never surface an unhandled rejection on top.
        this.settle().catch(() => {})
    }

    /** Run a pending reload when every gate is open. Safe to call at any
     * time; concurrent calls collapse into the running one. */
    async settle(): Promise<void> {
        if (this.settling) return
        if (!this.pending) return
        if (!this.host.isAlive() || this.host.isPromptActive() || this.host.isRespawning()) return
        this.settling = true
        try {
            if (this.now() - this.lastReloadAt < this.reloadCooldownMs) {
                // Inside the post-reload cooldown: drop the signal (see the
                // class doc for why dropping beats queueing).
                this.pending = false
                return
            }
            this.pending = false
            this.lastReloadAt = this.now()
            this.host.notify('DSH plugins changed; reloading the session…')
            try {
                await this.host.respawn()
                // The respawn swapped the dsh child: results still arriving
                // for the old process's calls must not read as new installs.
                this.tools.reset()
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                this.host.notify(`DSH plugin reload failed: ${message}`)
            }
        } finally {
            this.settling = false
        }
    }
}

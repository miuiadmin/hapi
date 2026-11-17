import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { AgentMessage } from '@/agent/types'
import { DshPluginReloadCoordinator } from './dshPluginReload'

const DIR = '/home/tester/.dsh/profiles/acp'

/** Mutable host state the coordinator's gates read. */
function makeHost(overrides: Partial<{
    respawn: () => Promise<void>
    promptActive: boolean
    respawning: boolean
    alive: boolean
}> = {}) {
    const state = {
        promptActive: overrides.promptActive ?? false,
        respawning: overrides.respawning ?? false,
        alive: overrides.alive ?? true
    }
    return {
        state,
        respawn: overrides.respawn ?? vi.fn(async () => {}),
        notify: vi.fn(),
        isPromptActive: () => state.promptActive,
        isRespawning: () => state.respawning,
        isAlive: () => state.alive
    }
}

function installMessages(id = 'call-1'): AgentMessage[] {
    return [
        {
            type: 'tool_call',
            id,
            name: 'plugin_manager',
            input: { action: 'install_bundle', bundle: 'demo' },
            status: 'in_progress',
            nativeName: 'plugin_manager',
            nativeArgs: { action: 'install_bundle', bundle: 'demo' }
        },
        { type: 'tool_result', id, output: { ok: true }, status: 'completed' }
    ]
}

/** Injectable mtime store for the coordinator's watcher (absent → null). */
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

function makeCoordinator(
    host: ReturnType<typeof makeHost>,
    opts: {
        stat?: ReturnType<typeof fakeStat>
        reloadCooldownMs?: number
        now?: () => number
    } = {}
) {
    const stat = opts.stat ?? fakeStat()
    return {
        stat,
        coordinator: new DshPluginReloadCoordinator(host, {
            reloadCooldownMs: opts.reloadCooldownMs ?? 10_000,
            now: opts.now ?? Date.now,
            watcher: {
                profileDir: DIR,
                pollIntervalMs: 1000,
                debounceMs: 2000,
                statFile: stat.stat
            }
        })
    }
}

/** Flush the fire-and-forget settle kicked off by requestReload. */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

describe('DshPluginReloadCoordinator', () => {
    it('reloads immediately on a successful plugin_manager result while idle', async () => {
        const host = makeHost()
        const { coordinator } = makeCoordinator(host)

        for (const message of installMessages()) coordinator.observeAgentMessage(message)
        await flushMicrotasks()

        expect(host.notify).toHaveBeenCalledWith('DSH plugins changed; reloading the session…')
        expect(host.respawn).toHaveBeenCalledTimes(1)
    })

    it('defers a mid-turn signal until the turn settles', async () => {
        const host = makeHost({ promptActive: true })
        const { coordinator } = makeCoordinator(host)

        for (const message of installMessages()) coordinator.observeAgentMessage(message)
        await flushMicrotasks()
        expect(host.respawn).not.toHaveBeenCalled()

        host.state.promptActive = false
        await coordinator.settle() // the launcher's post-turn settle
        expect(host.respawn).toHaveBeenCalledTimes(1)
    })

    it('reloads on a profile-directory change after the debounce', async () => {
        vi.useFakeTimers()
        try {
            const host = makeHost()
            const { stat, coordinator } = makeCoordinator(host)
            coordinator.start()
            await vi.advanceTimersByTimeAsync(1000) // baseline poll

            stat.set('pnpm-lock.yaml', 99)
            await vi.advanceTimersByTimeAsync(3000)

            expect(host.respawn).toHaveBeenCalledTimes(1)
            coordinator.stop()
        } finally {
            vi.useRealTimers()
        }
    })

    it('collapses a directory change and the tool result of the same install into one reload', async () => {
        vi.useFakeTimers()
        try {
            const host = makeHost({ promptActive: true })
            const { stat, coordinator } = makeCoordinator(host)
            coordinator.start()
            await vi.advanceTimersByTimeAsync(1000)

            // Tool result lands mid-turn; the lockfile rewrite follows.
            for (const message of installMessages()) coordinator.observeAgentMessage(message)
            stat.set('pnpm-lock.yaml', 99)
            await vi.advanceTimersByTimeAsync(3000)
            expect(host.respawn).not.toHaveBeenCalled() // still mid-turn

            host.state.promptActive = false
            await coordinator.settle()
            expect(host.respawn).toHaveBeenCalledTimes(1)
            coordinator.stop()
        } finally {
            vi.useRealTimers()
        }
    })

    it('drops a trigger inside the reload cooldown instead of queueing it', async () => {
        let clock = 1000
        const host = makeHost()
        const { coordinator } = makeCoordinator(host, { now: () => clock })

        for (const message of installMessages('call-a')) coordinator.observeAgentMessage(message)
        await flushMicrotasks()
        expect(host.respawn).toHaveBeenCalledTimes(1)

        // A trigger inside the cooldown (e.g. the rebooted child rewriting a
        // file once at boot) is dropped — never a reload cycle.
        for (const message of installMessages('call-b')) coordinator.observeAgentMessage(message)
        await flushMicrotasks()
        expect(host.respawn).toHaveBeenCalledTimes(1)

        clock += 10_001
        for (const message of installMessages('call-c')) coordinator.observeAgentMessage(message)
        await flushMicrotasks()
        expect(host.respawn).toHaveBeenCalledTimes(2)
    })

    it('surfaces a failed respawn as a notification instead of throwing', async () => {
        const host = makeHost({ respawn: vi.fn(async () => { throw new Error('spawn failed') }) })
        const { coordinator } = makeCoordinator(host)

        for (const message of installMessages()) coordinator.observeAgentMessage(message)
        await expect(flushMicrotasks()).resolves.toBeUndefined()

        expect(host.notify).toHaveBeenCalledWith('DSH plugin reload failed: spawn failed')
    })

    it('never reloads while the session is dead or another respawn runs', async () => {
        const host = makeHost({ alive: false })
        const { coordinator } = makeCoordinator(host)
        for (const message of installMessages()) coordinator.observeAgentMessage(message)
        await flushMicrotasks()
        await coordinator.settle()
        expect(host.respawn).not.toHaveBeenCalled()

        host.state.alive = true
        host.state.respawning = true
        await coordinator.settle()
        expect(host.respawn).not.toHaveBeenCalled()
    })

    it('stop() tears the watcher down and clears pending state', async () => {
        vi.useFakeTimers()
        try {
            const host = makeHost({ promptActive: true })
            const { stat, coordinator } = makeCoordinator(host)
            coordinator.start()
            await vi.advanceTimersByTimeAsync(1000)

            stat.set('package.json', 5)
            coordinator.stop()
            await vi.advanceTimersByTimeAsync(10_000)

            host.state.promptActive = false
            await coordinator.settle()
            expect(host.respawn).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})

import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@/agent/types'
import { DshPluginToolTracker } from './dshPluginTools'

function pluginManagerCall(overrides: Partial<Extract<AgentMessage, { type: 'tool_call' }>> = {}): AgentMessage {
    return {
        type: 'tool_call',
        id: 'call-1',
        name: 'plugin_manager',
        input: { action: 'install_bundle', bundle: 'demo' },
        status: 'in_progress',
        ...overrides
    }
}

function result(id: string, status: 'completed' | 'failed'): AgentMessage {
    return { type: 'tool_result', id, output: { ok: true }, status }
}

describe('DshPluginToolTracker', () => {
    it('signals once on a successful install_bundle result', () => {
        const tracker = new DshPluginToolTracker()
        expect(tracker.observe(pluginManagerCall())).toBe(false)
        expect(tracker.observe(result('call-1', 'completed'))).toBe(true)
        // The consumed call cannot signal again.
        expect(tracker.observe(result('call-1', 'completed'))).toBe(false)
    })

    it('matches the agent-native name and args when the derived name differs', () => {
        const tracker = new DshPluginToolTracker()
        expect(tracker.observe(pluginManagerCall({
            id: 'call-n',
            name: 'Tool',
            input: {},
            nativeName: 'plugin_manager',
            nativeArgs: { action: 'remove_bundle', bundle: 'demo' }
        }))).toBe(false)
        expect(tracker.observe(result('call-n', 'completed'))).toBe(true)
    })

    it('stays silent for read-only list actions', () => {
        const tracker = new DshPluginToolTracker()
        for (const action of ['list_bundles', 'list_plugins', 'list_available']) {
            expect(tracker.observe(pluginManagerCall({ id: `call-${action}`, input: { action } }))).toBe(false)
            expect(tracker.observe(result(`call-${action}`, 'completed'))).toBe(false)
        }
    })

    it('stays silent for other tools and for failed results', () => {
        const tracker = new DshPluginToolTracker()
        expect(tracker.observe(pluginManagerCall({ id: 'call-f', name: 'Bash', nativeName: undefined }))).toBe(false)
        expect(tracker.observe(result('call-f', 'completed'))).toBe(false)

        expect(tracker.observe(pluginManagerCall({ id: 'call-e' }))).toBe(false)
        expect(tracker.observe(result('call-e', 'failed'))).toBe(false)
    })

    it('ignores results with no matching tracked call', () => {
        const tracker = new DshPluginToolTracker()
        expect(tracker.observe(result('call-unknown', 'completed'))).toBe(false)
    })

    it('drops tracked calls on reset so stale child results stay inert', () => {
        const tracker = new DshPluginToolTracker()
        expect(tracker.observe(pluginManagerCall({ id: 'call-r' }))).toBe(false)
        tracker.reset()
        expect(tracker.observe(result('call-r', 'completed'))).toBe(false)
    })
})

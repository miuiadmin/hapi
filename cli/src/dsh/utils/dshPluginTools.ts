import type { AgentMessage } from '@/agent/types'

/** dsh's plugin_manager tool (factory-disabled; re-enabling it is a separate
 * slice). Its actions include install_bundle / remove_bundle / set_plugin and
 * read-only list_* variants — only the mutating ones warrant a reload. */
const PLUGIN_MANAGER_TOOL_NAME = 'plugin_manager'

/** Actions that change the installed plugin set. Prefix-matched so future
 * spellings (install_bundle_from_market, set_plugin_enabled, …) stay covered
 * while every list_* read stays inert. */
function isMutatingAction(action: unknown): boolean {
    return typeof action === 'string'
        && (action.startsWith('install') || action.startsWith('remove') || action.startsWith('set_'))
}

function actionOf(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return (value as { action?: unknown }).action
}

/**
 * Tracks plugin_manager tool calls across the ACP message stream and turns a
 * SUCCESSFUL completion of a mutating call into a single boolean signal.
 *
 * Identity comes from the tool_call event — the derived `name` or the agent's
 * own `nativeName` (AcpMessageHandler populates both shapes) — and the
 * success from the matching tool_result's status. The output payload is
 * deliberately not parsed: its shape is dsh-version-specific and a reload on
 * a completed-but-empty install is harmless, while missing one is not.
 *
 * Harmless while the tool is disabled: no matching tool_call ever arrives,
 * so observe() always returns false.
 */
export class DshPluginToolTracker {
    private readonly mutatingCalls = new Set<string>()

    /**
     * Feed every agent message from the backend stream. Returns true exactly
     * once — on the successful tool_result of a tracked mutating call.
     */
    observe(message: AgentMessage): boolean {
        if (message.type === 'tool_call') {
            if (
                message.nativeName === PLUGIN_MANAGER_TOOL_NAME
                || message.name === PLUGIN_MANAGER_TOOL_NAME
            ) {
                if (isMutatingAction(actionOf(message.input)) || isMutatingAction(actionOf(message.nativeArgs))) {
                    this.mutatingCalls.add(message.id)
                }
            }
            return false
        }
        if (message.type === 'tool_result') {
            if (this.mutatingCalls.delete(message.id)) {
                return message.status === 'completed'
            }
        }
        return false
    }

    /** Forget tracked calls: a respawn swaps the dsh child, and late results
     * from the dead process must not read as fresh installs. */
    reset(): void {
        this.mutatingCalls.clear()
    }
}

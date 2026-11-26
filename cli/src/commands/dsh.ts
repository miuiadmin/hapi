import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { DSH_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import type { CommandDefinition } from './types'

export function parseDshCommandOptions(commandArgs: string[]) {
    // Permission modes apply through the shared ACP permission bridge
    // (auto-approval decisions), including `--yolo` (which also pins the
    // spawn-time DSH_PERMISSION_MODE sandbox preset).

    const options = parseRemoteAgentCommandOptions(commandArgs, DSH_PERMISSION_MODES, ['remote'])
    if (options.effort) {
        throw new Error('DeepSeek Harness launch-effort is not supported; use --model-reasoning-effort')
    }
    // --model-reasoning-effort is accepted: it seeds the reasoning-effort
    // preference (off/low/high/max) applied to the ACP session through
    // `session/set_config_option` (category thought_level) on the first
    // turn, and persists via the session metadata like the codex rail.
    // --resume is accepted: its value is the native ACP session id, resumed
    // via session/resume by the launcher (stored ids ride --existing-session-id).
    // --model is accepted: an opaque ACP config-option value forwarded at spawn
    // and switchable in-chat through session config.
    return { ...options, startingMode: 'remote' as const }
}

export const dshCommand: CommandDefinition = {
    name: 'dsh',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseDshCommandOptions(commandArgs)
            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runDsh } = await import('@/dsh/runDsh')
            await runDsh(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}

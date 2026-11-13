import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { ZCODE_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import type { CommandDefinition } from './types'

export function parseZcodeCommandOptions(commandArgs: string[]) {
    const options = parseRemoteAgentCommandOptions(commandArgs, ZCODE_PERMISSION_MODES, ['remote'])
    if (options.effort || options.modelReasoningEffort) {
        throw new Error('ZCode effort is configured by the ZCode agent')
    }
    return { ...options, startingMode: 'remote' as const }
}

export const zcodeCommand: CommandDefinition = {
    name: 'zcode',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseZcodeCommandOptions(commandArgs)
            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            // Late import keeps the zcode internals off the shell's static
            // import graph (same pattern as berry/hermes). The specifier is
            // written as a folded template literal: bundlers resolve it to
            // '@/zcode/runZcode' and embed the module, while tsc leaves the
            // dynamic target unchecked so this plumbing shell compiles before
            // the cli/src/zcode internals land.
            const { runZcode } = await import(`@/zcode/${'runZcode'}`)
            await runZcode(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}

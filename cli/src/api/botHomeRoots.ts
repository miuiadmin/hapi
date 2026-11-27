import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { resolveHapiHomeDir } from '@/configuration'

/**
 * Where a bot lives when its owner names no folder: `~/.hapi/bots`, and `bots`
 * under the runner's own folder when it was started with another `HAPI_HOME`.
 *
 * These are the machine's own folders, not session workspaces, so they are
 * part of what the machine's path policy allows even where `--workspace-root`
 * limits the workspace: the default the hub offers has to work on such a
 * machine too, for the home folder and for the home chat that runs in it.
 */
export function defaultBotHomeRoots(home: string = homedir()): string[] {
    return [...new Set([resolve(home, '.hapi', 'bots'), resolve(resolveHapiHomeDir(), 'bots')])]
}

import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { relative, resolve, sep } from 'node:path'
import {
    BOT_HOME_CLAUDE_MD,
    BOT_HOME_RULES_FILE,
    PrepareBotHomeRequestSchema,
    botHomeAgentsMd,
    type PrepareBotHomeRequest,
    type PrepareBotHomeResponse,
} from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { getErrorMessage, rpcError, type RpcErrorResponse } from './rpcResponses'

/**
 * Machine-level `prepare-bot-home` (hub → runner): create a bot's home folder
 * on this machine and seed its rules files. Same path authority as browsing and
 * spawning (`MachinePathPolicy`): with `--workspace-root` limits the home must
 * fall inside them.
 *
 * The runner never seeds files into a folder that is not a bot's home:
 * 1. the path policy above;
 * 2. the folder must not be the user's home directory or anything above it
 *    (`~` would put `CLAUDE.md` where every session on the machine reads it);
 * 3. after `mkdir -p`, a non-empty folder that does not look like a bot home
 *    (no `SOUL.md`, `MEMORY.md` or `AGENTS.md`) is refused — a user's project
 *    folder always is;
 * 4. a folder with an `AGENTS.md` that is not this bot's rules belongs to
 *    another bot and is refused; the same rules mean the same bot (a rebuild
 *    keeps its `SOUL.md` / `MEMORY.md` on purpose);
 * 5. a folder with the bot's notes but no rules yet is seeded.
 * Only `AGENTS.md` (build-owned) and `CLAUDE.md` (a pointer to it) are ever
 * written, and only when absent.
 */

/** Same surface as the workspace file handlers; the machine client owns the policy. */
export type BotHomePathPolicy = {
    resolveForCheck: (path: string) => Promise<string>
    isWithinSpawnRoots: (path: string) => boolean
}

export const BOT_HOME_OUTSIDE_WORKSPACE_ROOTS_ERROR = 'Path is outside this machine\'s workspace roots'

export type PrepareBotHomeOutcome = PrepareBotHomeResponse | (RpcErrorResponse & { code?: string })

export type PrepareBotHomeRefusal =
    | 'outside_workspace_roots'
    | 'invalid_path'
    | 'home_not_empty'
    | 'home_taken'
    | 'mkdir_failed'
    | 'seed_failed'

/** Files that mark a folder as a bot's home (plus the rules file). */
export const BOT_HOME_MARKER_FILES: readonly string[] = ['SOUL.md', 'MEMORY.md']

/** Expand a leading `~` / `~/rest` against `home`; everything else goes through `path.resolve`. */
export function expandBotHomePath(rawPath: string, home: string = homedir()): string {
    const trimmed = rawPath.trim()
    if (trimmed === '~') {
        return resolve(home)
    }
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return resolve(home, trimmed.slice(2))
    }
    return resolve(trimmed)
}

/** True when `candidate` is `anchor` itself or one of its ancestors. */
export function isSameOrAncestor(candidate: string, anchor: string): boolean {
    const rel = relative(resolve(candidate), resolve(anchor))
    return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep))
}

function refusal(code: PrepareBotHomeRefusal, error: string): PrepareBotHomeOutcome {
    return { ...rpcError(error), code }
}

/**
 * Write `content` only when `path` does not exist yet. `wx` makes the
 * check-and-write atomic, so a file that appears between the two is left alone.
 * Resolves true when this call created the file.
 */
async function writeFileIfAbsent(path: string, content: string): Promise<boolean> {
    try {
        await writeFile(path, content, { flag: 'wx' })
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return false
        }
        throw error
    }
}

export async function prepareBotHome(
    request: PrepareBotHomeRequest,
    deps: { pathPolicy: BotHomePathPolicy; home?: string }
): Promise<PrepareBotHomeOutcome> {
    // The policy check runs on the symlink-resolved path (same as spawn); the
    // folder is created and reported at the requested location, like spawn
    // hands the session its requested directory rather than the real path.
    const absolute = expandBotHomePath(request.path, deps.home)
    const resolved = await deps.pathPolicy.resolveForCheck(absolute)
    if (!deps.pathPolicy.isWithinSpawnRoots(resolved)) {
        return refusal('outside_workspace_roots', BOT_HOME_OUTSIDE_WORKSPACE_ROOTS_ERROR)
    }

    // Not the user's home, not anything above it — on either spelling of the
    // path (requested and symlink-resolved) and of the home (`/tmp` vs
    // `/private/tmp` on macOS), so a symlink to the home cannot slip through.
    const home = resolve(deps.home ?? homedir())
    const homeReal = await realpath(home).catch(() => home)
    const spellings = [absolute, resolved]
    const homes = [home, homeReal]
    if (spellings.some((candidate) => homes.some((anchor) => isSameOrAncestor(candidate, anchor)))) {
        return refusal(
            'invalid_path',
            'Path is the user home directory or a folder above it; a bot lives in a folder of its own'
        )
    }

    try {
        await mkdir(absolute, { recursive: true })
    } catch (error) {
        return refusal('mkdir_failed', `Could not create the bot home directory: ${getErrorMessage(error, 'mkdir failed')}`)
    }

    let names: Set<string>
    try {
        names = new Set(await readdir(absolute))
    } catch (error) {
        return refusal('home_not_empty', `Could not read the bot home directory: ${getErrorMessage(error, 'readdir failed')}`)
    }

    const rulesPath = resolve(absolute, BOT_HOME_RULES_FILE)
    const claudeMdPath = resolve(absolute, 'CLAUDE.md')
    const expectedRules = botHomeAgentsMd(request.name)
    const hasRules = names.has(BOT_HOME_RULES_FILE)
    const looksLikeBotHome = hasRules || BOT_HOME_MARKER_FILES.some((marker) => names.has(marker))

    if (names.size > 0 && !looksLikeBotHome) {
        return refusal(
            'home_not_empty',
            'This folder already has files in it and is not a bot home (no SOUL.md, MEMORY.md or AGENTS.md); choose an empty or a new folder'
        )
    }

    let seeded = false
    try {
        if (hasRules) {
            const existing = await readFile(rulesPath, 'utf8')
            if (existing !== expectedRules) {
                return refusal(
                    'home_taken',
                    'This folder is another bot\'s home (its AGENTS.md is not this bot\'s rules); choose a different folder'
                )
            }
        } else {
            seeded = await writeFileIfAbsent(rulesPath, expectedRules)
        }
        await writeFileIfAbsent(claudeMdPath, BOT_HOME_CLAUDE_MD)
    } catch (error) {
        return refusal('seed_failed', `Could not seed the bot home: ${getErrorMessage(error, 'write failed')}`)
    }

    return { path: absolute, seeded }
}

export function registerBotHomeHandlers(rpcHandlerManager: RpcHandlerManager, pathPolicy: BotHomePathPolicy): void {
    rpcHandlerManager.registerHandler<unknown, PrepareBotHomeOutcome>(RPC_METHODS.PrepareBotHome, async (raw) => {
        const parsed = PrepareBotHomeRequestSchema.safeParse(raw)
        if (!parsed.success) {
            // Say what is wrong with it (a relative path, a name with a line break), not only that something is.
            const why = parsed.error.issues.map((issue) => issue.message).join('; ')
            return refusal('invalid_path', `Invalid request for a bot's home folder: ${why}`)
        }
        return prepareBotHome(parsed.data, { pathPolicy })
    })
}

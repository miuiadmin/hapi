import { AcpSdkBackend } from '@/agent/backends/acp'

type ZcodeAcpEnvironment = Record<string, string | undefined>

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
}

function parseArgsJson(raw: string): string[] {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        throw new Error('HAPI_ZCODE_ACP_ARGS_JSON must be a JSON array of strings')
    }
    if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string')) {
        throw new Error('HAPI_ZCODE_ACP_ARGS_JSON must be a JSON array of strings')
    }
    return value
}

/**
 * Default ACP entrypoint: the community `zcode-acp-server` bridge is a plain
 * executable (no subcommand) — unlike berry/hermes it takes no args.
 */
export const ZCODE_DEFAULT_ACP_COMMAND = 'zcode-acp-server'
export const ZCODE_DEFAULT_ACP_ARGS: string[] = []

/** Default location of the ZCode GLM runtime the bridge spawns underneath. */
export const ZCODE_DEFAULT_BIN = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'

export function resolveZcodeAcpCommand(env: ZcodeAcpEnvironment = process.env): {
    command: string
    args: string[]
} {
    const override = env.HAPI_ZCODE_ACP_COMMAND?.trim()
    const command = override || ZCODE_DEFAULT_ACP_COMMAND
    if (env.HAPI_ZCODE_ACP_ARGS_JSON?.trim()) {
        return { command, args: parseArgsJson(env.HAPI_ZCODE_ACP_ARGS_JSON.trim()) }
    }
    return { command, args: ZCODE_DEFAULT_ACP_ARGS }
}

/**
 * Spawn-time env overlay for the zcode-acp-server bridge child:
 * - `ZCODE_BIN` — the ZCode GLM runtime (`zcode.cjs`) the bridge spawns
 *   underneath itself;
 * - `ZCODE_ACP_MODE` — the zcode mode axis value (build/plan/guarded/yolo)
 *   a NEW lazy session materializes in. The bridge defaults to its own
 *   "yolo" when the variable is unset, so HAPI must always pin the mapped
 *   mode of the session's permission setting here (verified in the bridge
 *   source: settings.js `initialSessionMode`).
 *
 * A machine-level value already present in the env wins for either lever,
 * mirroring `dshPermissionModeEnvOverlay`'s respect for explicit operator
 * env: an operator pinning `ZCODE_BIN` (e.g. a custom ZCode.app location)
 * or `ZCODE_ACP_MODE` on the machine profile keeps control regardless of
 * the session's preference.
 */
export function zcodeSpawnEnvOverlay(
    opts: { acpMode?: string },
    env: ZcodeAcpEnvironment = process.env
): Record<string, string> {
    const overlay: Record<string, string> = {}
    if (!env.ZCODE_BIN) {
        overlay.ZCODE_BIN = ZCODE_DEFAULT_BIN
    }
    if (opts.acpMode && !env.ZCODE_ACP_MODE) {
        overlay.ZCODE_ACP_MODE = opts.acpMode
    }
    return overlay
}

export function createZcodeBackend(
    env: NodeJS.ProcessEnv = process.env,
    opts: { acpMode?: string } = {}
): AcpSdkBackend {
    const { command, args } = resolveZcodeAcpCommand(env)
    return new AcpSdkBackend({
        command,
        args,
        env: filterEnv({ ...env, ...zcodeSpawnEnvOverlay(opts, env) }),
        flavor: 'zcode',
        // Verified against the zcode-acp-server bridge source: the agent
        // message stream is forwarded as pure agent_message_chunk deltas
        // (the default overlap dedupe treats a repeated token as an
        // already-buffered suffix and drops it, corrupting the transcript —
        // berry/grok/opencode/dsh/hermes pin delta mode for the same
        // reason).
        textChunkMode: 'delta'
    })
}

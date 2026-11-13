import { describe, expect, it } from 'vitest'
import { AcpSdkBackend } from '@/agent/backends/acp'

import {
    ZCODE_DEFAULT_ACP_ARGS,
    ZCODE_DEFAULT_ACP_COMMAND,
    ZCODE_DEFAULT_BIN,
    createZcodeBackend,
    resolveZcodeAcpCommand,
    zcodeSpawnEnvOverlay
} from './zcodeBackend'

describe('resolveZcodeAcpCommand', () => {
    it('defaults to the community zcode-acp-server bridge with no arguments', () => {
        expect(resolveZcodeAcpCommand({})).toEqual({
            command: 'zcode-acp-server',
            args: []
        })
        expect(ZCODE_DEFAULT_ACP_COMMAND).toBe('zcode-acp-server')
        expect(ZCODE_DEFAULT_ACP_ARGS).toEqual([])
    })

    it('supports custom wrappers through the command override', () => {
        expect(resolveZcodeAcpCommand({ HAPI_ZCODE_ACP_COMMAND: 'zcode-acp-demo' })).toEqual({
            command: 'zcode-acp-demo',
            args: []
        })
    })

    it('supports source checkouts through JSON args', () => {
        expect(resolveZcodeAcpCommand({
            HAPI_ZCODE_ACP_COMMAND: 'pnpm',
            HAPI_ZCODE_ACP_ARGS_JSON: '["--dir", "/opt/zcode-acp", "run", "acp"]'
        })).toEqual({
            command: 'pnpm',
            args: ['--dir', '/opt/zcode-acp', 'run', 'acp']
        })
    })

    it('rejects shell-like or malformed argument values', () => {
        expect(() => resolveZcodeAcpCommand({ HAPI_ZCODE_ACP_ARGS_JSON: 'zcode-acp-server' }))
            .toThrow('HAPI_ZCODE_ACP_ARGS_JSON must be a JSON array of strings')
        expect(() => resolveZcodeAcpCommand({ HAPI_ZCODE_ACP_ARGS_JSON: '["--verbose", 1]' }))
            .toThrow('HAPI_ZCODE_ACP_ARGS_JSON must be a JSON array of strings')
    })
})

describe('zcodeSpawnEnvOverlay', () => {
    it('pins the GLM runtime and the mapped mode for a new lazy session', () => {
        expect(zcodeSpawnEnvOverlay({ acpMode: 'build' }, {})).toEqual({
            ZCODE_BIN: ZCODE_DEFAULT_BIN,
            ZCODE_ACP_MODE: 'build'
        })
    })

    it('keeps a machine-level ZCODE_BIN authoritative', () => {
        // An operator pinning the runtime location keeps control regardless
        // of the session preference.
        expect(zcodeSpawnEnvOverlay(
            { acpMode: 'build' },
            { ZCODE_BIN: '/opt/zcode/zcode.cjs' }
        )).toEqual({ ZCODE_ACP_MODE: 'build' })
    })

    it('keeps a machine-level ZCODE_ACP_MODE authoritative', () => {
        // Mirrors dshPermissionModeEnvOverlay's respect order: an explicit
        // operator pin wins over the session's mapped mode.
        expect(zcodeSpawnEnvOverlay(
            { acpMode: 'build' },
            { ZCODE_ACP_MODE: 'guarded' }
        )).toEqual({ ZCODE_BIN: ZCODE_DEFAULT_BIN })
    })

    it('still pins the runtime without a mode', () => {
        // The bridge's own default for a missing ZCODE_ACP_MODE is "yolo";
        // the launcher always passes the mapped mode, so this only covers
        // the opts-less call.
        expect(zcodeSpawnEnvOverlay({}, {})).toEqual({ ZCODE_BIN: ZCODE_DEFAULT_BIN })
    })
})

describe('createZcodeBackend spawn configuration', () => {
    it('pins the spawn overlay and delta chunk streaming', () => {
        // The zcode-acp-server bridge forwards pure agent_message_chunk
        // deltas; the default overlap dedupe drops repeated tokens
        // (berry/grok pin the same mode for the same reason).
        const backend = createZcodeBackend(
            { PATH: '/usr/bin' },
            { acpMode: 'guarded' }
        )
        const options = (backend as unknown as {
            options: {
                env: Record<string, string | undefined>
                textChunkMode?: string
                flavor?: string
            }
        }).options

        expect(options.env.ZCODE_BIN).toBe('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs')
        expect(options.env.ZCODE_ACP_MODE).toBe('guarded')
        expect(options.env.PATH).toBe('/usr/bin')
        expect(options.textChunkMode).toBe('delta')
        expect(options.flavor).toBe('zcode')
    })

    it('leaves machine-level levers untouched', () => {
        const backend = createZcodeBackend(
            {
                ZCODE_BIN: '/opt/zcode/zcode.cjs',
                ZCODE_ACP_MODE: 'plan'
            },
            { acpMode: 'build' }
        )
        const options = (backend as unknown as {
            options: { env: Record<string, string | undefined> }
        }).options

        expect(options.env.ZCODE_BIN).toBe('/opt/zcode/zcode.cjs')
        expect(options.env.ZCODE_ACP_MODE).toBe('plan')
    })

    it('constructs an AcpSdkBackend', () => {
        expect(createZcodeBackend({})).toBeInstanceOf(AcpSdkBackend)
    })
})

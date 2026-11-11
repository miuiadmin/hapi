import { describe, expect, it } from 'vitest'
import { createHermesBackend, resolveHermesAcpCommand } from './hermesBackend'

describe('resolveHermesAcpCommand', () => {
    it('defaults to the hermes CLI with the acp subcommand', () => {
        expect(resolveHermesAcpCommand({})).toEqual({
            command: 'hermes',
            args: ['acp']
        })
    })

    it('keeps bare arguments for an explicitly configured server', () => {
        // Custom wrappers must not silently receive the official CLI's
        // `acp` subcommand; they opt into args via ARGS_JSON.
        expect(resolveHermesAcpCommand({ HAPI_HERMES_ACP_COMMAND: 'hermes-acp-demo' })).toEqual({
            command: 'hermes-acp-demo',
            args: []
        })
    })

    it('supports source checkouts and community servers through JSON args', () => {
        expect(resolveHermesAcpCommand({
            HAPI_HERMES_ACP_COMMAND: 'pnpm',
            HAPI_HERMES_ACP_ARGS_JSON: '["--dir", "/opt/hermes", "run", "acp"]'
        })).toEqual({
            command: 'pnpm',
            args: ['--dir', '/opt/hermes', 'run', 'acp']
        })
    })

    it('rejects shell-like or malformed argument values', () => {
        expect(() => resolveHermesAcpCommand({ HAPI_HERMES_ACP_ARGS_JSON: 'hermes acp' }))
            .toThrow('HAPI_HERMES_ACP_ARGS_JSON must be a JSON array of strings')
        expect(() => resolveHermesAcpCommand({ HAPI_HERMES_ACP_ARGS_JSON: '["hermes", 1]' }))
            .toThrow('HAPI_HERMES_ACP_ARGS_JSON must be a JSON array of strings')
    })
})

describe('createHermesBackend', () => {
    it('pins delta text chunk mode (hermes streams pure append deltas)', () => {
        // Hermes agent_message_chunk is a delta stream keyed by messageId;
        // the default dedupe would drop repeated tokens as buffered suffixes.
        const backend = createHermesBackend({})
        const options = (backend as unknown as { options: { textChunkMode?: string; flavor?: string } }).options
        expect(options.textChunkMode).toBe('delta')
        expect(options.flavor).toBe('hermes')
    })
})

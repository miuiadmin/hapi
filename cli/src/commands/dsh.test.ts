import { describe, expect, it } from 'vitest'
import { parseDshCommandOptions } from './dsh'

describe('parseDshCommandOptions', () => {
    it('forces remote mode and accepts an existing HAPI row', () => {
        expect(parseDshCommandOptions([
            '--hapi-starting-mode', 'remote',
            '--existing-session-id', 'hapi-session'
        ])).toEqual({
            startingMode: 'remote',
            existingSessionId: 'hapi-session'
        })
    })

    it('rejects launch-effort, accepts reasoning effort and native resume', async () => {
        expect(() => parseDshCommandOptions(['--effort', 'high']))
            .toThrow('launch-effort is not supported')
        // --model-reasoning-effort seeds the reasoning-effort preference
        // (off/low/high/max) applied via session/set_config_option.
        expect(parseDshCommandOptions(['--model-reasoning-effort', 'high']))
            .toEqual({ modelReasoningEffort: 'high', startingMode: 'remote' as const })
        // --resume carries the native ACP session id (runner-emitted on reopen).
        expect(parseDshCommandOptions(['--resume', 'acp-session-1']))
            .toEqual({ resumeSessionId: 'acp-session-1', startingMode: 'remote' as const })
    })

    it('accepts a model override applied through the ACP config option', () => {
        expect(parseDshCommandOptions(['--model', '["deepseek-official","deepseek-v4-pro"]']))
            .toEqual({
                model: '["deepseek-official","deepseek-v4-pro"]',
                startingMode: 'remote' as const
            })
    })

    it('maps --yolo to the yolo permission mode', () => {
        expect(parseDshCommandOptions(['--yolo'])).toEqual({
            startingMode: 'remote',
            permissionMode: 'yolo'
        })
    })

    it('accepts an explicit --permission-mode from the DSH mode set', () => {
        expect(parseDshCommandOptions(['--permission-mode', 'safe-yolo'])).toEqual({
            startingMode: 'remote',
            permissionMode: 'safe-yolo'
        })
        expect(() => parseDshCommandOptions(['--permission-mode', 'plan']))
            .toThrow('Invalid --permission-mode value')
        // Modes outside dsh's catalog stay rejected (claude's yolo alias is
        // not a dsh mode).
        expect(() => parseDshCommandOptions(['--permission-mode', 'bypassPermissions']))
            .toThrow('Invalid --permission-mode value: bypassPermissions')
    })

    it('accepts a model override applied through the ACP config option', () => {
        expect(parseDshCommandOptions(['--model', '["deepseek-official","deepseek-v4-pro"]']))
            .toEqual({
                model: '["deepseek-official","deepseek-v4-pro"]',
                startingMode: 'remote' as const
            })
    })
})

import { describe, expect, it } from 'vitest'
import { parseZcodeCommandOptions } from './zcode'

describe('parseZcodeCommandOptions', () => {
    it('forces remote mode and accepts an existing HAPI row', () => {
        expect(parseZcodeCommandOptions([
            '--hapi-starting-mode', 'remote',
            '--existing-session-id', 'hapi-session'
        ])).toEqual({
            startingMode: 'remote',
            existingSessionId: 'hapi-session'
        })
    })

    it('accepts native resume and model options plus the permission modes', () => {
        expect(parseZcodeCommandOptions(['--resume', 'native-id', '--model', 'zhipu\\glm-5.3']))
            .toMatchObject({ resumeSessionId: 'native-id', model: 'zhipu\\glm-5.3', startingMode: 'remote' })
        expect(parseZcodeCommandOptions(['--yolo']))
            .toMatchObject({ permissionMode: 'yolo', startingMode: 'remote' })
        expect(parseZcodeCommandOptions(['--permission-mode', 'safe-yolo']))
            .toMatchObject({ permissionMode: 'safe-yolo', startingMode: 'remote' })
        // ZCode maps read-only onto the bridge's ZCODE_ACP_MODE=plan axis.
        expect(parseZcodeCommandOptions(['--permission-mode', 'read-only']))
            .toMatchObject({ permissionMode: 'read-only', startingMode: 'remote' })
        expect(() => parseZcodeCommandOptions(['--permission-mode', 'bypassPermissions']))
            .toThrow('Invalid --permission-mode value')
    })

    it('rejects non-remote starting modes', () => {
        expect(() => parseZcodeCommandOptions(['--hapi-starting-mode', 'local']))
            .toThrow('Invalid --hapi-starting-mode')
        expect(() => parseZcodeCommandOptions(['--hapi-starting-mode', 'pty']))
            .toThrow('Invalid --hapi-starting-mode')
    })

    it('rejects effort overrides owned by the ZCode agent', () => {
        expect(() => parseZcodeCommandOptions(['--effort', 'high']))
            .toThrow('effort')
        expect(() => parseZcodeCommandOptions(['--model-reasoning-effort', 'high']))
            .toThrow('effort')
    })
})

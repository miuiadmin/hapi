import { describe, expect, it } from 'vitest'
import { zcodeModeForPreference } from './types'

const GLM_MODEL = 'zhipu\\glm-5.3'

describe('zcodeModeForPreference', () => {
    it('drops the model field entirely for an unset preference', () => {
        // Ordinary turns without a preference must hash identically to a
        // mode-less batch; the launcher's reset branch must never see them.
        expect(zcodeModeForPreference(undefined)).toEqual({})
        expect('model' in zcodeModeForPreference(undefined)).toBe(false)
    })

    it('keeps null as the explicit Default reset request', () => {
        expect(zcodeModeForPreference(null)).toEqual({ model: null })
    })

    it('forwards a concrete model verbatim (opaque providerId\\modelId value)', () => {
        expect(zcodeModeForPreference(GLM_MODEL)).toEqual({ model: GLM_MODEL })
    })

    it('attaches the permission mode only once one is set', () => {
        expect(zcodeModeForPreference(GLM_MODEL)).toEqual({ model: GLM_MODEL })
        expect(zcodeModeForPreference(GLM_MODEL, 'yolo')).toEqual({ model: GLM_MODEL, permissionMode: 'yolo' })
        expect(zcodeModeForPreference(undefined, 'safe-yolo')).toEqual({ permissionMode: 'safe-yolo' })
    })
})

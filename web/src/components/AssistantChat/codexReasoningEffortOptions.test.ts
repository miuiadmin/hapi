import { describe, expect, it } from 'vitest'
import {
    DSH_REASONING_EFFORT_PRESETS,
    getCodexComposerReasoningEffortOptions,
    getDshReasoningEffortSourceOptions
} from './codexReasoningEffortOptions'

describe('getCodexComposerReasoningEffortOptions', () => {
    it('includes the default option and preset values for Codex', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'codex')).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' }
        ])
    })

    it('preserves non-preset current values for Codex', () => {
        expect(getCodexComposerReasoningEffortOptions('minimal', 'codex')).toEqual([
            { value: null, label: 'Default' },
            { value: 'minimal', label: 'Minimal' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' }
        ])
    })

    it('uses arbitrary model-reported efforts for Codex', () => {
        expect(getCodexComposerReasoningEffortOptions('extreme', 'codex', [
            { value: 'low' },
            { value: 'medium' },
            { value: 'high' },
            { value: 'xhigh' },
            { value: 'max' },
            { value: 'ultra' },
            { value: 'extreme' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
            { value: 'ultra', label: 'Ultra' },
            { value: 'extreme', label: 'Extreme' }
        ])
    })

    it('keeps an unsupported current Codex effort visible', () => {
        expect(getCodexComposerReasoningEffortOptions('ultra', 'codex', [
            { value: 'low' },
            { value: 'max' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'ultra', label: 'Ultra' },
            { value: 'low', label: 'Low' },
            { value: 'max', label: 'Max' }
        ])
    })

    it('returns no options for OpenCode until dynamic options are available', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'opencode')).toEqual([])
        expect(getCodexComposerReasoningEffortOptions(null, 'opencode', [])).toEqual([])
    })

    it('builds OpenCode options from ACP-reported values', () => {
        expect(getCodexComposerReasoningEffortOptions('low', 'opencode', [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }
        ])
    })

    it('preserves unsupported current OpenCode values in the dropdown', () => {
        expect(getCodexComposerReasoningEffortOptions('high', 'opencode', [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'high', label: 'High' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }
        ])
    })
})

describe('getCodexComposerReasoningEffortOptions — dsh thought_level', () => {
    // DSH advertises a single session-wide `reasoning_effort` config option
    // (category thought_level) with a fixed value set: off/low/high/max plus
    // '' meaning "Provider default" (mapped onto the null Default entry).
    it('advertises the fixed dsh value set: off/low/high/max', () => {
        expect([...DSH_REASONING_EFFORT_PRESETS]).toEqual(['off', 'low', 'high', 'max'])
        expect(getDshReasoningEffortSourceOptions()).toEqual([
            { value: 'off' },
            { value: 'low' },
            { value: 'high' },
            { value: 'max' }
        ])
    })

    it('builds Default + off/low/high/max without dynamic options', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'dsh')).toEqual([
            { value: null, label: 'Default' },
            { value: 'off', label: 'Off' },
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' }
        ])
    })

    it('prefers discovered dynamic options when provided', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'dsh', [{ value: 'low' }, { value: 'high' }])).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
        ])
    })

    it('normalizes the dsh empty value (Provider default) onto the null Default entry', () => {
        const options = getCodexComposerReasoningEffortOptions('', 'dsh')
        expect(options[0]).toEqual({ value: null, label: 'Default' })
        // No duplicate '' entry: '' is the provider default.
        expect(options.filter((option) => option.value === '' || option.value === null)).toHaveLength(1)
    })

    it('keeps an out-of-set current effort visible so the picker never loses the selection', () => {
        expect(getCodexComposerReasoningEffortOptions('medium', 'dsh')).toEqual([
            { value: null, label: 'Default' },
            { value: 'medium', label: 'Medium' },
            { value: 'off', label: 'Off' },
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' }
        ])
    })
})

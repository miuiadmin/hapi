import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar, shouldShowComposerStatusBar } from './StatusBar'

function renderStatusBar(props: Partial<Parameters<typeof StatusBar>[0]>) {
    return render(
        <I18nProvider>
            <StatusBar
                active
                thinking={false}
                agentState={null}
                agentFlavor="codex"
                {...props}
            />
        </I18nProvider>
    )
}

describe('shouldShowComposerStatusBar', () => {
    it('hides the composer status bar for Cursor sessions', () => {
        expect(shouldShowComposerStatusBar('cursor')).toBe(false)
    })

    it('shows the composer status bar for other agents', () => {
        expect(shouldShowComposerStatusBar('claude')).toBe(true)
        expect(shouldShowComposerStatusBar('codex')).toBe(true)
        expect(shouldShowComposerStatusBar(null)).toBe(true)
    })
})

describe('Codex fast badge', () => {
    it('hides the badge when the service tier is unset and effort is low', () => {
        renderStatusBar({ serviceTier: null, modelReasoningEffort: 'low' })
        expect(screen.queryByText('fast')).not.toBeInTheDocument()
    })

    it('hides the badge when the service tier is unset and the model is a mini model', () => {
        renderStatusBar({ serviceTier: null, model: 'gpt-5.1-codex-mini' })
        expect(screen.queryByText('fast')).not.toBeInTheDocument()
    })

    it('shows the badge when the service tier is explicitly fast', () => {
        renderStatusBar({ serviceTier: 'fast', modelReasoningEffort: 'high' })
        expect(screen.getByText('fast')).toBeInTheDocument()
    })

    it('hides the badge when the service tier is standard', () => {
        renderStatusBar({ serviceTier: 'standard', modelReasoningEffort: 'low' })
        expect(screen.queryByText('fast')).not.toBeInTheDocument()
    })

    it('hides the badge for non-Codex agents even with a fast tier', () => {
        renderStatusBar({ agentFlavor: 'claude', serviceTier: 'fast' })
        expect(screen.queryByText('fast')).not.toBeInTheDocument()
    })
})

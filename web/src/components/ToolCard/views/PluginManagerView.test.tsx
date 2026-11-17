import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { parsePluginManagerResult } from '@/components/ToolCard/views/PluginManagerView'
import { I18nProvider } from '@/lib/i18n-context'

const installInput = {
    action: 'install_bundle',
    target: 'berry-tools@^1',
    registry: 'https://registry.example.com'
}

function pluginBlock(overrides: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'pm-1', localId: null, createdAt: 1000, children: [],
        tool: {
            id: 'pm-1', name: 'plugin_manager', state: 'running', input: installInput,
            result: undefined, description: null, createdAt: 1000, startedAt: 1000, completedAt: null,
            execStartedAt: null, execCompletedAt: null,
            ...overrides
        }
    }
}

function renderPlugin(block: ToolCallBlock) {
    const { container } = render(<I18nProvider><ToolCard
        api={{} as ApiClient} sessionId="session-1" metadata={null}
        terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block}
    /></I18nProvider>)
    const view = container.querySelector('[data-plugin-manager-view]')
    if (!(view instanceof HTMLElement)) throw new Error('dedicated plugin_manager view missing')
    return { container, view }
}

describe('parsePluginManagerResult', () => {
    it('recognizes list results with totals and pagination', () => {
        const outcome = parsePluginManagerResult(JSON.stringify({
            entries: [{}, {}, {}],
            total: 5,
            nextOffset: 3
        }))
        expect(outcome).toEqual({ kind: 'listed', total: 5, shown: 3, nextOffset: 3 })
    })

    it('extracts the application verdict and nextStep hint', () => {
        const outcome = parsePluginManagerResult(JSON.stringify({
            application: 'restart-required',
            nextStep: 'Tell the user to restart DSH to load the bundle.'
        }))
        expect(outcome).toEqual({
            kind: 'changed',
            application: 'restart-required',
            nextStep: 'Tell the user to restart DSH to load the bundle.',
            detail: null
        })
    })

    it('collects failure details from error payloads', () => {
        const outcome = parsePluginManagerResult(JSON.stringify({
            application: 'failed',
            error: { code: 'target_not_found' },
            packageResult: { kind: 'install-failed' }
        }))
        expect(outcome).toMatchObject({
            kind: 'changed',
            application: 'failed',
            detail: 'error: target_not_found · package: install-failed'
        })
    })

    it('keeps non-JSON text as-is', () => {
        expect(parsePluginManagerResult('plugin manager refused: unknown action')).toEqual({
            kind: 'text',
            message: 'plugin manager refused: unknown action'
        })
        expect(parsePluginManagerResult(undefined)).toBeNull()
    })
})

describe('PluginManagerView in ToolCard', () => {
    beforeEach(() => localStorage.setItem('hapi-lang', 'en'))

    it('shows the action and target chips while running', () => {
        const { view } = renderPlugin(pluginBlock())
        const input = view.querySelector('[data-plugin-manager-input]')
        expect(input).not.toBeNull()
        expect(within(view).getByText('install_bundle')).toBeInTheDocument()
        expect(within(view).getByText('berry-tools@^1')).toBeInTheDocument()
        expect(view.querySelector('[data-plugin-result]')).toBeNull()
    })

    it('renders the application badge with the nextStep hint on its own line', () => {
        const { view } = renderPlugin(pluginBlock({
            state: 'completed',
            result: JSON.stringify({
                application: 'restart-required',
                nextStep: 'Tell the user to restart DSH to load the bundle.'
            })
        }))
        expect(view.querySelector('[data-plugin-application="restart-required"]')).not.toBeNull()
        const nextStep = view.querySelector('[data-plugin-next-step]')
        expect(nextStep).not.toBeNull()
        expect(nextStep?.textContent).toContain('Tell the user to restart DSH to load the bundle.')
    })

    it('summarizes list results as an entry count', () => {
        const { view } = renderPlugin(pluginBlock({
            state: 'completed',
            input: { action: 'list_plugins' },
            result: JSON.stringify({ entries: [{}, {}], total: 2, nextOffset: null })
        }))
        expect(view.querySelector('[data-plugin-result="listed"]')).not.toBeNull()
        expect(within(view).getByText('2 entries')).toBeInTheDocument()
    })

    it('falls back to raw text for unrecognized payloads', () => {
        const { view } = renderPlugin(pluginBlock({
            state: 'completed',
            result: 'plugin manager refused: unknown action'
        }))
        expect(within(view).getByText(/plugin manager refused/)).toBeInTheDocument()
    })

    it('defers the outcome to the dialog result section', () => {
        renderPlugin(pluginBlock({
            state: 'completed',
            result: JSON.stringify({
                application: 'restart-required',
                nextStep: 'Tell the user to restart DSH to load the bundle.'
            })
        }))
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        const dialog = screen.getByRole('dialog')
        // Input view keeps only the chips; the Result section carries the verdict.
        expect(dialog.querySelectorAll('[data-plugin-application]')).toHaveLength(0)
        expect(within(dialog).getByText('install_bundle')).toBeInTheDocument()
    })

    it('titles the card from the action and target', () => {
        renderPlugin(pluginBlock())
        expect(screen.getByText('install_bundle berry-tools@^1')).toBeInTheDocument()
    })
})

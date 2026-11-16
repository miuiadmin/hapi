import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

const workflowInput = {
    args: { files: ['a.ts', 'b.ts'] },
    meta: {
        name: 'repo-audit',
        description: 'Fan out an audit across files',
        phases: [
            { title: 'Scan', detail: 'find matching files' },
            { title: 'Fix', detail: 'apply the repairs' }
        ]
    },
    run_in_background: false,
    script: [
        "phase('Scan')",
        "agent('inspect a', { label: 'reader', phase: 'Scan' })",
        "agent('inspect b', { label: 'checker' })",
        "phase('Fix')"
    ].join('\n')
}

function workflowBlock(overrides: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'wf-1', localId: null, createdAt: 1000, children: [],
        tool: {
            id: 'wf-1', name: 'workflow', state: 'running', input: workflowInput,
            result: undefined, description: null, createdAt: 1000, startedAt: 1000, completedAt: null,
            execStartedAt: null, execCompletedAt: null,
            ...overrides
        }
    }
}

function renderWorkflow(block: ToolCallBlock) {
    const { container } = render(<I18nProvider><ToolCard
        api={{} as ApiClient} sessionId="session-1" metadata={null}
        terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block}
    /></I18nProvider>)
    const view = container.querySelector('[data-workflow-view]')
    if (!(view instanceof HTMLElement)) throw new Error('dedicated workflow view missing')
    return { container, view }
}

describe('WorkflowView in ToolCard', () => {
    beforeEach(() => localStorage.setItem('hapi-lang', 'en'))

    it('renders the dedicated phase checklist while the workflow runs silently', () => {
        const { view } = renderWorkflow(workflowBlock())
        // First phase live, the rest queued.
        expect(view.querySelector('[data-workflow-phase="Scan"]')?.className).toContain('text-[var(--app-link)]')
        expect(view.querySelector('[data-workflow-phase="Fix"]')?.className).toContain('text-[var(--app-hint)]')
        // Agent chips: grouped under the phase, stray label kept outside it.
        expect(within(view).getAllByText('reader')).toHaveLength(1)
        expect(within(view).getByText('checker')).toBeInTheDocument()
        // The generic dump would show the raw script text inline.
        expect(screen.queryByText(/phase\('Scan'\)/)).not.toBeInTheDocument()
    })

    it('shows the completed agent count and a collapsed return value', () => {
        const { view } = renderWorkflow(workflowBlock({
            state: 'completed',
            result: 'workflow "repo-audit" completed (6 agents)\nReturn value:\n```json\n{"ok": true}\n```'
        }))
        expect(within(view).getByText('6 agents')).toBeInTheDocument()
        const returnValue = within(view).getByText('Return value').closest('details')
        expect(returnValue?.open).toBe(false)
        // The raw JSON stays behind the collapsed summary, not as loose body text.
        expect(within(view).getByText('Return value').tagName).toBe('SUMMARY')
    })

    it('marks every phase completed once the run finishes', () => {
        const { view } = renderWorkflow(workflowBlock({
            state: 'completed',
            result: 'workflow "repo-audit" completed (6 agents)'
        }))
        expect(view.querySelector('[data-workflow-phase="Scan"]')?.className).toContain('line-through')
        expect(view.querySelector('[data-workflow-phase="Fix"]')?.className).toContain('line-through')
    })

    it('surfaces the background job chip for instant background starts', () => {
        const { view } = renderWorkflow(workflowBlock({
            state: 'completed',
            input: { ...workflowInput, run_in_background: true },
            result: 'workflow "repo-audit" started in the background as job workflow-0f1e2d3c4b5a'
        }))
        expect(within(view).getByText('workflow-0f1e2d3c4b5a')).toBeInTheDocument()
    })

    it('shows the failure message for error results', () => {
        const { view } = renderWorkflow(workflowBlock({
            state: 'error',
            result: 'Error: Misused hooks end the whole script'
        }))
        expect(within(view).getByText('Misused hooks end the whole script')).toBeInTheDocument()
    })

    it('shows the outcome once in the detail dialog (result section, not input view)', () => {
        renderWorkflow(workflowBlock({
            state: 'completed',
            result: 'workflow "repo-audit" completed (6 agents)\nReturn value:\n```json\n{"ok": true}\n```'
        }))
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        const dialog = screen.getByRole('dialog')
        // Inline card body + dialog result section: the agent-count badge must
        // not appear twice inside the dialog (input view defers to it).
        expect(within(dialog).getAllByText('6 agents')).toHaveLength(1)
        expect(within(dialog).getByText('Return value')).toBeInTheDocument()
    })

    it('titles the card Workflow with the meta name as subtitle', () => {
        renderWorkflow(workflowBlock())
        expect(screen.getByText('Workflow')).toBeInTheDocument()
        expect(screen.getAllByText('repo-audit').length).toBeGreaterThan(0)
    })
})

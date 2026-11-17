import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { parseRunCodeResult } from '@/components/ToolCard/views/RunCodeView'
import { I18nProvider } from '@/lib/i18n-context'

const runCodeInput = {
    code: 'const rows = await sdk.listMachines()\nconsole.log(rows.length)\nreturn rows.length',
    description: 'Count registered machines',
    timeoutMs: 120000
}

function runCodeBlock(overrides: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'rc-1', localId: null, createdAt: 1000, children: [],
        tool: {
            id: 'rc-1', name: 'run_code', state: 'running', input: runCodeInput,
            result: undefined, description: null, createdAt: 1000, startedAt: 1000, completedAt: null,
            execStartedAt: null, execCompletedAt: null,
            ...overrides
        }
    }
}

function renderRunCode(block: ToolCallBlock) {
    const { container } = render(<I18nProvider><ToolCard
        api={{} as ApiClient} sessionId="session-1" metadata={null}
        terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block}
    /></I18nProvider>)
    const view = container.querySelector('[data-run-code-view]')
    if (!(view instanceof HTMLElement)) throw new Error('dedicated run_code view missing')
    return { container, view }
}

describe('parseRunCodeResult', () => {
    it('splits a structured DSH payload into logs and result', () => {
        const outcome = parseRunCodeResult({ logs: ['a', ''], result: { count: 3 } })
        expect(outcome).toEqual({ logs: ['a'], resultText: '{\n  "count": 3\n}' })
    })

    it('accepts the structured payload shipped as JSON text', () => {
        const outcome = parseRunCodeResult(JSON.stringify({ logs: ['a'], result: { count: 3 } }))
        expect(outcome).toEqual({ logs: ['a'], resultText: '{\n  "count": 3\n}' })
    })

    it('keeps the flattened bridge text as the result', () => {
        const outcome = parseRunCodeResult('counted 3 machines')
        expect(outcome).toEqual({ logs: [], resultText: 'counted 3 machines' })
    })

    it('returns null without a result', () => {
        expect(parseRunCodeResult(undefined)).toBeNull()
        expect(parseRunCodeResult('   ')).toBeNull()
    })
})

describe('RunCodeView in ToolCard', () => {
    beforeEach(() => localStorage.setItem('hapi-lang', 'en'))

    it('renders the program collapsed while the code runs', () => {
        const { view } = renderRunCode(runCodeBlock())
        const program = view.querySelector('[data-run-code-program]')
        expect(program).toBeInstanceOf(HTMLDetailsElement)
        expect((program as HTMLDetailsElement).open).toBe(false)
        // No outcome yet.
        expect(view.querySelector('[data-run-code-outcome]')).toBeNull()
    })

    it('folds logs and result into the inline card once settled', () => {
        const { view } = renderRunCode(runCodeBlock({
            state: 'completed',
            result: JSON.stringify({ logs: ['probing sdk', 'done'], result: { count: 3 } })
        }))
        const outcome = view.querySelector('[data-run-code-outcome]')
        expect(outcome).not.toBeNull()
        expect(within(view).getByText('Logs')).toBeInTheDocument()
        expect(within(view).getByText('Result')).toBeInTheDocument()
        // Flattened text fallback also lands in the result block.
        const { view: textView } = renderRunCode(runCodeBlock({
            state: 'completed',
            result: 'counted 3 machines'
        }))
        expect(textView.querySelector('[data-run-code-outcome]')).not.toBeNull()
    })

    it('defers the outcome to the dialog result section', () => {
        renderRunCode(runCodeBlock({
            state: 'completed',
            result: JSON.stringify({ logs: ['done'], result: { count: 3 } })
        }))
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        const dialog = screen.getByRole('dialog')
        // The dialog input view shows the program only; the Result section
        // below carries the outcome, so the inline fold must not duplicate it.
        expect(dialog.querySelectorAll('[data-run-code-outcome]')).toHaveLength(0)
        expect(within(dialog).getByText('Program')).toBeInTheDocument()
    })

    it('titles the card from the description with the code first line as subtitle', () => {
        renderRunCode(runCodeBlock())
        expect(screen.getByText('Count registered machines')).toBeInTheDocument()
        expect(screen.getAllByText(/const rows = await sdk\.listMachines\(\)/).length).toBeGreaterThan(0)
    })

    it('falls back to the code first line as the title without a description', () => {
        renderRunCode(runCodeBlock({
            input: { code: runCodeInput.code, timeoutMs: runCodeInput.timeoutMs }
        }))
        expect(screen.getAllByText(/const rows = await sdk\.listMachines\(\)/).length).toBeGreaterThan(0)
        expect(screen.queryByText('Count registered machines')).not.toBeInTheDocument()
    })
})

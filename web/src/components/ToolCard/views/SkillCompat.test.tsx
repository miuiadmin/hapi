import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { getToolFullViewComponent } from '@/components/ToolCard/views/_all'
import { I18nProvider } from '@/lib/i18n-context'

// DSH's lowercase skill tool sends {name} (verified against a production hub
// row: {"type":"tool-call","name":"skill","input":{"name":"berryos-dev"}}),
// where Claude's capitalized Skill sends {skill}. Both flavors must title the
// card and resolve the dialog view.
function skillBlock(input: Record<string, unknown>): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'sk-1', localId: null, createdAt: 1000, children: [],
        tool: {
            id: 'sk-1', name: 'skill', state: 'completed', input,
            result: 'skill loaded', description: null, createdAt: 1000, startedAt: 1000, completedAt: 2000,
            execStartedAt: null, execCompletedAt: null
        }
    }
}

function renderSkill(block: ToolCallBlock) {
    return render(<I18nProvider><ToolCard
        api={{} as ApiClient} sessionId="session-1" metadata={null}
        terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block}
    /></I18nProvider>)
}

describe('lowercase skill tool compat', () => {
    beforeEach(() => localStorage.setItem('hapi-lang', 'en'))

    it('titles the card from the DSH {name} input', () => {
        renderSkill(skillBlock({ name: 'berryos-dev' }))
        expect(screen.getByText('Skill: berryos-dev')).toBeInTheDocument()
    })

    it('still reads the Claude {skill} input shape', () => {
        renderSkill(skillBlock({ skill: 'pdf-tools' }))
        expect(screen.getByText('Skill: pdf-tools')).toBeInTheDocument()
    })

    it('resolves the dialog view and reads either key there', () => {
        expect(getToolFullViewComponent('skill')).not.toBeNull()
        renderSkill(skillBlock({ name: 'berryos-dev' }))
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getAllByText('berryos-dev').length).toBeGreaterThan(0)
    })
})

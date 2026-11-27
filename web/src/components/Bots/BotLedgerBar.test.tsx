import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BotSummary } from '@hapi/protocol'
import { I18nProvider } from '@/lib/i18n-context'
import { BotLedgerBar } from './BotLedgerBar'

function bot(needsYou: number): BotSummary {
    return {
        id: 'bot-1',
        name: 'Release manager',
        purpose: '',
        machineId: 'm1',
        homeDir: '~/.hapi/bots/release-manager',
        agent: 'claude',
        model: null,
        permissionMode: 'default',
        homeChatSessionId: 'home-1',
        state: 'active',
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        machineOnline: true,
        homeChatActive: false,
        counts: { needsYou, working: 0, workers: 0 }
    }
}

describe('BotLedgerBar', () => {
    it('toggles the ledger and shows what waits on the owner', () => {
        const onToggle = vi.fn()
        const view = render(<I18nProvider><BotLedgerBar bot={bot(2)} active={false} onToggle={onToggle} /></I18nProvider>)
        const bar = screen.getByRole('button', { name: 'Open ledger' })
        expect(bar).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByTestId('bot-ledger-bar-badge')).toHaveTextContent('2')
        fireEvent.click(bar)
        expect(onToggle).toHaveBeenCalledTimes(1)

        view.rerender(<I18nProvider><BotLedgerBar bot={bot(0)} active onToggle={onToggle} /></I18nProvider>)
        expect(screen.getByRole('button', { name: 'Close ledger' })).toHaveAttribute('aria-expanded', 'true')
        expect(screen.queryByTestId('bot-ledger-bar-badge')).toBeNull()
    })
})

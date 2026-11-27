import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionHeader } from './SessionHeader'

afterEach(cleanup)

function session(): Session {
    return {
        id: 'home-1',
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { flavor: 'claude', path: '/Users/me/.hapi/bots/rel', host: 'mac' },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null
    }
}

function ui(props: { onToggleLedger?: () => void; ledgerActive?: boolean; ledgerBadge?: number }) {
    return (
        <QueryClientProvider client={new QueryClient()}>
            <ToastProvider>
                <I18nProvider>
                    <SessionHeader session={session()} onBack={vi.fn()} api={null} {...props} />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

describe('SessionHeader ledger toggle', () => {
    it('is absent on an ordinary session', () => {
        render(ui({}))
        expect(screen.queryByTestId('session-header-ledger')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Open ledger' })).toBeNull()
    })

    it('opens and closes the ledger, and shows what waits on the owner', () => {
        const onToggleLedger = vi.fn()
        const view = render(ui({ onToggleLedger, ledgerBadge: 3 }))
        const toggle = screen.getByRole('button', { name: 'Open ledger' })
        expect(toggle).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByTestId('session-header-ledger-badge')).toHaveTextContent('3')
        fireEvent.click(toggle)
        expect(onToggleLedger).toHaveBeenCalledTimes(1)

        view.rerender(ui({ onToggleLedger, ledgerActive: true, ledgerBadge: 0 }))
        expect(screen.getByRole('button', { name: 'Close ledger' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.queryByTestId('session-header-ledger-badge')).toBeNull()
    })
})

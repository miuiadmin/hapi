import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

vi.mock('@/hooks/queries/useFeatures', () => ({
    useFeatures: () => ({
        features: {
            githubPrAwareness: { enabled: true, envControlled: false },
            prChipDisplay: undefined
        },
        isLoading: false,
        error: null
    })
}))

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-session-preview-limit')
    localStorage.removeItem('hapi-pin-in-progress-sessions')
})

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        activeTaskCount: 0,
        nextTaskRunAt: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('SessionList PR chip', () => {
    it('renders the interactive PR chip inside the trailing cluster, left of the time label, opening the PR on tap', async () => {
        const onSelect = vi.fn()
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
        render(
            <QueryClientProvider
                client={new QueryClient({
                    defaultOptions: {
                        queries: { retry: false },
                        mutations: { retry: false }
                    }
                })}
            >
                <ToastProvider>
                    <I18nProvider>
                        <SessionList
                            sessions={[makeSession({
                                id: 'sess-pr',
                                metadata: {
                                    path: '/tmp/demo',
                                    name: 'PR linked session',
                                    externalRefs: [{
                                        kind: 'github_pr',
                                        repo: 'tiann/hapi',
                                        number: 1163,
                                        url: 'https://github.com/tiann/hapi/pull/1163',
                                        role: 'primary',
                                        source: 'user',
                                        linkedAt: 1
                                    }]
                                }
                            })]}
                            selectedSessionId={null}
                            onSelect={onSelect}
                            onNewSession={vi.fn()}
                            onRefresh={vi.fn()}
                            isLoading={false}
                            renderHeader={false}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        // Upstream now starts inactive project groups collapsed.
        fireEvent.click(screen.getByTitle('/tmp/demo'))
        const chip = await screen.findByTestId('session-pr-chip')
        // Nested span-link (a real <a> inside the row <button> would be invalid HTML).
        expect(chip.tagName).toBe('SPAN')
        expect(chip).toHaveAttribute('role', 'link')
        expect(chip).toHaveTextContent(/#1163/)
        // Lives inside the row button's trailing cluster, before the time label
        // (ADR D8) — not as a far-right block that pushed the time off the edge.
        // (The chip sits inside a HoverTooltip wrapper span within the cluster.)
        const rowButton = screen.getByRole('button', { name: /PR linked session/i })
        expect(chip.closest('button')).toBe(rowButton)
        const wrapper = chip.parentElement
        const trailing = wrapper?.parentElement
        expect(trailing).not.toBeNull()
        expect(trailing?.lastElementChild).not.toBe(wrapper)

        fireEvent.click(chip)
        expect(openSpy).toHaveBeenCalledWith('https://github.com/tiann/hapi/pull/1163', '_blank', 'noopener,noreferrer')
        expect(onSelect).not.toHaveBeenCalled()

        // Attention/schedule HoverTooltips use group-focus-visible/session-row;
        // the named group must sit on the focusable row button, not a wrapper div.
        expect(rowButton.className.split(/\s+/)).toContain('group/session-row')
        expect(rowButton.closest('div')?.className.split(/\s+/)).not.toContain('group/session-row')
        openSpy.mockRestore()
    })

    it('keeps quick-action trailing handling on a pinned active row without the old far-right wrapper', async () => {
        render(
            <QueryClientProvider
                client={new QueryClient({
                    defaultOptions: {
                        queries: { retry: false },
                        mutations: { retry: false }
                    }
                })}
            >
                <ToastProvider>
                    <I18nProvider>
                        <SessionList
                            sessions={[makeSession({
                                id: 'sess-pr-pinned',
                                active: true,
                                pinned: true,
                                metadata: {
                                    path: '/tmp/demo',
                                    name: 'Pinned PR session',
                                    externalRefs: [{
                                        kind: 'github_pr',
                                        repo: 'tiann/hapi',
                                        number: 1163,
                                        url: 'https://github.com/tiann/hapi/pull/1163',
                                        role: 'primary',
                                        source: 'user',
                                        linkedAt: 1
                                    }]
                                }
                            })]}
                            selectedSessionId={null}
                            onSelect={vi.fn()}
                            onNewSession={vi.fn()}
                            onRefresh={vi.fn()}
                            isLoading={false}
                            renderHeader={false}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByTitle('/tmp/demo'))
        const chip = await screen.findByTestId('session-pr-chip')
        const row = chip.closest('.session-list-row')
        expect(row).toHaveAttribute('data-quick-action-count', '2')
        // The far-right wrapper is gone; the chip rides the row's trailing
        // cluster which yields to quick actions via `session-row-trailing`.
        expect(screen.queryByTestId('session-pr-chip-wrap')).toBeNull()
        expect(chip.closest('.session-row-trailing')).not.toBeNull()
    })
})

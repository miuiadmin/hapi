import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import type { ChatToolCall } from '@/chat/types'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: vi.fn(),
            selection: vi.fn()
        }
    })
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { PermissionFooter } from './PermissionFooter'

function makeMetadata(flavor: string | null): SessionMetadataSummary {
    return {
        path: '/tmp/project',
        host: 'localhost',
        flavor
    }
}

function makeTool(name: string): ChatToolCall {
    return {
        id: 'tool-1',
        name,
        state: 'pending',
        input: { command: 'rm -rf /tmp/x' },
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        execStartedAt: null,
        execCompletedAt: null,
        description: null,
        permission: {
            id: 'permission-1',
            status: 'pending'
        }
    }
}

function renderFooter(toolName: string, flavor: string | null) {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const denyPermission = vi.fn().mockResolvedValue(undefined)
    render(
        <PermissionFooter
            api={{ approvePermission, denyPermission } as unknown as ApiClient}
            sessionId="session-1"
            metadata={makeMetadata(flavor)}
            tool={makeTool(toolName)}
            disabled={false}
            onDone={vi.fn()}
        />
    )
    return { approvePermission, denyPermission }
}

describe('PermissionFooter dsh one-shot gating', () => {
    // DSH request_permission offers exactly allow-once/reject-once: no durable
    // grants exist on its ACP surface, so the footer must never promise them.
    it.each(['bash', 'edit', 'write', 'apply_patch'])(
        'shows only one-shot allow/deny for dsh %s cards',
        (toolName) => {
            renderFooter(toolName, 'dsh')
            expect(screen.getByRole('button', { name: 'tool.allow' })).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'tool.deny' })).toBeInTheDocument()
            expect(screen.queryByRole('button', { name: 'tool.allowForSession' })).not.toBeInTheDocument()
            expect(screen.queryByRole('button', { name: 'tool.allowAll' })).not.toBeInTheDocument()
        }
    )

    it('posts a one-shot approve (no durable payload) for dsh', async () => {
        const { approvePermission } = renderFooter('bash', 'dsh')
        fireEvent.click(screen.getByRole('button', { name: 'tool.allow' }))
        await waitFor(() => {
            expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1')
        })
    })

    it('keeps the for-session grant for claude sessions (regression guard)', () => {
        renderFooter('Bash', 'claude')
        expect(screen.getByRole('button', { name: 'tool.allowForSession' })).toBeInTheDocument()
    })

    it('keeps the codex yes/for-session/abort row for codex sessions (regression guard)', () => {
        renderFooter('CodexBash', 'codex')
        expect(screen.getByRole('button', { name: 'tool.yes' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'tool.yesForSession' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.allowForSession' })).not.toBeInTheDocument()
    })

    it('still offers allow-all-edits for claude edit tools', () => {
        renderFooter('Edit', 'claude')
        expect(screen.getByRole('button', { name: 'tool.allowAll' })).toBeInTheDocument()
    })
})

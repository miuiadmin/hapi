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

function makeTool(name: string, permissionOverrides: Partial<ChatToolCall['permission']> = {}): ChatToolCall {
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
            status: 'pending',
            ...permissionOverrides
        }
    }
}

function renderFooter(toolName: string, flavor: string | null, permissionOverrides: Partial<ChatToolCall['permission']> = {}) {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const denyPermission = vi.fn().mockResolvedValue(undefined)
    render(
        <PermissionFooter
            api={{ approvePermission, denyPermission } as unknown as ApiClient}
            sessionId="session-1"
            metadata={makeMetadata(flavor)}
            tool={makeTool(toolName, permissionOverrides)}
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

describe('PermissionFooter one-shot gating by offered options', () => {
    // hermes edit-approval and model-confirm cards offer allow_once + deny
    // only (no allow_always kind): the agent cannot express a durable grant,
    // so the footer must not promise one. The gate generalizes the dsh
    // flavor special case to any card whose option list is known.
    const HERMES_ONE_SHOT_OPTIONS = [
        { optionId: 'allow_once', name: 'Allow edit', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ]

    it('hides Allow for session on a hermes one-shot card (no allow_always option)', () => {
        renderFooter('Approve edit: /repo/src/config.ts', 'hermes', { options: HERMES_ONE_SHOT_OPTIONS })
        expect(screen.getByRole('button', { name: 'tool.allow' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'tool.deny' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.allowForSession' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.allowAll' })).not.toBeInTheDocument()
    })

    it('keeps Allow for session when the card offers an allow_always option', () => {
        renderFooter('Deploy script: ./scripts/release.sh', 'hermes', {
            options: [
                { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ]
        })
        expect(screen.getByRole('button', { name: 'tool.allowForSession' })).toBeInTheDocument()
    })

    it('keeps the flavor fallback when the option list is unknown', () => {
        // Legacy/claude cards carry no option list: the pre-existing gates
        // (hidden for dsh, shown otherwise) still apply.
        renderFooter('Bash', 'hermes')
        expect(screen.getByRole('button', { name: 'tool.allowForSession' })).toBeInTheDocument()
    })

    it('keeps the dsh flavor fallback for an empty option list', () => {
        renderFooter('bash', 'dsh', { options: [] })
        expect(screen.queryByRole('button', { name: 'tool.allowForSession' })).not.toBeInTheDocument()
    })

    it('posts a plain deny for a one-shot card (mapped to its deny option id bridge-side)', async () => {
        const { denyPermission } = renderFooter('Approve edit: /repo/.env', 'hermes', { options: HERMES_ONE_SHOT_OPTIONS })
        fireEvent.click(screen.getByRole('button', { name: 'tool.deny' }))
        await waitFor(() => {
            expect(denyPermission).toHaveBeenCalledWith('session-1', 'permission-1')
        })
    })
})

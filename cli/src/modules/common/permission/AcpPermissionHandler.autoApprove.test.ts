import { beforeEach, describe, expect, it, vi } from 'vitest'

type RegisteredHandler = (params: unknown) => Promise<void>

function createHarness() {
    const registered = new Map<string, RegisteredHandler>()
    const client = {
        rpcHandlerManager: {
            registerHandler: vi.fn((method: string, handler: RegisteredHandler) => {
                registered.set(method, handler)
            })
        },
        updateAgentState: vi.fn((fn: (state: unknown) => unknown) => fn({}))
    }
    const backend = {
        onPermissionRequest: vi.fn(),
        respondToPermission: vi.fn(async () => {}),
        cancelPrompt: vi.fn(async () => {})
    }
    return { client, backend, registered }
}

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { AcpPermissionHandler } from './AcpPermissionHandler'
import type { PermissionRequest } from '@/agent/types'

/** berry v0.1.1-alpha.10 request_permission shape: a human-summary title
 * only — the APPROVAL-* toolCallId never correlates with a drained
 * tool_call, so neither kind nor rawInput survives the backend fill. */
const BERRY_TITLE_ONLY_REQUEST: PermissionRequest = {
    id: 'APPROVAL-8f2',
    sessionId: 'session-berry',
    toolCallId: 'APPROVAL-8f2',
    title: 'Prepare the configuration for review',
    options: [
        { optionId: 'allow-once', name: '仅此一次允许', kind: 'allow_once' },
        { optionId: 'reject-once', name: '仅此一次拒绝', kind: 'reject_once' }
    ]
}

function deliverBackendRequest(harness: ReturnType<typeof createHarness>, request: PermissionRequest): void {
    const registrations = (harness.backend.onPermissionRequest as unknown as { mock: { calls: Array<[cb: (r: PermissionRequest) => void]> } })
        .mock.calls
    registrations[registrations.length - 1][0](request)
}

function pendingRequests(handler: AcpPermissionHandler): Record<string, { tool: string }> {
    const calls = (handler as unknown as { client: { updateAgentState: { mock: { calls: Array<[(s: unknown) => unknown]> } } } })
        .client.updateAgentState.mock.calls
    // An auto-approved request never registers pending agent state — no
    // calls at all (or only completion writes) means nothing is queued.
    if (calls.length === 0) {
        return {}
    }
    const state = calls[calls.length - 1][0]({ requests: {} }) as { requests?: Record<string, { tool: string }> }
    return state.requests ?? {}
}

describe('AcpPermissionHandler unclassifiable (title-only) auto-approval', () => {
    let harness: ReturnType<typeof createHarness>

    beforeEach(() => {
        harness = createHarness()
    })

    it('read-only surfaces a title-only berry request instead of auto-approving it', () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'read-only'
        )
        deliverBackendRequest(harness, BERRY_TITLE_ONLY_REQUEST)

        // Fail closed: no auto-approval went back to the agent…
        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()
        // …and the request is queued for the user with the summary as the title.
        const pending = pendingRequests(handler)
        expect(Object.keys(pending)).toEqual(['APPROVAL-8f2'])
        expect(pending['APPROVAL-8f2'].tool).toBe('Prepare the configuration for review')
    })

    it('yolo still approves a title-only berry request for the session', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'yolo'
        )
        deliverBackendRequest(harness, BERRY_TITLE_ONLY_REQUEST)

        expect(harness.backend.respondToPermission).toHaveBeenCalledTimes(1)
        const [sessionId, request, response] = (harness.backend.respondToPermission as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(sessionId).toBe('session-berry')
        expect(request).toBe(BERRY_TITLE_ONLY_REQUEST)
        expect(response).toEqual({ outcome: 'selected', optionId: 'allow-once' })
        // Nothing is left pending for the user.
        expect(Object.keys(pendingRequests(handler))).toEqual([])
    })

    it('keeps read-only auto-approval for requests that fill their fields', () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'read-only'
        )
        // Post-v29.3 correlated dsh shape: kind + rawInput present, so the
        // (non-write) classification still auto-approves in read-only.
        deliverBackendRequest(harness, {
            id: 'call-dsh-1',
            sessionId: 'session-dsh',
            toolCallId: 'call-dsh-1',
            title: 'bash',
            kind: 'other',
            rawInput: { command: 'cat /etc/hosts' },
            options: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
            ]
        })

        expect(harness.backend.respondToPermission).toHaveBeenCalledTimes(1)
        expect(Object.keys(pendingRequests(handler))).toEqual([])
    })

    it('read-only still surfaces a title-only write summary', () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'read-only'
        )
        deliverBackendRequest(harness, {
            ...BERRY_TITLE_ONLY_REQUEST,
            id: 'APPROVAL-9a1',
            toolCallId: 'APPROVAL-9a1',
            title: 'Write the config file'
        })

        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()
        expect(Object.keys(pendingRequests(handler))).toEqual(['APPROVAL-9a1'])
    })
})

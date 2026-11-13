import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

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

async function permissionRpcRespond(harness: ReturnType<typeof createHarness>, payload: unknown): Promise<void> {
    const handler = harness.registered.get(RPC_METHODS.Permission)
    if (!handler) throw new Error('permission RPC handler was not registered')
    await handler(payload)
}

import { AcpPermissionHandler, isAskUserPermissionRequest, isClarifyPermissionRequest, isSensitiveEditPermissionRequest } from './AcpPermissionHandler'
import type { PermissionRequest } from '@/agent/types'

/** hermes acp_adapter/elicitation.py `build_clarify_permission`: one
 * allow_once option per offered choice (optionId `choice-<i>`, the choice
 * text as the option NAME) plus a reject_once Skip (optionId `skip`), on a
 * `clarify-<id>` tool call whose title/rawInput.question is the question. */
function clarifyRequest(choices: string[], question = 'Which database should the migration target?'): PermissionRequest {
    return {
        id: 'clarify-7f3a',
        sessionId: 'session-hermes',
        toolCallId: 'clarify-7f3a',
        title: question,
        kind: 'other',
        rawInput: { question, choices },
        options: [
            ...choices.map((choice, index) => ({
                optionId: `choice-${index}`, kind: 'allow_once', name: choice
            })),
            { optionId: 'skip', kind: 'reject_once', name: 'Skip' }
        ]
    }
}

/** hermes acp_adapter/permissions.py `_build_permission_options` (the
 * ordinary dangerous-command approval card). */
const HERMES_TOOL_APPROVAL_REQUEST: PermissionRequest = {
    id: 'perm-check-12',
    sessionId: 'session-hermes',
    toolCallId: 'perm-check-12',
    title: 'Deploy script: ./scripts/release.sh',
    kind: 'execute',
    rawInput: { command: './scripts/release.sh', description: 'Deploy script' },
    options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
        { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
        { optionId: 'deny_always', kind: 'reject_always', name: 'Deny always' }
    ]
}

/** hermes acp_adapter/edit_approval.py `make_acp_edit_approval_requester`:
 * a one-shot edit approval card (kind edit, no durable grant kinds). */
function editApprovalRequest(path: string): PermissionRequest {
    return {
        id: 'edit-approval-4',
        sessionId: 'session-hermes',
        toolCallId: 'edit-approval-4',
        title: `Approve edit: ${path}`,
        kind: 'edit',
        rawInput: {
            tool: 'write_file',
            arguments: { path, content: 'NEW=true\n' }
        },
        options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' },
            { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
        ]
    }
}

/** hermes gateway_server.py `_model_confirmer`: a one-shot model confirm
 * card (localized non-standard allow name, standard Cancel reject). */
const MODEL_CONFIRM_REQUEST: PermissionRequest = {
    id: 'model-confirm-abc123def456',
    sessionId: 'session-hermes',
    toolCallId: 'model-confirm-abc123def456',
    title: 'Switch to a guarded model: glm-5.3',
    kind: 'other',
    rawInput: { model: 'glm-5.3', provider: 'newapi', guards: ['cost'] },
    options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Switch anyway' },
        { optionId: 'deny', kind: 'reject_once', name: 'Cancel' }
    ]
}

function deliverBackendRequest(harness: ReturnType<typeof createHarness>, request: PermissionRequest): void {
    const registrations = (harness.backend.onPermissionRequest as unknown as { mock: { calls: Array<[cb: (r: PermissionRequest) => void]> } })
        .mock.calls
    registrations[registrations.length - 1][0](request)
}

type PendingEntry = { tool: string; arguments: unknown; options?: Array<{ optionId: string; name: string; kind: string }> }

function pendingEntryAfter(handler: AcpPermissionHandler): { id: string; entry: PendingEntry } | null {
    const calls = (handler as unknown as { client: { updateAgentState: { mock: { calls: Array<[(s: unknown) => unknown]> } } } })
        .client.updateAgentState.mock.calls
    for (let i = calls.length - 1; i >= 0; i -= 1) {
        const state = calls[i][0]({ requests: {} }) as { requests?: Record<string, PendingEntry> }
        const entries = Object.entries(state.requests ?? {})
        if (entries.length > 0) return { id: entries[0][0], entry: entries[0][1] }
    }
    return null
}

describe('clarify shape detection', () => {
    it('detects a multi-choice clarify card', () => {
        expect(isClarifyPermissionRequest(clarifyRequest(['Use staging', 'Use production', 'Abort']))).toBe(true)
    })

    it('detects a single-choice clarify card through the skip marker', () => {
        expect(isClarifyPermissionRequest(clarifyRequest(['Use staging']))).toBe(true)
    })

    it('does not match ordinary hermes tool approvals (durable kinds present)', () => {
        expect(isClarifyPermissionRequest(HERMES_TOOL_APPROVAL_REQUEST)).toBe(false)
    })

    it('does not match the hermes one-shot edit approval card', () => {
        expect(isClarifyPermissionRequest(editApprovalRequest('/repo/src/config.ts'))).toBe(false)
    })

    it('does not match the hermes model-confirm card (standard Cancel reject)', () => {
        expect(isClarifyPermissionRequest(MODEL_CONFIRM_REQUEST)).toBe(false)
    })

    it('does not match other flavors\' one-shot cards (no skip marker)', () => {
        // dsh post-v29.3 correlated shape and berry's title-only shape both
        // offer a single allow_once + reject_once with standard/flavor names.
        expect(isClarifyPermissionRequest({
            id: 'call-dsh-1',
            sessionId: 'session-dsh',
            toolCallId: 'call-dsh-1',
            title: 'edit',
            kind: 'other',
            rawInput: { file_path: '/repo/src/a.ts' },
            options: [
                { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
                { optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' }
            ]
        })).toBe(false)
        expect(isClarifyPermissionRequest({
            id: 'APPROVAL-8f2',
            sessionId: 'session-berry',
            toolCallId: 'APPROVAL-8f2',
            title: 'Prepare the configuration for review',
            options: [
                { optionId: 'allow-once', kind: 'allow_once', name: '仅此一次允许' },
                { optionId: 'reject-once', kind: 'reject_once', name: '仅此一次拒绝' }
            ]
        })).toBe(false)
    })
})

describe('clarify cards ride the ask-user pipeline', () => {
    let harness: ReturnType<typeof createHarness>

    beforeEach(() => {
        harness = createHarness()
    })

    it('yolo never auto-answers a clarify card — it surfaces as a question', () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'yolo'
        )
        deliverBackendRequest(harness, clarifyRequest(['Use staging', 'Use production', 'Abort']))

        // No auto-answer went back to the agent…
        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()
        // …and the card is queued as an ask_user_question whose options are
        // the offered answers.
        const pending = pendingEntryAfter(handler)
        expect(pending).not.toBeNull()
        expect(pending!.id).toBe('clarify-7f3a')
        expect(pending!.entry.tool).toBe('ask_user_question')
        expect(pending!.entry.arguments).toEqual({
            questions: [{
                question: 'Which database should the migration target?',
                header: null,
                multiSelect: false,
                options: [
                    { label: 'Use staging' },
                    { label: 'Use production' },
                    { label: 'Abort' }
                ]
            }]
        })
    })

    it('safe-yolo also surfaces clarify cards instead of auto-answering', () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'safe-yolo'
        )
        deliverBackendRequest(harness, clarifyRequest(['Use staging', 'Use production']))

        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()
        expect(pendingEntryAfter(handler)?.entry.tool).toBe('ask_user_question')
    })

    it('ordinary hermes approval cards still auto-approve in yolo', () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'yolo'
        )
        deliverBackendRequest(harness, HERMES_TOOL_APPROVAL_REQUEST)

        expect(harness.backend.respondToPermission).toHaveBeenCalledTimes(1)
        const [, request, response] = (harness.backend.respondToPermission as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(request).toBe(HERMES_TOOL_APPROVAL_REQUEST)
        // yolo grants for the session → hermes' session-scoped option id.
        expect(response).toEqual({ outcome: 'selected', optionId: 'allow_session' })
        expect(pendingEntryAfter(handler)).toBeNull()
    })

    it('answering choice-2 selects that exact optionId', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, clarifyRequest(['Use staging', 'Use production', 'Abort']))
        const pending = pendingEntryAfter(handler)!

        // hermes' optionIds are 0-based (choice-0..choice-N-1); the third
        // answer is choice-2.
        await permissionRpcRespond(harness, {
            id: pending.id,
            approved: true,
            answers: { '0': ['Abort'] }
        })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-hermes',
            expect.objectContaining({ id: 'clarify-7f3a' }),
            { outcome: 'selected', optionId: 'choice-2' }
        )
    })

    it('maps deny to the skip option (hermes dismissal semantics)', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, clarifyRequest(['Use staging', 'Use production']))
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, { id: pending.id, approved: false, reason: 'not now' })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-hermes',
            expect.anything(),
            { outcome: 'selected', optionId: 'skip' }
        )
    })

    it('falls back to skip when a free-text answer matches no offered choice', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, clarifyRequest(['Use staging', 'Use production']))
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, {
            id: pending.id,
            approved: true,
            answers: { '0': ['use the blue cluster'] }
        })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-hermes',
            expect.anything(),
            { outcome: 'selected', optionId: 'skip' }
        )
    })

    it('a plain approve (no answers) selects the first choice', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, clarifyRequest(['Use staging', 'Use production']))
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, { id: pending.id, approved: true })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-hermes',
            expect.anything(),
            { outcome: 'selected', optionId: 'choice-0' }
        )
    })

    it('cancelAll settles the pending clarify backend request as cancelled', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, clarifyRequest(['Use staging', 'Use production']))

        await handler.cancelAll('Session ended')

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-hermes',
            expect.objectContaining({ id: 'clarify-7f3a' }),
            { outcome: 'cancelled' }
        )
    })

    it('a synthetic ask-user escalation supersedes a pending clarify card and settles its backend request', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, clarifyRequest(['Use staging', 'Use production']))
        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()

        void handler.askUser({ questions: [{ question: 'Retry the deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }] })

        // The clarify card was swept: its agent-side request resolved
        // cancelled (hermes reads that as Skip) so the agent is not left
        // waiting on a card no client can answer anymore.
        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-hermes',
            expect.objectContaining({ id: 'clarify-7f3a' }),
            { outcome: 'cancelled' }
        )
    })
})

describe('pending option forwarding (one-shot footer gating)', () => {
    it('forwards the offered options into the pending agent-state entry', () => {
        const harness = createHarness()
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, editApprovalRequest('/repo/src/config.ts'))

        const pending = pendingEntryAfter(handler)
        expect(pending).not.toBeNull()
        expect(pending!.entry.options).toEqual([
            { optionId: 'allow_once', name: 'Allow edit', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ])
    })

    it('maps Deny on a one-shot card to the deny option id (never deny_always)', async () => {
        const harness = createHarness()
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, editApprovalRequest('/repo/src/config.ts'))
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, { id: pending.id, approved: false })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-hermes',
            expect.anything(),
            { outcome: 'selected', optionId: 'deny' }
        )
    })

    it('still prefers the reject_once option when a reject_always option exists', async () => {
        const harness = createHarness()
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, HERMES_TOOL_APPROVAL_REQUEST)
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, { id: pending.id, approved: false })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-hermes',
            expect.anything(),
            { outcome: 'selected', optionId: 'deny' }
        )
    })
})

describe('sensitive-path valve (hermes force-asks these under auto-approve)', () => {
    function surfaceTest(path: string, mode: 'yolo' | 'safe-yolo'): void {
        const harness = createHarness()
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => mode
        )
        deliverBackendRequest(harness, editApprovalRequest(path))

        // hermes deliberately re-asks sensitive edits even under dont_ask
        // (session policy "...except sensitive paths") — the bridge must not
        // steamroll that with an auto-answer.
        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()
        expect(pendingEntryAfter(handler)?.id).toBe('edit-approval-4')
    }

    it.each([
        ['/repo/.env'],
        ['/repo/config/.env.production'],
        ['/home/u/.ssh/authorized_keys'],
        ['/repo/.git/config'],
        ['/home/u/.ssh/id_rsa'],
        ['/home/u/.ssh/id_ed25519']
    ])('yolo surfaces an edit card touching %s instead of auto-approving', (path) => {
        surfaceTest(path, 'yolo')
    })

    it('safe-yolo surfaces a sensitive edit card', () => {
        surfaceTest('/repo/.env.local', 'safe-yolo')
    })

    it('yolo still auto-approves a non-sensitive edit', () => {
        const harness = createHarness()
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'yolo'
        )
        deliverBackendRequest(harness, editApprovalRequest('/repo/src/config.ts'))

        expect(harness.backend.respondToPermission).toHaveBeenCalledTimes(1)
        const [, , response] = (harness.backend.respondToPermission as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(response).toEqual({ outcome: 'selected', optionId: 'allow_once' })
    })

    it('yolo still auto-approves a non-edit card whose command merely mentions a sensitive path', () => {
        // The valve is scoped to edit-shaped cards (kind edit / write-
        // classified); an execute card referencing .env stays on the
        // existing yolo auto-approval path.
        const harness = createHarness()
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'yolo'
        )
        deliverBackendRequest(harness, {
            ...HERMES_TOOL_APPROVAL_REQUEST,
            title: 'Read config: cat .env',
            rawInput: { command: 'cat .env', description: 'Read config' }
        })

        expect(harness.backend.respondToPermission).toHaveBeenCalledTimes(1)
    })

    it('flags a write-classified card with a Claude-shaped file_path (dsh edit)', () => {
        expect(isSensitiveEditPermissionRequest({
            id: 'call-dsh-9',
            sessionId: 'session-dsh',
            toolCallId: 'call-dsh-9',
            title: 'edit',
            kind: 'other',
            rawInput: { file_path: '/repo/.env', old_string: 'a', new_string: 'b' },
            options: [
                { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
                { optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' }
            ]
        }, 'edit')).toBe(true)
        expect(isSensitiveEditPermissionRequest({
            id: 'call-dsh-10',
            sessionId: 'session-dsh',
            toolCallId: 'call-dsh-10',
            title: 'edit',
            kind: 'other',
            rawInput: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' },
            options: [
                { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
                { optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' }
            ]
        }, 'edit')).toBe(false)
    })
})

/** zcode-acp-server `handleAskUserQuestion` fallback (no elicitation form):
 * ONE request_permission per question whose `toolCall.rawInput` is the
 * ORIGINAL AskUserQuestion input (its `questions` array), whose title is the
 * question text, and whose options are the answer labels — single-select
 * emits one allow_once per label (optionId = label) plus a `__skip__`
 * reject_once; multi-select emits `<label>:yes` allow_once / `<label>:no`
 * reject_once pairs. */
function zcodeAskSingleRequest(labels: string[], question = 'Which deploy strategy should we use?'): PermissionRequest {
    return {
        id: 'ask-abc_0',
        sessionId: 'session-zcode',
        toolCallId: 'ask-abc_0',
        title: question,
        rawInput: {
            questions: [{ question, options: labels.map((label) => ({ label })), multiSelect: false }]
        },
        options: [
            ...labels.map((label) => ({ optionId: label, kind: 'allow_once' as const, name: label })),
            { optionId: '__skip__', kind: 'reject_once' as const, name: 'Skip this question' }
        ]
    }
}

/** Multi-select degradation: one Include/Skip popup PER OPTION (the bridge
 * walks pairs), so a single-label pair is the whole card. */
const ZCODE_ASK_MULTI_PAIR_REQUEST: PermissionRequest = {
    id: 'ask-def_1_0',
    sessionId: 'session-zcode',
    toolCallId: 'ask-def_1_0',
    title: 'Which components?\n— include "Tests"?',
    rawInput: {
        questions: [{
            question: 'Which components?',
            multiSelect: true,
            options: [{ label: 'Tests' }, { label: 'Docs' }]
        }]
    },
    options: [
        { optionId: 'Tests:yes', kind: 'allow_once', name: 'Include Tests' },
        { optionId: 'Tests:no', kind: 'reject_once', name: 'Skip Tests' }
    ]
}

describe('zcode ask-user shape detection', () => {
    it('detects a single-select ask popup through its rawInput.questions', () => {
        expect(isAskUserPermissionRequest(zcodeAskSingleRequest(['Rolling', 'Blue-green']))).toBe(true)
    })

    it('detects the one-label single-select shape the clarify heuristic misses', () => {
        // One allow_once + one reject_once with NO clarify skip marker: the
        // hermes clarify shape does NOT match (its marker is `skip`, zcode
        // uses `__skip__`) — only the questions-array detector catches it.
        expect(isClarifyPermissionRequest(zcodeAskSingleRequest(['Rolling']))).toBe(false)
        expect(isAskUserPermissionRequest(zcodeAskSingleRequest(['Rolling']))).toBe(true)
    })

    it('detects the multi-select include/skip pair popup', () => {
        expect(isClarifyPermissionRequest(ZCODE_ASK_MULTI_PAIR_REQUEST)).toBe(false)
        expect(isAskUserPermissionRequest(ZCODE_ASK_MULTI_PAIR_REQUEST)).toBe(true)
    })

    it('does not match ordinary tool approvals (no questions array)', () => {
        expect(isAskUserPermissionRequest(HERMES_TOOL_APPROVAL_REQUEST)).toBe(false)
        expect(isAskUserPermissionRequest(editApprovalRequest('/repo/src/config.ts'))).toBe(false)
        // A clarify card's rawInput has question (string), not questions.
        expect(isAskUserPermissionRequest(clarifyRequest(['Use staging', 'Use production']))).toBe(false)
    })

    it('does not match an empty or malformed questions array', () => {
        const base = zcodeAskSingleRequest(['Rolling'])
        expect(isAskUserPermissionRequest({ ...base, rawInput: { questions: [] } })).toBe(false)
        expect(isAskUserPermissionRequest({ ...base, rawInput: { questions: [{ noQuestionField: true }] } })).toBe(false)
        expect(isAskUserPermissionRequest({ ...base, rawInput: null })).toBe(false)
    })
})

describe('zcode ask popups ride the ask-user pipeline', () => {
    let harness: ReturnType<typeof createHarness>

    beforeEach(() => {
        harness = createHarness()
    })

    it('yolo never auto-answers an ask popup — it surfaces as a question', () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'yolo'
        )
        deliverBackendRequest(harness, zcodeAskSingleRequest(['Rolling', 'Blue-green']))

        // No auto-answer went back to the agent…
        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()
        // …and the popup is queued as an ask_user_question whose question is
        // the popup title and whose options are the answer labels.
        const pending = pendingEntryAfter(handler)
        expect(pending).not.toBeNull()
        expect(pending!.id).toBe('ask-abc_0')
        expect(pending!.entry.tool).toBe('ask_user_question')
        expect(pending!.entry.arguments).toEqual({
            questions: [{
                question: 'Which deploy strategy should we use?',
                header: null,
                multiSelect: false,
                options: [{ label: 'Rolling' }, { label: 'Blue-green' }]
            }]
        })
    })

    it('safe-yolo also surfaces ask popups instead of auto-answering', () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => 'safe-yolo'
        )
        deliverBackendRequest(harness, zcodeAskSingleRequest(['Rolling']))

        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()
        expect(pendingEntryAfter(handler)?.entry.tool).toBe('ask_user_question')
    })

    it('answering a label selects that exact optionId', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, zcodeAskSingleRequest(['Rolling', 'Blue-green']))
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, {
            id: pending.id,
            approved: true,
            answers: { '0': ['Blue-green'] }
        })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-zcode',
            expect.objectContaining({ id: 'ask-abc_0' }),
            { outcome: 'selected', optionId: 'Blue-green' }
        )
    })

    it('answering the multi-select include pair selects its yes optionId', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, ZCODE_ASK_MULTI_PAIR_REQUEST)
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, {
            id: pending.id,
            approved: true,
            answers: { '0': ['Include Tests'] }
        })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-zcode',
            expect.objectContaining({ id: 'ask-def_1_0' }),
            { outcome: 'selected', optionId: 'Tests:yes' }
        )
    })

    it('maps deny to the __skip__ option (zcode skip semantics)', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, zcodeAskSingleRequest(['Rolling', 'Blue-green']))
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, { id: pending.id, approved: false, reason: 'not now' })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-zcode',
            expect.anything(),
            { outcome: 'selected', optionId: '__skip__' }
        )
    })

    it('falls back to __skip__ when a free-text answer matches no offered choice', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, zcodeAskSingleRequest(['Rolling', 'Blue-green']))
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, {
            id: pending.id,
            approved: true,
            answers: { '0': ['canary, slowly'] }
        })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-zcode',
            expect.anything(),
            { outcome: 'selected', optionId: '__skip__' }
        )
    })

    it('a plain approve (no answers) selects the first label', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, zcodeAskSingleRequest(['Rolling', 'Blue-green']))
        const pending = pendingEntryAfter(handler)!

        await permissionRpcRespond(harness, { id: pending.id, approved: true })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-zcode',
            expect.anything(),
            { outcome: 'selected', optionId: 'Rolling' }
        )
    })

    it('cancelAll settles the pending ask popup as cancelled', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, zcodeAskSingleRequest(['Rolling']))

        await handler.cancelAll('Session ended')

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-zcode',
            expect.objectContaining({ id: 'ask-abc_0' }),
            { outcome: 'cancelled' }
        )
    })

    it('a synthetic ask-user escalation supersedes a pending ask popup and settles its backend request', async () => {
        const handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
        deliverBackendRequest(harness, zcodeAskSingleRequest(['Rolling']))
        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()

        void handler.askUser({ questions: [{ question: 'Retry the deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }] })

        // The popup was swept: its agent-side request resolved cancelled (the
        // bridge reads that as skip) so the agent is not left waiting on a
        // card no client can answer anymore.
        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'session-zcode',
            expect.objectContaining({ id: 'ask-abc_0' }),
            { outcome: 'cancelled' }
        )
    })
})

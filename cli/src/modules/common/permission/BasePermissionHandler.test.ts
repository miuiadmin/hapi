import { describe, expect, it } from 'vitest'
import {
    isUnclassifiablePermissionRequest,
    resolveToolAutoApprovalDecision
} from './BasePermissionHandler'
import { deriveToolName } from '@/agent/utils'

describe('resolveToolAutoApprovalDecision skill_lookup', () => {
    it.each([
        'skill_lookup',
        'hapi_skill_lookup',
        'happy__skill_lookup',
        'mcp__hapi__skill_lookup'
    ])('auto-approves the exact read-only HAPI tool name %s', (toolName) => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            toolName,
            'call-1'
        )).toBe('approved')
    })

    it('does not approve another tool solely from a skill-looking call id', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_tool',
            'skill_lookup-forged-id'
        )).toBeNull()
    })

    it('does not approve another tool whose name only contains skill_lookup', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'skill_lookup_write_file',
            'call-1'
        )).toBeNull()
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_skill_lookup',
            'call-2'
        )).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision tagged bridge names (hermes editor MCP)', () => {
    it.each([
        'mcp__editor_hapi_1a2b3c4d__ask_user_question',
        'mcp__editor_hapi_9f8e7d6c__skill_lookup',
        'mcp__editor_hapi_abcdef01__list_peers',
        'editor_hapi__ask_user_question'
    ])('auto-approves the allowlisted tool as a __ segment of %s', (toolName) => {
        // Hermes scopes editor MCP servers per session, so the derived tool
        // name carries the tagged bridge form — the allowlist entry must
        // match as a '__'-delimited segment.
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBe('approved')
    })

    it('does not approve a tagged name whose segments are not allowlisted', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'mcp__editor_hapi_1a2b3c4d__delete_everything',
            'call-1'
        )).toBeNull()
        expect(resolveToolAutoApprovalDecision(
            'read-only',
            'mcp__editor_hapi_1a2b3c4d__edit',
            'call-2'
        )).toBeNull()
    })

    it('derives the tagged name from a hermes "<name>: <preview>" title end to end', () => {
        const derived = deriveToolName({
            title: 'mcp__editor_hapi_1a2b3c4d__ask_user_question: Which database should I use?'
        })
        expect(derived).toBe('mcp__editor_hapi_1a2b3c4d__ask_user_question')
        expect(resolveToolAutoApprovalDecision('default', derived, 'perm-check-1')).toBe('approved')
    })
})

describe('resolveToolAutoApprovalDecision ping_peer', () => {
    it.each([
        'ping_peer',
        'mcp__hapi__ping_peer',
        'hapi_ping_peer',
        'Ping Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'ping_peer',
        'mcp__hapi__ping_peer',
        'hapi_ping_peer',
        'Ping Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })

    it('still auto-approves unrelated read tools in read-only mode', () => {
        expect(resolveToolAutoApprovalDecision('read-only', 'Read', 'call-1')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('read-only', 'grep', 'call-2')).toBe('approved')
    })
})

describe('resolveToolAutoApprovalDecision inspect_peer', () => {
    it.each([
        'inspect_peer',
        'mcp__hapi__inspect_peer',
        'hapi_inspect_peer',
        'Inspect Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'inspect_peer',
        'mcp__hapi__inspect_peer',
        'hapi_inspect_peer',
        'Inspect Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision list_peers', () => {
    it.each([
        'list_peers',
        'hapi_list_peers',
        'happy__list_peers',
        'mcp__hapi__list_peers',
        'List Peer Sessions'
    ])('auto-approves the exact discovery tool name %s', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBe('approved')
    })

    it('does not approve another tool whose name only contains list_peers', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'list_peers_and_write',
            'call-1'
        )).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision read-only fail-closed (unclassifiable tools)', () => {
    it.each(['Tool', 'Unknown', 'Other', 'other', 'unknown', ''])(
        'does not auto-approve the placeholder name %j in read-only mode',
        (toolName) => {
            expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
        }
    )

    it('keeps prompting (not auto-approving) for unclassifiable tools in default mode', () => {
        expect(resolveToolAutoApprovalDecision('default', 'Tool', 'call-1')).toBeNull()
    })

    it('keeps safe-yolo auto-approval for unclassifiable tools', () => {
        expect(resolveToolAutoApprovalDecision('safe-yolo', 'Tool', 'call-1')).toBe('approved')
    })

    it('keeps yolo session approval for unclassifiable tools', () => {
        expect(resolveToolAutoApprovalDecision('yolo', 'Tool', 'call-1')).toBe('approved_for_session')
    })

    it('still auto-approves classifiable read/execute tools in read-only mode', () => {
        expect(resolveToolAutoApprovalDecision('read-only', 'Read', 'call-1')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('read-only', 'bash', 'call-2')).toBe('approved')
    })

    it('still denies write-looking tools in read-only mode', () => {
        expect(resolveToolAutoApprovalDecision('read-only', 'edit', 'call-1')).toBeNull()
        expect(resolveToolAutoApprovalDecision('read-only', 'apply_patch', 'call-2')).toBeNull()
    })

    it('fails closed for an uncorrelated dsh permission request but approves the correlated one', () => {
        // dsh session/request_permission carries only {toolCallId}; without
        // correlation the derived name is the anonymous placeholder.
        const uncorrelatedName = deriveToolName({ title: undefined, kind: undefined, rawInput: undefined })
        expect(uncorrelatedName).toBe('Tool')
        expect(resolveToolAutoApprovalDecision('read-only', uncorrelatedName, 'call_dsh_1')).toBeNull()

        // Correlated against the drained tool_call, the request is classifiable
        // again and read-only keeps its existing semantics (non-write tool).
        const correlatedName = deriveToolName({
            title: 'bash',
            kind: 'other',
            rawInput: { command: 'cat /etc/hosts' }
        })
        expect(resolveToolAutoApprovalDecision('read-only', correlatedName, 'call_dsh_1')).toBe('approved')
    })
})

describe('resolveToolAutoApprovalDecision read-only fail-closed (title-only unclassifiable requests)', () => {
    // berry shape: request_permission carries a human-summary title only —
    // its APPROVAL-* toolCallId never correlates, so no kind and no rawInput
    // survive the fill. The title is prose, not a tool classification.
    it('does not auto-approve a title-only request in read-only mode even when the title lacks write-words', () => {
        // 'Prepare the config for review' reads read-only-ish but says
        // nothing about the underlying tool — it may well be a write.
        expect(resolveToolAutoApprovalDecision(
            'read-only',
            'Prepare the config for review',
            'APPROVAL-1',
            undefined,
            { unclassifiable: true }
        )).toBeNull()
    })

    it('keeps denying title-only write summaries in read-only mode', () => {
        expect(resolveToolAutoApprovalDecision(
            'read-only',
            'Write config file',
            'APPROVAL-2',
            undefined,
            { unclassifiable: true }
        )).toBeNull()
    })

    it('still auto-approves title-only requests in yolo mode', () => {
        expect(resolveToolAutoApprovalDecision(
            'yolo',
            'Prepare the config for review',
            'APPROVAL-3',
            undefined,
            { unclassifiable: true }
        )).toBe('approved_for_session')
    })

    it('still auto-approves title-only requests in safe-yolo mode', () => {
        expect(resolveToolAutoApprovalDecision(
            'safe-yolo',
            'Prepare the config for review',
            'APPROVAL-4',
            undefined,
            { unclassifiable: true }
        )).toBe('approved')
    })

    it('keeps prompting (not auto-approving) for title-only requests in default mode', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'Prepare the config for review',
            'APPROVAL-5',
            undefined,
            { unclassifiable: true }
        )).toBeNull()
    })

    it('keeps the explicit safe-name allowlist ahead of the unclassifiable gate', () => {
        // The exact allowlist is an explicit safety list, not a heuristic:
        // ask_user_question must stay auto-approved (a deny would surface a
        // second prompt under the question card) even for a title-only
        // request.
        expect(resolveToolAutoApprovalDecision(
            'read-only',
            'ask_user_question',
            'APPROVAL-6',
            undefined,
            { unclassifiable: true }
        )).toBe('approved')
    })

    it('leaves classifiable requests on the existing title semantics in read-only mode', () => {
        // Flavors that DO fill the request fields keep the title write-hint
        // classification: no classification signal, identical outcomes.
        expect(resolveToolAutoApprovalDecision('read-only', 'Prepare the config for review', 'call-1')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('read-only', 'Prepare the config for review', 'call-1', undefined, {})).toBe('approved')
        expect(resolveToolAutoApprovalDecision('read-only', 'Prepare the config for review', 'call-1', undefined, { unclassifiable: false })).toBe('approved')
    })
})

describe('isUnclassifiablePermissionRequest', () => {
    it('marks requests with neither kind nor rawInput as unclassifiable', () => {
        expect(isUnclassifiablePermissionRequest({})).toBe(true)
        expect(isUnclassifiablePermissionRequest({ kind: undefined, rawInput: undefined })).toBe(true)
        expect(isUnclassifiablePermissionRequest({ kind: '   ', rawInput: null })).toBe(true)
    })

    it('treats any kind or rawInput presence as classifiable', () => {
        // 'other' is a real (placeholder) kind the correlated dsh requests
        // carry — presence is what matters, the value feeds the name lookup.
        expect(isUnclassifiablePermissionRequest({ kind: 'other' })).toBe(false)
        expect(isUnclassifiablePermissionRequest({ kind: 'edit' })).toBe(false)
        expect(isUnclassifiablePermissionRequest({ rawInput: { command: 'ls' } })).toBe(false)
        expect(isUnclassifiablePermissionRequest({ kind: undefined, rawInput: {} })).toBe(false)
    })
})

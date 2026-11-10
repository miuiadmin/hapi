import { describe, expect, it } from 'vitest'
import { resolveToolAutoApprovalDecision } from './BasePermissionHandler'
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

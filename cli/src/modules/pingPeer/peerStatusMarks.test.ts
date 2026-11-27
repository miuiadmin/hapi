import { describe, expect, it, vi } from 'vitest'
import {
    extractPendingRequests,
    formatInspectPeerReport,
    formatPeerSessionState,
    formatPeerSessionsList,
    hasBackgroundTasks,
    hasPendingRequests,
    inspectPeer,
    type PeerSessionListEntry
} from './pingPeer'

const SESSION = 'worker-1111-1111-1111-111111111111'

function row(overrides: Partial<PeerSessionListEntry> = {}): PeerSessionListEntry {
    return { id: 'aaaaaaaa-1111-1111-1111-111111111111', active: true, updatedAt: 1, metadata: { name: 'A', flavor: 'claude' }, ...overrides }
}

describe('list_peers status marks', () => {
    it('detects pending requests from the list summary or the full row, and background tasks', () => {
        expect(hasPendingRequests({ pendingRequestsCount: 0 })).toBe(false)
        expect(hasPendingRequests({ pendingRequestsCount: 2 })).toBe(true)
        expect(hasPendingRequests({ pendingRequests: [{ id: 'r' }] })).toBe(true)
        expect(hasPendingRequests({ agentState: { requests: { r1: { tool: 'Bash' } } } })).toBe(true)
        expect(hasPendingRequests({ agentState: { requests: {} } })).toBe(false)
        expect(hasPendingRequests({ agentState: null })).toBe(false)
        expect(hasBackgroundTasks({ backgroundTaskCount: 0 })).toBe(false)
        expect(hasBackgroundTasks({ backgroundTaskCount: 1 })).toBe(true)
        expect(hasBackgroundTasks({})).toBe(false)
    })

    it('renders the marks right after busy / idle / inactive', () => {
        expect(formatPeerSessionState(row({ thinking: true }))).toBe('busy')
        expect(formatPeerSessionState(row({ thinking: true, pendingRequestsCount: 1 }))).toBe('busy [waiting]')
        expect(formatPeerSessionState(row({ thinking: true, backgroundTaskCount: 2 }))).toBe('busy [background]')
        expect(formatPeerSessionState(row({ thinking: false, pendingRequestsCount: 1, backgroundTaskCount: 2 }))).toBe('idle [waiting] [background]')
        expect(formatPeerSessionState(row({ active: false, pendingRequestsCount: 1 }))).toBe('inactive [waiting]')
    })

    it('marks the rows in the shortlist and keeps unmarked rows as before', () => {
        const text = formatPeerSessionsList([
            row({ id: 'aaaaaaaa-0000-0000-0000-000000000001', updatedAt: 3, thinking: true, pendingRequestsCount: 1 }),
            row({ id: 'aaaaaaaa-0000-0000-0000-000000000002', updatedAt: 2, thinking: true, backgroundTaskCount: 1, agentState: { requests: { r: { tool: 'Write' } } } }),
            row({ id: 'aaaaaaaa-0000-0000-0000-000000000003', updatedAt: 1, machineLabel: 'studio' })
        ])
        const lines = text.split('\n')
        expect(lines[0]).toContain('busy [waiting]  flavor=claude')
        expect(lines[1]).toContain('busy [waiting] [background]  flavor=claude')
        expect(lines[2]).toMatch(/^  aaaaaaaa-0000-0000-0000-000000000003  idle  flavor=claude  machine=studio/)
    })
})

describe('inspect_peer pending requests', () => {
    it('extracts requests oldest-first with their tool names', () => {
        expect(extractPendingRequests({
            requests: {
                'req-b': { tool: 'AskUserQuestion', createdAt: 20 },
                'req-a': { tool: 'Bash', createdAt: 10 },
                'req-c': { tool: 'Write' }
            }
        })).toEqual([
            { id: 'req-a', tool: 'Bash', createdAt: 10 },
            { id: 'req-b', tool: 'AskUserQuestion', createdAt: 20 },
            { id: 'req-c', tool: 'Write', createdAt: null }
        ])
        expect(extractPendingRequests(null)).toEqual([])
        expect(extractPendingRequests({ requests: null })).toEqual([])
    })

    it('lists them in the report with the peer-answer recipe, or says none', () => {
        const report = formatInspectPeerReport({
            sessionId: SESSION,
            name: 'Worker',
            active: true,
            thinking: false,
            flavor: 'claude',
            path: '/tmp/x',
            machine: 'studio',
            lifecycleState: null,
            updatedAt: 1_700_000_000_000,
            pendingRequests: [{ id: 'req-1', tool: 'Bash', createdAt: 1_700_000_000_000 }],
            messages: []
        })
        expect(report).toContain('pending requests (waiting on an answer): 1')
        expect(report).toContain('  - id req-1  tool Bash since 2023-11-14T22:13:20.000Z')
        expect(report).toContain(`answer with: hapi peer-answer ${SESSION} <request id>`)
        const quiet = formatInspectPeerReport({
            sessionId: SESSION, name: 'Worker', active: true, thinking: false, flavor: 'claude', path: null,
            machine: null, lifecycleState: null, updatedAt: null, messages: []
        })
        expect(quiet).toContain('pending requests (waiting on an answer): 0')
        expect(quiet).not.toContain('answer with:')
    })

    it('reads them from the session row during inspectPeer', async () => {
        const http = {
            post: vi.fn(async (url: string) => {
                if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
                throw new Error(`unexpected POST ${url}`)
            }),
            get: vi.fn(async (url: string) => {
                if (url.endsWith('/api/sessions')) return { status: 200, data: { sessions: [{ id: SESSION, active: true }] } }
                if (url.endsWith(`/api/sessions/${SESSION}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION, active: true, thinking: false, updatedAt: 1,
                                metadata: { name: 'Coding', flavor: 'codex' },
                                agentState: { requests: { 'req-9': { tool: 'request_user_input', arguments: {}, createdAt: 5 } } }
                            }
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${SESSION}/messages`)) return { status: 200, data: { messages: [], page: { hasMore: false } } }
                if (url.endsWith('/api/machines')) return { status: 200, data: { machines: [] } }
                throw new Error(`unexpected GET ${url}`)
            })
        }
        const result = await inspectPeer({ sessionIdPrefix: SESSION, accessToken: 'tok', apiUrl: 'http://hub.test', http: http as never })
        expect(result.pendingRequests).toEqual([{ id: 'req-9', tool: 'request_user_input', createdAt: 5 }])
    })
})

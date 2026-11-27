import { describe, expect, it } from 'vitest'
import {
    BOT_HAPI_CLI_ALLOWED_TOOLS,
    BOT_HAPI_PEER_TOOL_NAMES,
    botPeerMcpAllowedTools,
    withBotCliAllowedTools
} from './allowedTools'

describe('bot allowed tools', () => {
    it('is exactly the harmless hapi shell families — no job, no git, no ping-peer / spawn-peer', () => {
        expect([...BOT_HAPI_CLI_ALLOWED_TOOLS]).toEqual([
            'Bash(hapi --help)',
            'Bash(hapi -v)',
            'Bash(hapi --version)',
            'Bash(hapi item:*)',
            'Bash(hapi task:*)',
            'Bash(hapi inspect-peer:*)',
            'Bash(hapi peer-answer:*)'
        ])
        // Each of these can read a file, run a command, or deliver into another session.
        for (const banned of ['hapi job', 'git ', 'hapi ping-peer', 'hapi spawn-peer', 'hapi runner', 'hapi mcp']) {
            expect(BOT_HAPI_CLI_ALLOWED_TOOLS.some((rule) => rule.startsWith(`Bash(${banned}`))).toBe(false)
        }
        expect([...BOT_HAPI_PEER_TOOL_NAMES]).toEqual(['spawn_peer', 'ping_peer', 'inspect_peer'])
    })

    it('names the peer MCP tools only when the session registered them', () => {
        expect(botPeerMcpAllowedTools()).toEqual(['mcp__hapi__spawn_peer', 'mcp__hapi__ping_peer', 'mcp__hapi__inspect_peer'])
        expect(botPeerMcpAllowedTools(['list_peers', 'ping_peer', 'session_job'])).toEqual(['mcp__hapi__ping_peer'])
        expect(botPeerMcpAllowedTools([])).toEqual([])
    })

    it('appends the peer tools and the shell rules for a bot session and leaves an ordinary session unchanged', () => {
        const base = ['mcp__hapi__list_peers', 'mcp__hapi__session_job']
        const registered = ['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer', 'session_job']
        expect(withBotCliAllowedTools(base, true, { registeredToolNames: registered })).toEqual([
            ...base,
            'mcp__hapi__spawn_peer',
            'mcp__hapi__ping_peer',
            'mcp__hapi__inspect_peer',
            ...BOT_HAPI_CLI_ALLOWED_TOOLS
        ])
        expect(withBotCliAllowedTools(base, false, { registeredToolNames: registered })).toEqual(base)
    })

    it('advertises no stale peer tool when the session has peer tools off', () => {
        const result = withBotCliAllowedTools(['mcp__hapi__session_job'], true, { registeredToolNames: ['session_job'] })
        expect(result).toEqual(['mcp__hapi__session_job', ...BOT_HAPI_CLI_ALLOWED_TOOLS])
        expect(result.filter((rule) => rule.startsWith('mcp__hapi__'))).toEqual(['mcp__hapi__session_job'])
    })

    it('returns a new array, de-duplicates and tolerates an empty base', () => {
        const base = ['Bash(hapi item:*)']
        const result = withBotCliAllowedTools(base, true)
        expect(result.filter((rule) => rule === 'Bash(hapi item:*)')).toHaveLength(1)
        expect(result).toHaveLength(BOT_HAPI_PEER_TOOL_NAMES.length + BOT_HAPI_CLI_ALLOWED_TOOLS.length)
        expect(base).toEqual(['Bash(hapi item:*)'])
        expect(withBotCliAllowedTools([], false)).toEqual([])
        expect(withBotCliAllowedTools([], true)).toHaveLength(BOT_HAPI_PEER_TOOL_NAMES.length + BOT_HAPI_CLI_ALLOWED_TOOLS.length)
    })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as claudeSdk from '@/claude/sdk'
import type { SDKMessage } from '@/claude/sdk/types'

// The remote launch path: `runClaude` → `loop({ allowedTools })` →
// `Session.allowedTools` → `claudeRemoteLauncher` → `claudeRemote` → the SDK
// `allowedTools` option. A bot's home chat carries hapi's own shell commands
// pre-approved; an ordinary session carries only the MCP tools. (Wildcard
// acceptance by a real Claude Code build is not exercised here.)

vi.mock('@/claude/utils/compactSummaryLookup', () => ({
    findLatestCompactSummary: vi.fn(async () => null)
}))

vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}))

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}))

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}))

import { BOT_HAPI_CLI_ALLOWED_TOOLS, botPeerMcpAllowedTools, withBotCliAllowedTools } from '@/modules/bot/allowedTools'

const REGISTERED = ['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer', 'session_job']
const BASE = ['mcp__hapi__list_peers', 'mcp__hapi__session_job']

function createAsyncStream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const message of messages) {
                await Promise.resolve()
                yield message
            }
        }
    }
}

describe('claudeRemote allowedTools for a bot home chat', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    async function runWith(allowedTools: string[]): Promise<string[]> {
        const queryMock = vi.fn()
        const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as unknown as typeof claudeSdk.query)
        queryMock.mockReturnValueOnce(createAsyncStream([
            { type: 'result', subtype: 'success' } as unknown as SDKMessage,
            { type: 'result', subtype: 'success' } as unknown as SDKMessage
        ]))
        const { claudeRemote } = await import('./claudeRemote')
        let calls = 0
        try {
            await claudeRemote({
                sessionId: 'session-1',
                path: process.cwd(),
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [],
                allowedTools,
                hookSettingsPath: '/tmp/hook.json',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                nextMessage: async () => calls++ === 0
                    ? { message: 'hapi item list', mode: { permissionMode: 'default' } }
                    : null,
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                onFirstResult: () => {}
            })
        } finally {
            querySpy.mockRestore()
        }
        expect(queryMock).toHaveBeenCalledTimes(1)
        const options = (queryMock.mock.calls[0] as unknown as [{ options: { allowedTools?: string[] } }])[0].options
        return options.allowedTools ?? []
    }

    it('hands the peer MCP tools and the hapi shell rules to the SDK allowedTools for a bot session', async () => {
        const passed = await runWith(withBotCliAllowedTools(BASE, true, { registeredToolNames: REGISTERED }))
        expect(passed).toEqual([...BASE, 'mcp__hapi__spawn_peer', 'mcp__hapi__ping_peer', 'mcp__hapi__inspect_peer', ...BOT_HAPI_CLI_ALLOWED_TOOLS])
        expect(passed).toContain('Bash(hapi --help)')
        expect(passed).toContain('Bash(hapi inspect-peer:*)')
        expect(passed).not.toContain('Bash(hapi spawn-peer:*)')
    })

    it('hands only the auto-approved MCP tools for an ordinary session', async () => {
        const passed = await runWith(withBotCliAllowedTools(BASE, false, { registeredToolNames: REGISTERED }))
        expect(passed).toEqual(BASE)
        for (const rule of [...BOT_HAPI_CLI_ALLOWED_TOOLS, ...botPeerMcpAllowedTools()]) expect(passed).not.toContain(rule)
    })
})

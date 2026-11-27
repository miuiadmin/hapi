import { beforeEach, describe, expect, it, vi } from 'vitest'

// The local launch path: whatever `runClaude` hands to `loop({ allowedTools })`
// reaches `claudeLocal` as `opts.allowedTools` and becomes one `--allowedTools`
// flag. A bot's home chat carries hapi's own shell commands pre-approved; an
// ordinary session carries only the MCP tools. (Wildcard acceptance by a real
// Claude Code build is not exercised here.)

const harness = vi.hoisted(() => ({
    spawn: vi.fn(async (_opts: unknown) => {})
}))

vi.mock('node:fs', () => ({
    mkdirSync: vi.fn()
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() }
}))

vi.mock('./utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}))

vi.mock('./utils/path', () => ({
    getProjectPath: () => '/tmp/claude-project'
}))

vi.mock('./utils/mcpConfig', () => ({
    appendMcpConfigArg: () => undefined
}))

vi.mock('./utils/systemPrompt', () => ({
    getSystemPrompt: () => 'HAPI system prompt'
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

vi.mock('@/utils/spawnWithTerminalGuard', () => ({
    spawnWithTerminalGuard: harness.spawn
}))

vi.mock('@/constants/uploadPaths', () => ({
    getHapiBlobsDir: () => '/tmp/hapi-blobs'
}))

vi.mock('@/utils/shellEscape', () => ({
    stripNewlinesForWindowsShellArg: (value: string) => value
}))

vi.mock('./sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}))

import { claudeLocal } from './claudeLocal'
import { BOT_HAPI_CLI_ALLOWED_TOOLS, botPeerMcpAllowedTools, withBotCliAllowedTools } from '@/modules/bot/allowedTools'

const REGISTERED = ['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer', 'session_job']
const BASE = ['mcp__hapi__list_peers', 'mcp__hapi__session_job']

function spawnArgs(): string[] {
    const call = harness.spawn.mock.calls[0]
    expect(call).toBeDefined()
    return (call[0] as { args: string[] }).args
}

function allowedToolsArg(args: string[]): string[] {
    const index = args.indexOf('--allowedTools')
    return index === -1 ? [] : args[index + 1]!.split(',')
}

describe('claudeLocal allowedTools for a bot home chat', () => {
    beforeEach(() => {
        harness.spawn.mockClear()
    })

    it('passes the peer MCP tools and the hapi shell rules through --allowedTools for a bot session', async () => {
        // The MCP names are what toClaudeAllowedHapiMcpTools produces; the helper is the one runClaude calls.
        const allowedTools = withBotCliAllowedTools(BASE, true, { registeredToolNames: REGISTERED })
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/workspace',
            hookSettingsPath: '/tmp/hooks.json',
            allowedTools
        })

        const passed = allowedToolsArg(spawnArgs())
        expect(passed).toEqual([...BASE, 'mcp__hapi__spawn_peer', 'mcp__hapi__ping_peer', 'mcp__hapi__inspect_peer', ...BOT_HAPI_CLI_ALLOWED_TOOLS])
        expect(passed).toContain('Bash(hapi --help)')
        expect(passed).toContain('Bash(hapi item:*)')
        expect(passed).toContain('Bash(hapi peer-answer:*)')
        expect(passed).not.toContain('Bash(hapi job:*)')
    })

    it('passes only the auto-approved MCP tools for an ordinary session', async () => {
        const allowedTools = withBotCliAllowedTools(BASE, false, { registeredToolNames: REGISTERED })
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/workspace',
            hookSettingsPath: '/tmp/hooks.json',
            allowedTools
        })

        const passed = allowedToolsArg(spawnArgs())
        expect(passed).toEqual(BASE)
        for (const rule of [...BOT_HAPI_CLI_ALLOWED_TOOLS, ...botPeerMcpAllowedTools()]) expect(passed).not.toContain(rule)
    })
})

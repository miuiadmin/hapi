import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiSessionClient } from '@/api/apiSession'
import { applyHubAutoTitlePerTurn, resetAutoTitlePerTurnForTests } from '@/modules/common/titleInstruction'
import { applyHubPeerToolsDisabled, resetPeerToolsForTests } from '@/modules/common/peerTools'
import * as peerMessages from '@/modules/pingPeer/pingPeer'
import * as peerSpawn from '@/modules/spawnPeer/spawnPeer'
import * as botReceipts from '@/modules/bot/receipts'
import * as botItems from '@/modules/bot/items'
import * as botItemMcp from '@/modules/bot/botItemMcp'
import * as botTaskMcp from '@/modules/bot/botTaskMcp'
import { BotClientError } from '@/modules/bot/botClient'
import { startHappyServer, toClaudeAllowedHapiMcpTools } from './startHappyServer'

// The ping_peer core is stubbed so the cross-flip regression can observe the
// snapshot handed to the handler without network access.
vi.mock('@/modules/pingPeer/pingPeer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/modules/pingPeer/pingPeer')>()
    return { ...actual, pingPeer: vi.fn(actual.pingPeer) }
})

type ToolResult = {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
}

describe('startHappyServer skill_lookup', () => {
    const originalHome = process.env.HOME
    let sandboxDir: string
    let workingDirectory: string
    let client: Client | null
    let stopServer: (() => void) | null
    let sendAgentMessage: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-skill-mcp-'))
        workingDirectory = join(sandboxDir, 'repo')
        process.env.HOME = join(sandboxDir, 'home')
        await mkdir(join(workingDirectory, '.git'), { recursive: true })
        await mkdir(process.env.HOME, { recursive: true })
        client = null
        stopServer = null
    })

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }
        await rm(sandboxDir, { recursive: true, force: true })
    })

    async function connect(enableSkillLookup = true): Promise<Client> {
        sendAgentMessage = vi.fn()
        const sessionClient = {
            sessionId: 'parent-id',
            getMetadata: () => ({ name: 'Parent', path: workingDirectory, flavor: 'codex' }),
            updateMetadata: vi.fn(),
            sendAgentMessage,
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, enableSkillLookup
            ? {
                skillLookup: {
                    workingDirectory,
                    flavor: 'opencode'
                }
            }
            : {})
        stopServer = server.stop

        client = new Client(
            { name: 'hapi-skill-lookup-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return client
    }

    it('returns a discovered SKILL.md body', async () => {
        const skillDir = join(workingDirectory, '.agents', 'skills', 'review')
        await mkdir(skillDir, { recursive: true })
        await writeFile(join(skillDir, 'SKILL.md'), [
            '---',
            'name: review',
            'description: Review changes safely',
            '---',
            '',
            '# Review instructions',
            '',
            'Inspect the diff before editing.'
        ].join('\n'))

        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'review' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Skill: review')
        expect(result.content?.[0]?.text).toContain('Description: Review changes safely')
        expect(result.content?.[0]?.text).toContain('# Review instructions')
    })

    it('returns a tool error for an unknown skill', async () => {
        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'missing' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Skill not found: missing')
    })

    it('does not expose the fallback tool to native-skill sessions', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()

        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
            'change_title',
            'display_image',
            'display_media',
            'display_video',
            'inspect_peer',
            'list_peers',
            'ping_peer',
            'session_job',
            'spawn_peer',
        ])
    })

    it('invokes onChangeTitle when change_title succeeds', async () => {
        sendAgentMessage = vi.fn()
        const sessionClient = {
            updateMetadata: vi.fn(),
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage,
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const onChangeTitle = vi.fn()
        const server = await startHappyServer(sessionClient, { onChangeTitle })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-test', version: '1.0.0' })
        client = mcp
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        await mcp.callTool({
            name: 'change_title',
            arguments: { title: '  Manual\n Title  ' }
        })

        expect(onChangeTitle).toHaveBeenCalledWith('Manual Title')
        expect(sessionClient.flushMetadata).toHaveBeenCalledTimes(2)
    })

    it('does not invoke onChangeTitle when the metadata update fails', async () => {
        sendAgentMessage = vi.fn()
        const updateMetadata = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage,
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const onChangeTitle = vi.fn()
        const server = await startHappyServer(sessionClient, { onChangeTitle })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-test', version: '1.0.0' })
        client = mcp
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        updateMetadata.mockImplementation(() => { throw new Error('update failed') })
        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: 'Manual Title' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(onChangeTitle).not.toHaveBeenCalled()
    })

    it.each([
        { title: '   ', options: {}, isError: true },
        { title: 'Child Title', options: { emitTitleSummary: false }, isError: false }
    ])('does not rename or mark manual precedence for $title with $options', async ({ title, options, isError }) => {
        const updateMetadata = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const onChangeTitle = vi.fn()
        const server = await startHappyServer(sessionClient, { ...options, onChangeTitle })
        stopServer = server.stop
        client = new Client({ name: 'hapi-title-test', version: '1.0.0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        updateMetadata.mockClear()
        const result = await client.callTool({ name: 'change_title', arguments: { title } }) as ToolResult

        expect(result.isError).toBe(isError)
        expect(updateMetadata).not.toHaveBeenCalled()
        expect(onChangeTitle).not.toHaveBeenCalled()
    })

    it('describes display_image as user output rather than image input', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()
        const displayImage = tools.tools.find((tool) => tool.name === 'display_image')

        expect(displayImage?.description).toContain('human user')
        expect(displayImage?.description).toContain('does not provide image input to the model')
        expect(displayImage?.description).toContain('cannot be used to read, inspect, or analyze image contents')
    })

    it('exposes concise delivery contracts for all media tools', async () => {
        const mcp = await connect(false)
        const { tools } = await mcp.listTools()
        for (const name of ['display_image', 'display_video', 'display_media']) {
            const description = tools.find(tool => tool.name === name)?.description
            expect(description).toContain('absolute filesystem path')
            expect(description).toContain('25 MiB')
            expect(description).toContain('explicit delivery preferences')
            expect(description).not.toContain('Web/PWA')
            expect(description).not.toContain('iOS')
        }
    })

    it.each([
        [undefined, 'accepted'],
        [undefined, 'steered'],
        ['auto', 'accepted'],
        ['auto', 'steered'],
        ['auto', 'invoked'],
        ['queue', 'accepted'],
        ['steer', 'steered'],
        ['steer', 'invoked']
    ] as const)('forwards ping_peer mode %s and reports %s through MCP', async (deliveryMode, delivery) => {
        const ping = vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({
            sessionId: 'peer-id', name: 'Peer', resumed: false,
            localId: 'ping-peer-test', delivery
        })
        try {
            const mcp = await connect(false)
            const tools = await mcp.listTools()
            const tool = tools.tools.find((entry) => entry.name === 'ping_peer')
            expect(tool?.inputSchema.properties?.deliveryMode).toMatchObject({ enum: ['auto', 'queue', 'steer'] })
            expect(tool?.description).toContain('auto (default)')
            const result = await mcp.callTool({
                name: 'ping_peer',
                arguments: { sessionIdPrefix: 'peer-id', message: 'hello', ...(deliveryMode ? { deliveryMode } : {}) }
            }) as ToolResult
            expect(result.isError).toBe(false)
            expect(ping).toHaveBeenCalledWith({ sessionIdPrefix: 'peer-id', message: 'hello', deliveryMode, wake: false, peerToolsDisabled: false })
            expect(result.content?.[0]?.text).toBe(delivery === 'accepted'
                ? 'Accepted for peer-id (Peer) localId=ping-peer-test — delivery shows in the recipient chat when its runtime consumes it'
                : `${delivery} to peer-id (Peer) localId=ping-peer-test`)
        } finally {
            ping.mockRestore()
        }
    })

    it.each([
        'steer not attempted: target is idle',
        'steer rejected by hub: Session not found',
        'steer not confirmed; delivery unresolved: Steer outcome is being reconciled'
    ])('appends the auto steer note to an accepted ping_peer receipt without claiming nothing was sent: %s', async (steerNote) => {
        const ping = vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({
            sessionId: 'peer-id', name: 'Peer', resumed: false,
            localId: 'ping-peer-test', delivery: 'accepted', steerNote
        })
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'ping_peer', arguments: { sessionIdPrefix: 'peer-id', message: 'hello' }
            }) as ToolResult
            expect(result.isError).toBe(false)
            expect(result.content?.[0]?.text).toBe(
                `Accepted for peer-id (Peer) localId=ping-peer-test — delivery shows in the recipient chat when its runtime consumes it (${steerNote})`)
            expect(result.content?.[0]?.text).not.toMatch(/no message sent/i)
        } finally {
            ping.mockRestore()
        }
    })

    it('forwards ping_peer wake only when explicitly requested', async () => {
        const ping = vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({
            sessionId: 'peer-id', name: 'Peer', resumed: true,
            localId: 'ping-peer-test', delivery: 'accepted'
        })
        try {
            const mcp = await connect(false)
            const tools = await mcp.listTools()
            const tool = tools.tools.find((entry) => entry.name === 'ping_peer')
            expect(tool?.inputSchema.properties?.wake).toMatchObject({ type: 'boolean' })
            expect(tool?.description).toContain('Never broadcast')
            const result = await mcp.callTool({
                name: 'ping_peer',
                arguments: { sessionIdPrefix: 'peer-id', message: 'take over the build', wake: true }
            }) as ToolResult
            expect(result.isError).toBe(false)
            expect(ping).toHaveBeenCalledWith({
                sessionIdPrefix: 'peer-id', message: 'take over the build', deliveryMode: undefined, wake: true, peerToolsDisabled: false
            })
            expect(result.content?.[0]?.text).toContain('(resumed)')
        } finally {
            ping.mockRestore()
        }
    })

    it('forwards inspect_peer through MCP and returns the formatted report', async () => {
        const inspect = vi.spyOn(peerMessages, 'inspectPeer').mockResolvedValue({} as Awaited<ReturnType<typeof peerMessages.inspectPeer>>)
        const format = vi.spyOn(peerMessages, 'formatInspectPeerReport').mockReturnValue('INSPECT REPORT')
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'inspect_peer',
                arguments: { sessionIdPrefix: 'peer-id', messageLimit: 12 },
            }) as ToolResult
            expect(inspect).toHaveBeenCalledWith({ sessionIdPrefix: 'peer-id', messageLimit: 12, peerToolsDisabled: false })
            expect(format).toHaveBeenCalledOnce()
            expect(result.isError).toBe(false)
            expect(result.content?.[0]?.text).toBe('INSPECT REPORT')
        } finally {
            inspect.mockRestore()
            format.mockRestore()
        }
    })

    it('lists active peers by default and forwards includeInactive', async () => {
        const list = vi.spyOn(peerMessages, 'listPeerSessions').mockResolvedValue([])
        try {
            const mcp = await connect(false)
            await mcp.callTool({ name: 'list_peers', arguments: {} })
            expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ includeInactive: false }))
            await mcp.callTool({ name: 'list_peers', arguments: { includeInactive: true } })
            expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ includeInactive: true }))
        } finally {
            list.mockRestore()
        }
    })

    it('rejects invalid ping_peer delivery modes at the MCP boundary', async () => {
        const ping = vi.spyOn(peerMessages, 'pingPeer')
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'ping_peer', arguments: { sessionIdPrefix: 'peer-id', message: 'hello', deliveryMode: 'interrupt' }
            }) as ToolResult
            expect(result.isError).toBe(true)
            expect(ping).not.toHaveBeenCalled()
        } finally {
            ping.mockRestore()
        }
    })

    it('forwards the spawned peer\'s reply when waitForReply is set', async () => {
        const spawn = vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue({
            sessionId: 'child-id', name: 'Worker', localId: 'ping-peer-1', flavor: 'codex'
        })
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue()
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'spawn_peer',
                arguments: { directory: '/srv/project', message: 'Run the tests', waitForReply: true },
            }) as ToolResult
            expect(result.content?.[0]?.text).toBe('Spawned child-id (Worker); its reply will be posted here')
            expect(forward).toHaveBeenCalledWith({ peerSessionId: 'child-id', taskLocalId: 'ping-peer-1', callerSessionId: 'parent-id' })
        } finally {
            spawn.mockRestore()
            forward.mockRestore()
        }
    })

    it('forwards cross-machine spawn settings with the calling session identity and cwd', async () => {
        const spawn = vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue({
            sessionId: 'child-id', name: 'Worker', flavor: 'codex'
        })
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'spawn_peer',
                arguments: {
                    directory: '/srv/project',
                    message: 'Run the tests',
                    machine: 'remote-host',
                    agent: 'codex',
                    model: 'gpt-5.6-sol',
                    effort: 'high',
                    permissionMode: 'default',
                },
            }) as ToolResult
            expect(result.isError).toBe(false)
            expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
                directory: '/srv/project',
                cwd: workingDirectory,
                message: 'Run the tests',
                machine: 'remote-host',
                agent: 'codex',
                model: 'gpt-5.6-sol',
                effort: 'high',
                permissionMode: 'default',
                parent: { sessionId: 'parent-id', name: 'Parent', agentSessionId: null },
                requireParent: true,
            }))
        } finally {
            spawn.mockRestore()
        }
    })

    it('displays audio through display_media and emits a generated media message', async () => {
        const path = join(sandboxDir, 'sample.wav')
        await writeFile(path, Buffer.from('RIFFxxxxWAVE'))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'display_media',
            arguments: { path, title: 'sample.wav' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Displayed media: sample.wav')
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'generated-image',
            fileName: 'sample.wav',
            mimeType: 'audio/wav',
            source: { ingress: 'mcp', toolName: 'display_media' }
        }))
    })

    it('preserves the source extension when display_media title omits one', async () => {
        const path = join(sandboxDir, 'plan-a.zip')
        await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'display_media',
            arguments: { path, title: 'Cursor Plan A Markdown 导出' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Displayed media: Cursor Plan A Markdown 导出.zip')
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'generated-image',
            fileName: 'Cursor Plan A Markdown 导出.zip',
            mimeType: 'application/octet-stream',
            source: { ingress: 'mcp', toolName: 'display_media' }
        }))
    })

    it('does not expose change_title when native ACP titles are enabled', async () => {
        const sessionClient = {
            sessionId: 'test-session-id',
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, { enableChangeTitle: false })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-test', version: '1.0.0' })
        client = mcp

        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const tools = await mcp.listTools()

        expect(server.toolNames).toEqual([
            'link_pr',
            'display_image',
            'display_video',
            'display_media',
            'list_peers',
            'ping_peer',
            'inspect_peer',
            'spawn_peer',
            'session_job',
        ])
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
            'display_image',
            'display_media',
            'display_video',
            'inspect_peer',
            'list_peers',
            'ping_peer',
            'session_job',
            'spawn_peer',
        ])
    })

})

describe('startHappyServer ask_user_question', () => {
    let client: Client | null
    let stopServer: (() => void) | null
    let escalated: unknown[]

    afterEach(async () => {
        await client?.close()
        stopServer?.()
    })

    async function connect(options?: Parameters<typeof startHappyServer>[1]): Promise<Client> {
        escalated = []
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, options)
        stopServer = server.stop
        client = new Client(
            { name: 'hapi-ask-user-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return client
    }

    it('answers in-band with the DSH-shaped answer batch', async () => {
        const mcp = await connect({
            askUserTool: {
                escalate: async (input) => {
                    escalated.push(input)
                    return {
                        status: 'answered',
                        answers: [
                            { id: 'target', selected: ['Staging (Recommended)'] },
                            { id: 'notes', selected: [], custom: 'ship at 6pm' }
                        ]
                    }
                }
            }
        })
        const result = await mcp.callTool({
            name: 'ask_user_question',
            arguments: {
                questions: [
                    { id: 'target', question: 'Deploy where?', options: [{ label: 'Staging (Recommended)' }, { label: 'Production' }] },
                    { id: 'notes', question: 'Notes?' }
                ]
            }
        }) as ToolResult
        expect(escalated).toHaveLength(1)
        expect((escalated[0] as { questions: unknown[] }).questions).toHaveLength(2)
        expect(result.isError).toBeFalsy()
        expect(JSON.parse(result.content![0]!.text!)).toEqual({
            answers: [
                { id: 'target', selected: ['Staging (Recommended)'] },
                { id: 'notes', selected: [], custom: 'ship at 6pm' }
            ]
        })
    })

    it('maps a denied escalation onto DSH skip semantics, not an error', async () => {
        const mcp = await connect({
            askUserTool: { escalate: async () => ({ status: 'denied', reason: 'user dismissed' }) }
        })
        const result = await mcp.callTool({
            name: 'ask_user_question',
            arguments: { questions: [{ id: 'q', question: 'Proceed?' }] }
        }) as ToolResult
        expect(result.isError).toBeFalsy()
        expect(result.content![0]!.text).toContain('skipped')
        expect(result.content![0]!.text).toContain('user dismissed')
    })


    it('raceAskUserEscalation settles skip semantics when the MCP cancel signal fires', async () => {
        // dsh cannot raise its 60s per-call MCP timeout; on expiry the client
        // sends notifications/cancelled and the handler's extra.signal aborts
        // (SDK chain verified: client cancel -> transport notification ->
        // server _oncancel -> request AbortController). The race must settle
        // immediately on abort — before, during, and after the escalation.
        const { raceAskUserEscalation } = await import('./startHappyServer')
        const parked = Promise.withResolvers<{ status: string }>()

        // Signal aborts while the escalation is parked (the 60s-timeout path).
        const controller = new AbortController()
        const outcome = raceAskUserEscalation(parked.promise, controller.signal)
        controller.abort()
        await expect(outcome).resolves.toEqual({
            status: 'canceled',
            reason: 'the question was cancelled (agent timeout or retry)'
        })

        // Signal already aborted at entry.
        const preAborted = raceAskUserEscalation(parked.promise, AbortSignal.abort())
        await expect(preAborted).resolves.toMatchObject({ status: 'canceled' })

        // No signal: the escalation's own result passes through untouched.
        const answered = raceAskUserEscalation(
            Promise.resolve({ status: 'answered', answers: [] } as { status: string }),
            undefined
        )
        await expect(answered).resolves.toEqual({ status: 'answered', answers: [] })

        // A late rejection from the parked escalation no longer matters.
        parked.reject(new Error('late'))
        await new Promise((resolve) => setTimeout(resolve, 10))
    })

    it('does not register the tool without the option', async () => {
        const mcp = await connect({})
        const listed = await mcp.listTools()
        expect(listed.tools.map((tool) => tool.name)).not.toContain('ask_user_question')
    })

    it('lists ask_user_question in toolNames when enabled', async () => {
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, {
            askUserTool: { escalate: async () => ({ status: 'canceled' }) }
        })
        try {
            expect(server.toolNames).toContain('ask_user_question')
        } finally {
            server.stop()
        }
    })
})

describe('startHappyServer change_title', () => {
    let stopServer: (() => void) | null
    let client: Client | null

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        client = null
        stopServer = null
    })

    async function connectChangeTitleServer(sessionClient: ApiSessionClient, options?: Parameters<typeof startHappyServer>[1]) {
        const server = await startHappyServer(sessionClient, options)
        stopServer = server.stop
        client = new Client(
            { name: 'hapi-change-title-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return client
    }

    it('renames via metadata.name so spawn --name sessions update visibly', async () => {
        const updateMetadata = vi.fn()
        const sendClaudeSessionMessage = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage
        } as unknown as ApiSessionClient

        const mcp = await connectChangeTitleServer(sessionClient)
        updateMetadata.mockClear()
        sendClaudeSessionMessage.mockClear()

        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: '  Renamed triage peer  ' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Successfully changed chat title to: "Renamed triage peer"')
        expect(updateMetadata).toHaveBeenCalledTimes(1)
        const handler = updateMetadata.mock.calls[0]?.[0] as (metadata: {
            path: string
            host: string
            name?: string
            summary?: { text: string }
        }) => {
            path: string
            host: string
            name?: string
            summary?: { text: string }
        }
        expect(handler({
            path: '/tmp',
            host: 'localhost',
            name: 'issue-triage-#54',
            summary: { text: 'stale' }
        })).toEqual({
            path: '/tmp',
            host: 'localhost',
            name: 'Renamed triage peer',
            summary: { text: 'stale' }
        })
        expect(sendClaudeSessionMessage).not.toHaveBeenCalled()
    })

    it.each([false, true])('reports a user lock, including one acquired while the title write is pending (%s)', async (inFlight) => {
        let locked = !inFlight
        const updateMetadata = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: () => ({ path: '/tmp', host: 'localhost', name: 'Pinned', titleLocked: locked }),
            flushMetadata: vi.fn(async () => { locked = true; return true }),
            sendAgentMessage: vi.fn()
        } as unknown as ApiSessionClient
        const onChangeTitle = vi.fn()
        const mcp = await connectChangeTitleServer(sessionClient, { onChangeTitle })
        updateMetadata.mockClear()
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Agent' } }) as ToolResult
        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('locked by the user')
        expect(updateMetadata).toHaveBeenCalledTimes(inFlight ? 1 : 0)
        expect(onChangeTitle).not.toHaveBeenCalled()
    })

    it.each([1, 2])('does not acknowledge a rename when metadata flush %s fails', async (failedFlush) => {
        const onChangeTitle = vi.fn()
        let flushes = 0
        const sessionClient = {
            updateMetadata: vi.fn(),
            refreshMetadata: vi.fn(async () => true),
            getMetadata: () => null,
            flushMetadata: vi.fn(async () => {
                flushes++
                if (flushes === 2) expect(onChangeTitle).toHaveBeenCalledWith('Manual Title')
                return flushes !== failedFlush
            })
        } as unknown as ApiSessionClient
        const mcp = await connectChangeTitleServer(sessionClient, { onChangeTitle })
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Manual Title' } }) as ToolResult
        expect(result.isError).toBe(true)
        expect(flushes).toBe(failedFlush)
        expect(onChangeTitle).toHaveBeenCalledTimes(failedFlush === 1 ? 0 : 1)
    })

    it('reports a user lock acquired while flushing manual-title precedence', async () => {
        let locked = false
        let flushes = 0
        const onChangeTitle = vi.fn()
        const sessionClient = {
            updateMetadata: vi.fn(),
            refreshMetadata: vi.fn(async () => true),
            getMetadata: () => ({ path: '/tmp', host: 'localhost', titleLocked: locked }),
            flushMetadata: vi.fn(async () => { locked = ++flushes === 2; return true })
        } as unknown as ApiSessionClient
        const mcp = await connectChangeTitleServer(sessionClient, { onChangeTitle })
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Manual' } }) as ToolResult
        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('locked by the user')
        expect(onChangeTitle).toHaveBeenCalledTimes(1)
    })

    it('refreshes a stale cached lock before allowing an explicit rename', async () => {
        let locked = true
        const sessionClient = {
            updateMetadata: vi.fn(), refreshMetadata: vi.fn(async () => { locked = false; return true }),
            getMetadata: () => ({ path: '/tmp', host: 'localhost', titleLocked: locked }),
            flushMetadata: vi.fn(async () => true), sendAgentMessage: vi.fn()
        } as unknown as ApiSessionClient
        const mcp = await connectChangeTitleServer(sessionClient)
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Unlocked' } }) as ToolResult
        expect(result.isError).toBe(false)
        expect(sessionClient.refreshMetadata).toHaveBeenCalled()
    })

    it('fails without mutating when the Hub lock cannot be read', async () => {
        const updateMetadata = vi.fn()
        const sessionClient = { updateMetadata, refreshMetadata: vi.fn(async () => false), sendAgentMessage: vi.fn() } as unknown as ApiSessionClient
        const mcp = await connectChangeTitleServer(sessionClient)
        updateMetadata.mockClear()
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Unknown' } }) as ToolResult
        expect(result.isError).toBe(true)
        expect(updateMetadata).not.toHaveBeenCalled()
    })

    it('returns an error for blank titles instead of claiming success', async () => {
        const updateMetadata = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const mcp = await connectChangeTitleServer(sessionClient)
        updateMetadata.mockClear()

        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: '   ' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Failed to change chat title')
        expect(updateMetadata).not.toHaveBeenCalled()
    })

    it('advertises the per-turn description only when the toggle is on', async () => {
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const descriptionOf = async (): Promise<string> => {
            const mcp = await connectChangeTitleServer(sessionClient)
            const listed = await mcp.listTools()
            const description = listed.tools.find((tool) => tool.name === 'change_title')?.description ?? ''
            await client?.close()
            stopServer?.()
            client = null
            stopServer = null
            return description
        }

        try {
            resetAutoTitlePerTurnForTests()
            const off = await descriptionOf()
            expect(off).toContain("Call once when the user's primary objective is clear")
            expect(off).not.toContain('Per-turn mode is enabled')

            applyHubAutoTitlePerTurn(true)
            const on = await descriptionOf()
            expect(on).toContain('Per-turn mode is enabled')
            expect(on).toContain('end of every user turn')
        } finally {
            resetAutoTitlePerTurnForTests()
        }
    })

    it('does not write titles when emitTitleSummary is disabled (Codex child isolation)', async () => {
        const updateMetadata = vi.fn()
        const sendClaudeSessionMessage = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage
        } as unknown as ApiSessionClient

        const mcp = await connectChangeTitleServer(sessionClient, { emitTitleSummary: false })
        updateMetadata.mockClear()
        sendClaudeSessionMessage.mockClear()

        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: 'Child Title' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(updateMetadata).not.toHaveBeenCalled()
        expect(sendClaudeSessionMessage).not.toHaveBeenCalled()
    })
})
describe('toClaudeAllowedHapiMcpTools', () => {
    it('keeps local-path and peer tools registered but out of Claude --allowedTools', () => {
        expect(toClaudeAllowedHapiMcpTools([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'list_peers',
            'ping_peer',
            'inspect_peer',
            'spawn_peer',
            'session_job',
            'skill_lookup'
        ])).toEqual([
            'mcp__hapi__change_title',
            'mcp__hapi__display_image',
            'mcp__hapi__list_peers',
            'mcp__hapi__session_job',
            'mcp__hapi__skill_lookup'
        ])
        expect(toClaudeAllowedHapiMcpTools(['display_video'])).not.toContain('mcp__hapi__display_video')
        expect(toClaudeAllowedHapiMcpTools(['display_media'])).not.toContain('mcp__hapi__display_media')
    })
})

describe('resolveMcpSpawnPeerCwd', () => {
    it('prefers launcher workingDirectory over skillLookup and session path', async () => {
        const { resolveMcpSpawnPeerCwd } = await import('./startHappyServer')
        expect(resolveMcpSpawnPeerCwd({
            workingDirectory: '/launcher/cwd',
            skillWorkingDirectory: '/skill/cwd',
            sessionPath: '/session/path',
        })).toBe('/launcher/cwd')
    })

    it('prefers skillLookup workingDirectory over session metadata path', async () => {
        const { resolveMcpSpawnPeerCwd } = await import('./startHappyServer')
        expect(resolveMcpSpawnPeerCwd({
            skillWorkingDirectory: '/skill/cwd',
            sessionPath: '/session/path',
        })).toBe('/skill/cwd')
    })

    it('falls back to session metadata.path when skillLookup is absent', async () => {
        const { resolveMcpSpawnPeerCwd } = await import('./startHappyServer')
        expect(resolveMcpSpawnPeerCwd({
            skillWorkingDirectory: undefined,
            sessionPath: '/session/path',
        })).toBe('/session/path')
        expect(resolveMcpSpawnPeerCwd({
            skillWorkingDirectory: '  ',
            sessionPath: '  /session/path  ',
        })).toBe('/session/path')
    })

    it('returns undefined when neither cwd source is available', async () => {
        const { resolveMcpSpawnPeerCwd } = await import('./startHappyServer')
        expect(resolveMcpSpawnPeerCwd({})).toBeUndefined()
    })
})

describe('startHappyServer peer tools kill switch', () => {
    const originalFlag = process.env.HAPI_DISABLE_PEER_TOOLS
    let client: Client | null
    let stopServer: (() => void) | null

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        if (originalFlag === undefined) {
            delete process.env.HAPI_DISABLE_PEER_TOOLS
        } else {
            process.env.HAPI_DISABLE_PEER_TOOLS = originalFlag
        }
        resetPeerToolsForTests()
    })

    async function startServer(options: Parameters<typeof startHappyServer>[1] = {}): Promise<{ url: string; toolNames: string[] }> {
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, options)
        stopServer = server.stop
        client = new Client(
            { name: 'hapi-peer-tools-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return { url: server.url, toolNames: server.toolNames }
    }


    it('supports a peer-only explicit tool allowlist', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        const { toolNames } = await startServer({
            enableChangeTitle: false,
            enabledTools: ['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer'],
        })
        expect(toolNames).toEqual(['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer'])
        const tools = await client!.listTools()
        expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer']))
    })

    it('does not let the allowlist bypass HAPI_DISABLE_PEER_TOOLS', async () => {
        process.env.HAPI_DISABLE_PEER_TOOLS = '1'
        await expect(startServer({
            enableChangeTitle: false,
            enabledTools: ['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer'],
        })).rejects.toThrow('startHappyServer requires at least one enabled tool')
    })
    it('registers peer tools by default', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        const { toolNames } = await startServer()
        expect(toolNames).toEqual(expect.arrayContaining(['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer']))
        const tools = await client!.listTools()
        const names = tools.tools.map((tool) => tool.name)
        expect(names).toEqual(expect.arrayContaining(['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer']))
    })

    it('omits peer tools from registration and toolNames when HAPI_DISABLE_PEER_TOOLS is set', async () => {
        process.env.HAPI_DISABLE_PEER_TOOLS = '1'
        const { toolNames } = await startServer()
        // session_job is own-session (not peer) — stays available when peer tools are off.
        expect(toolNames).toEqual([
            'change_title',
            'link_pr',
            'display_image',
            'display_video',
            'display_media',
            'session_job',
        ])
        const tools = await client!.listTools()
        const names = tools.tools.map((tool) => tool.name)
        expect(names).not.toContain('list_peers')
        expect(names).not.toContain('ping_peer')
        expect(names).not.toContain('inspect_peer')
        expect(names).not.toContain('spawn_peer')
        expect(names).toEqual(expect.arrayContaining([
            'display_image',
            'display_video',
            'display_media',
            'session_job',
        ]))
    })

    it('omits peer tools from registration and toolNames when the hub preference disables them', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        applyHubPeerToolsDisabled(true)
        const { toolNames } = await startServer()
        expect(toolNames).toEqual(['change_title', 'link_pr', 'display_image', 'display_video', 'display_media', 'session_job'])
        const tools = await client!.listTools()
        const names = tools.tools.map((tool) => tool.name)
        expect(names).not.toContain('list_peers')
        expect(names).not.toContain('ping_peer')
        expect(names).not.toContain('inspect_peer')
    })

    it('keeps handlers registered by an enabled session working after a later session flips the global switch (#2056)', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        const { pingPeer } = await import('@/modules/pingPeer/pingPeer')
        vi.mocked(pingPeer).mockRejectedValueOnce(new Error('offline in test'))

        // Session A bootstraps with peer tools enabled (create-time snapshot).
        const sessionClient = {
            peerToolsDisabled: false,
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, {})
        stopServer = server.stop
        client = new Client(
            { name: 'hapi-peer-flip-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        // Session B bootstraps elsewhere in the same process and flips the
        // module-wide preference. A's registered handlers must keep working.
        applyHubPeerToolsDisabled(true)

        const result = await client.callTool({
            name: 'ping_peer',
            arguments: { sessionIdPrefix: 'abc123', message: 'hello' }
        }) as ToolResult
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).not.toContain('peer session tools are disabled')
        // The handler resolved the guard from A's captured snapshot, not the
        // flipped module state.
        expect(pingPeer).toHaveBeenCalledWith(expect.objectContaining({
            sessionIdPrefix: 'abc123',
            peerToolsDisabled: false
        }))
    })
})

describe('startHappyServer bot tools and replyVia', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    const CHILD = 'child-1111-1111-1111-111111111111'
    const HOME = 'home-1111-1111-1111-111111111111'

    function sessionClient(extra: Record<string, unknown> = {}): ApiSessionClient {
        return {
            sessionId: HOME,
            peerToolsDisabled: false,
            getMetadata: () => ({ name: 'Ops', path: '/home/ops/.hapi/bots/ops', flavor: 'claude' }),
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            ...extra
        } as unknown as ApiSessionClient
    }

    async function connect(client: ApiSessionClient) {
        const server = await startHappyServer(client, {})
        const mcp = new Client({ name: 'hapi-bot-test', version: '1.0.0' }, { capabilities: {} })
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return { mcp, server }
    }

    it('registers bot_item / bot_task only for a bot home chat', async () => {
        const plain = await connect(sessionClient())
        const plainTools = (await plain.mcp.listTools()).tools.map((tool) => tool.name)
        expect(plain.server.toolNames).not.toContain('bot_item')
        expect(plain.server.toolNames).not.toContain('bot_task')
        expect(plainTools).not.toContain('bot_item')
        await plain.mcp.close()
        plain.server.stop()

        const bot = await connect(sessionClient({ botId: 'bot-1' }))
        expect(bot.server.toolNames).toEqual(expect.arrayContaining(['bot_item', 'bot_task']))
        const botTools = (await bot.mcp.listTools()).tools
        expect(botTools.find((tool) => tool.name === 'bot_item')?.inputSchema.properties?.action).toMatchObject({
            enum: ['add', 'set', 'ask', 'comment', 'list', 'show', 'done']
        })
        expect(botTools.find((tool) => tool.name === 'bot_task')?.inputSchema.properties?.action).toMatchObject({
            enum: ['add', 'list', 'pause', 'resume', 'delete']
        })
        // Hub REST on the bot's own records: auto-approved like session_job.
        expect(toClaudeAllowedHapiMcpTools(bot.server.toolNames)).toEqual(expect.arrayContaining(['mcp__hapi__bot_item', 'mcp__hapi__bot_task']))
        await bot.mcp.close()
        bot.server.stop()
    })

    it('routes bot_item and bot_task to the handlers with the session identity', async () => {
        const item = vi.spyOn(botItemMcp, 'handleBotItemTool').mockResolvedValue({ text: 'ITEM TEXT', isError: false })
        const task = vi.spyOn(botTaskMcp, 'handleBotTaskTool').mockResolvedValue({ text: 'TASK TEXT', isError: true })
        const { mcp, server } = await connect(sessionClient({ botId: 'bot-1' }))
        try {
            const itemResult = await mcp.callTool({ name: 'bot_item', arguments: { action: 'list' } }) as ToolResult
            expect(item).toHaveBeenCalledWith({ action: 'list' }, { botId: 'bot-1', sessionId: HOME })
            expect(itemResult).toEqual({ content: [{ type: 'text', text: 'ITEM TEXT' }], isError: false })
            const taskResult = await mcp.callTool({ name: 'bot_task', arguments: { action: 'list' } }) as ToolResult
            expect(task).toHaveBeenCalledWith({ action: 'list' }, { botId: 'bot-1', sessionId: HOME })
            expect(taskResult.isError).toBe(true)
        } finally {
            await mcp.close()
            server.stop()
        }
    })

    it("replyVia 'hub' registers a receipt instead of forwarding in-process, for any flavor", async () => {
        const ping = vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({ sessionId: CHILD, name: 'Worker', resumed: false, localId: 'ping-peer-1', delivery: 'accepted', flavor: 'hermes' })
        const register = vi.spyOn(botReceipts, 'registerReceipt').mockResolvedValue({ id: 'r1' } as never)
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue(undefined)
        const { mcp, server } = await connect(sessionClient())
        try {
            const result = await mcp.callTool({ name: 'ping_peer', arguments: { sessionIdPrefix: CHILD, message: 'hello', replyVia: 'hub' } }) as ToolResult
            expect(register).toHaveBeenCalledWith(CHILD, { parentSessionId: HOME, taskLocalId: 'ping-peer-1', kind: 'turn_end' })
            expect(forward).not.toHaveBeenCalled()
            expect(result.isError).toBe(false)
            expect(result.content?.[0]?.text).toBe('Accepted for child-1111-1111-1111-111111111111 (Worker) localId=ping-peer-1 — delivery shows in the recipient chat when its runtime consumes it; the hub will post its reply here when its turn ends')
        } finally {
            await mcp.close()
            server.stop()
        }
    })

    it('replyVia beats waitForReply, and defaults to the hub receipt in a bot home chat', async () => {
        vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({ sessionId: CHILD, name: 'Worker', resumed: false, localId: 'ping-peer-1', delivery: 'accepted', flavor: 'codex' })
        const register = vi.spyOn(botReceipts, 'registerReceipt').mockResolvedValue({ id: 'r1' } as never)
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue(undefined)
        const { mcp, server } = await connect(sessionClient({ botId: 'bot-1' }))
        try {
            await mcp.callTool({ name: 'ping_peer', arguments: { sessionIdPrefix: CHILD, message: 'a', waitForReply: true, replyVia: 'hub' } })
            expect(register).toHaveBeenCalledTimes(1)
            expect(forward).not.toHaveBeenCalled()
            await mcp.callTool({ name: 'ping_peer', arguments: { sessionIdPrefix: CHILD, message: 'b' } })
            expect(register).toHaveBeenCalledTimes(2)
            expect(forward).not.toHaveBeenCalled()
            const caller = await mcp.callTool({ name: 'ping_peer', arguments: { sessionIdPrefix: CHILD, message: 'c', replyVia: 'caller' } }) as ToolResult
            expect(register).toHaveBeenCalledTimes(2)
            expect(forward).toHaveBeenCalledWith({ peerSessionId: CHILD, taskLocalId: 'ping-peer-1', callerSessionId: HOME })
            expect(caller.content?.[0]?.text).toContain('; its reply will be posted here')
        } finally {
            await mcp.close()
            server.stop()
        }
    })

    it("falls back to the in-process watch when the hub refuses the receipt", async () => {
        vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({ sessionId: CHILD, name: 'Worker', resumed: false, localId: 'ping-peer-1', delivery: 'accepted', flavor: 'codex' })
        vi.spyOn(botReceipts, 'registerReceipt').mockRejectedValue(new BotClientError('request_failed', 'register reply receipt failed: HTTP 404', 404))
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue(undefined)
        const { mcp, server } = await connect(sessionClient({ botId: 'bot-1' }))
        try {
            const result = await mcp.callTool({ name: 'ping_peer', arguments: { sessionIdPrefix: CHILD, message: 'a' } }) as ToolResult
            expect(forward).toHaveBeenCalledWith({ peerSessionId: CHILD, taskLocalId: 'ping-peer-1', callerSessionId: HOME })
            expect(result.content?.[0]?.text).toContain('; hub receipt registration failed (register reply receipt failed: HTTP 404) — falling back to this session\'s hapi process: its reply will be posted here')
        } finally {
            await mcp.close()
            server.stop()
        }
    })

    it('opens workers with the worker contract and a hub receipt in a bot home chat, and attaches --item', async () => {
        const spawn = vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue({ sessionId: CHILD, name: 'Worker', localId: 'ping-peer-1', flavor: 'codex' })
        const register = vi.spyOn(botReceipts, 'registerReceipt').mockResolvedValue({ id: 'r1' } as never)
        const update = vi.spyOn(botItems, 'updateItem').mockResolvedValue({ number: 7, status: 'working', title: 'Ship it' } as never)
        const { mcp, server } = await connect(sessionClient({ botId: 'bot-1' }))
        try {
            const result = await mcp.callTool({ name: 'spawn_peer', arguments: { directory: '/srv/project', message: 'Run the tests', item: 7 } }) as ToolResult
            expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
                requireParent: true,
                workerContract: { botId: 'bot-1', botName: 'Ops' }
            }))
            expect(update).toHaveBeenCalledWith({ botId: 'bot-1', itemId: 7, fromSessionId: HOME, body: { workerSessionId: CHILD } })
            expect(register).toHaveBeenCalledWith(CHILD, { parentSessionId: HOME, taskLocalId: 'ping-peer-1', kind: 'turn_end' })
            expect(result.content?.[0]?.text).toBe('Spawned child-1111-1111-1111-111111111111 (Worker); attached to item #7 [working] Ship it; the hub will post its reply here when its turn ends')
        } finally {
            await mcp.close()
            server.stop()
        }
    })

    it('an unknown registration outcome is retried once and never doubled by an in-process watch', async () => {
        vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({ sessionId: CHILD, name: 'Worker', resumed: false, localId: 'ping-peer-1', delivery: 'accepted', flavor: 'codex' })
        const register = vi.spyOn(botReceipts, 'registerReceipt')
            .mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'))
            .mockRejectedValueOnce(new BotClientError('request_failed', 'register reply receipt failed: HTTP 503', 503))
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue(undefined)
        const { mcp, server } = await connect(sessionClient({ botId: 'bot-1' }))
        try {
            const result = await mcp.callTool({ name: 'ping_peer', arguments: { sessionIdPrefix: CHILD, message: 'a' } }) as ToolResult
            expect(register).toHaveBeenCalledTimes(2)
            expect(forward).not.toHaveBeenCalled()
            expect(result.content?.[0]?.text).toContain('; receipt registration outcome unknown (register reply receipt failed: HTTP 503), so the reply may or may not be posted back')
        } finally {
            await mcp.close()
            server.stop()
        }
    })

    it('refuses spawn_peer with item outside a bot home chat before spawning anything', async () => {
        const spawn = vi.spyOn(peerSpawn, 'spawnPeer')
        const { mcp, server } = await connect(sessionClient())
        try {
            const result = await mcp.callTool({ name: 'spawn_peer', arguments: { directory: '/srv/project', message: 'Run the tests', item: 7 } }) as ToolResult
            expect(result.isError).toBe(true)
            expect(result.content?.[0]?.text).toContain("item can only be attached by a bot's home chat")
            expect(spawn).not.toHaveBeenCalled()
        } finally {
            await mcp.close()
            server.stop()
        }
    })

    it('keeps ordinary sessions free of the worker contract and of receipts', async () => {
        const spawn = vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue({ sessionId: CHILD, name: 'Worker', flavor: 'codex' })
        const register = vi.spyOn(botReceipts, 'registerReceipt')
        const { mcp, server } = await connect(sessionClient())
        try {
            const result = await mcp.callTool({ name: 'spawn_peer', arguments: { directory: '/srv/project', message: 'Run the tests' } }) as ToolResult
            expect(spawn).toHaveBeenCalledWith(expect.not.objectContaining({ workerContract: expect.anything() }))
            expect(register).not.toHaveBeenCalled()
            expect(result.content?.[0]?.text).toBe('Spawned child-1111-1111-1111-111111111111 (Worker)')
        } finally {
            await mcp.close()
            server.stop()
        }
    })
})

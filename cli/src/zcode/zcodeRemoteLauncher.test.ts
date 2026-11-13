import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { ZcodeMode } from './types'

const GLM = 'zhipu\\glm-5.3'
const GLM_AIR = 'zhipu\\glm-5.3-air'
const HAPI_ROW_ID = 'hapi-zcode-row-1'

const harness = vi.hoisted(() => ({
    // Latest created backend; `backends` records every creation in order so
    // respawn tests can tell the dead backend from its replacement apart.
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    backends: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
    createCalls: [] as Array<{ env?: unknown; opts?: { acpMode?: string } }>,
    newSessionConfig: null as unknown,
    resumeConfig: null as unknown,
    prompts: [] as unknown[][],
    promptErrorQueue: [] as unknown[],
    initializeErrorQueue: [] as unknown[],
    resumeError: null as Error | null,
    resumeSupported: true,
    authError: null as Error | null,
    titleListener: null as ((update: { title?: unknown }) => void) | null,
    modelOption: null as {
        id: string
        category?: string
        currentValue?: string
        options?: Array<{ value: string; name?: string }>
    } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    setModeCalls: [] as Array<{ sessionId: string; modeId: string; syncThoughtLevel?: boolean }>,
    setModeError: null as Error | null,
    // Captured current-mode listener of the latest backend.
    modeListener: null as ((update: { sessionId: string | null; currentModeId: string }) => void) | null,
    // What the (mocked) backend reports as the session's current mode.
    currentMode: null as string | null,
    // Whether the (mocked) backend advertises promptCapabilities.image.
    imagePrompts: false as boolean,
    // askUser escalations routed through the permission handler mock.
    askUserCalls: [] as unknown[],
    askUserOutcome: null as unknown,
    // When set, newSession() parks on this promise — lets tests query the
    // catalog RPC while session/new is still pending.
    newSessionBlocker: null as null | Promise<void>,
    // When non-empty, each prompt() call parks on the next entry (shifted
    // off the front) AFTER recording — lets tests act between batches.
    promptBlockerQueue: [] as Array<Promise<void>>,
    // Recorded by the buildZcodePromptContent mock.
    promptContentInputs: [] as Array<{
        text: string
        images: unknown[] | undefined
        sessionId: string | undefined
    }>,
    // Captured constructor args of AcpPermissionHandler.
    permissionHandlerArgs: [] as unknown[][]
}))

vi.mock('./utils/zcodeBackend', () => ({
    createZcodeBackend: vi.fn((env?: unknown, opts?: { acpMode?: string }) => {
        harness.createCalls.push({ env, opts })
        const backend = {
            initialize: vi.fn(async () => {
                if (harness.initializeErrorQueue.length > 0) {
                    const error = harness.initializeErrorQueue.shift()
                    if (error) throw error
                }
            }),
            authenticate: vi.fn(async () => {
                if (harness.authError) throw harness.authError
            }),
            supportsSessionResume: vi.fn(() => harness.resumeSupported),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                if (harness.newSessionBlocker) {
                    await harness.newSessionBlocker
                }
                return 'zcode-session-1'
            }),
            resumeSession: vi.fn(async (config: { sessionId: string }) => {
                harness.resumeConfig = config
                if (harness.resumeError) throw harness.resumeError
                return config.sessionId
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                // Record every attempt (failed ones too) so respawn tests can
                // prove the SAME batch was retried.
                harness.prompts.push(content)
                const blocker = harness.promptBlockerQueue.shift()
                if (blocker) {
                    await blocker
                }
                if (harness.promptErrorQueue.length > 0) {
                    const error = harness.promptErrorQueue.shift()
                    if (error) throw error
                }
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {}),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) =>
                category === 'model' ? harness.modelOption : undefined),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                harness.setConfigOptionCalls.push({ sessionId, configId, value })
                return {}
            }),
            setMode: vi.fn(async (sessionId: string, modeId: string, opts?: { syncThoughtLevel?: boolean }) => {
                harness.setModeCalls.push({ sessionId, modeId, syncThoughtLevel: opts?.syncThoughtLevel })
                if (harness.setModeError) throw harness.setModeError
            }),
            supportsImagePrompts: vi.fn(() => harness.imagePrompts),
            setCurrentModeUpdateListener: vi.fn((listener: (update: { sessionId: string | null; currentModeId: string }) => void) => {
                harness.modeListener = listener
            }),
            getSessionCurrentMode: vi.fn(() => harness.currentMode ?? undefined),
            setSessionInfoUpdateListener: vi.fn((listener: (update: { title?: unknown }) => void) => {
                harness.titleListener = listener
            }),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => {})
        }
        harness.backends.push(backend)
        harness.backend = backend
        return backend
    })
}))

vi.mock('./utils/zcodePromptContent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/zcodePromptContent')>()
    return {
        ...actual,
        buildZcodePromptContent: vi.fn(async (
            _backend: unknown,
            text: string,
            images: unknown[] | undefined,
            opts: { sessionId?: string } | undefined
        ) => {
            harness.promptContentInputs.push({ text, images, sessionId: opts?.sessionId })
            const prompt: Array<Record<string, unknown>> = [{ type: 'text', text }]
            if (images && images.length > 0 && harness.imagePrompts) {
                for (const image of images) {
                    const attachment = image as { path: string; mimeType: string }
                    prompt.push({ type: 'image', data: `b64:${attachment.path}`, mimeType: attachment.mimeType })
                }
            }
            return prompt
        })
    }
})

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        // Mirrors the real handler: constructing it registers the backend's
        // permission callback — that registration order is what the
        // bind-early test observes.
        constructor(
            _session: unknown,
            backend?: { onPermissionRequest?: (handler: (request: unknown) => void) => void },
            ...rest: unknown[]
        ) {
            harness.permissionHandlerArgs.push([_session, backend, ...rest])
            backend?.onPermissionRequest?.(() => {})
        }
        async askUser(input: unknown): Promise<unknown> {
            harness.askUserCalls.push(input)
            return harness.askUserOutcome ?? { status: 'canceled', reason: 'mock' }
        }
        async cancelAll(): Promise<void> {}
    }
}))

const mcpBridgeMock = vi.hoisted(() => ({
    mcpServers: {} as Record<string, { command: string; args: string[] }>
}))

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: vi.fn(async () => ({
        server: { url: 'http://127.0.0.1:0/mcp', stop: vi.fn() },
        mcpServers: mcpBridgeMock.mcpServers
    }))
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport'
import { ZCODE_ACP_MODE_BY_PERMISSION, ZcodeRemoteLauncher } from './zcodeRemoteLauncher'

/** The transport's own typed marker for dead-transport failures (process
 *  exit, closed transport, failed stdin write) — what a real dead-child
 *  session/prompt rejection carries. */
function deadTransportError(message = 'ACP process exited (code=1, signal=null)'): Error {
    const error = new Error(message)
    Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true })
    return error
}

/** Whether `promise` settled within a short window (true) or is still parked
 *  (false) — proves a catalog query parks through a blocked window instead of
 *  answering a terminal error immediately. */
async function settlesQuickly(promise: Promise<unknown>): Promise<boolean> {
    return await Promise.race([
        promise.then(() => true, () => true),
        new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 25) })
    ])
}

function createSessionFromQueue(queue: MessageQueue2<ZcodeMode>, sessionId: string | null = null) {
    const session = {
        path: '/tmp/zcode-test',
        logPath: '/tmp/zcode-test/hapi.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            sessionId: HAPI_ROW_ID,
            getMetadata: vi.fn(() => ({})),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            flushMetadata: vi.fn(async () => true)
        },
        queue,
        sessionId,
        getPermissionMode: () => 'default' as const,
        onThinkingChange: vi.fn(),
        // Mirror AgentSessionBase: the ACP session id becomes the session's
        // persisted id, so a respawn resumes it instead of starting over.
        onSessionFound: vi.fn((id: string) => {
            session.sessionId = id
        }),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return session
}

function createSessionWithBatches(batches: Array<[string, ZcodeMode]>, sessionId: string | null = null) {
    const queue = new MessageQueue2<ZcodeMode>((m) => JSON.stringify(m))
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    queue.close()
    return createSessionFromQueue(queue, sessionId)
}

function createSession(mode?: ZcodeMode, sessionId: string | null = null) {
    return createSessionWithBatches([['first', mode ?? {}]], sessionId)
}

/** The registered ListZcodeModels catalog handler (if any). */
function catalogHandler(session: ReturnType<typeof createSession>): ((params?: unknown) => Promise<unknown>) | null {
    const registered = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
    const match = registered.find((call) => call[0] === 'listZcodeModels')
    return match ? match[1] : null
}

describe('ZCODE_ACP_MODE_BY_PERMISSION', () => {
    it('maps every HAPI permission mode onto the zcode mode axis', () => {
        // THE mode map — verified from the zcode-acp-server bridge source:
        // applied at spawn (ZCODE_ACP_MODE) and at runtime (set_mode).
        expect(ZCODE_ACP_MODE_BY_PERMISSION).toEqual({
            default: 'build',
            'read-only': 'plan',
            'safe-yolo': 'guarded',
            yolo: 'yolo'
        })
    })
})

describe('ZcodeRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.backends = []
        harness.createCalls = []
        harness.newSessionConfig = null
        harness.resumeConfig = null
        harness.prompts = []
        harness.promptErrorQueue = []
        harness.initializeErrorQueue = []
        harness.resumeError = null
        harness.resumeSupported = true
        harness.authError = null
        harness.titleListener = null
        harness.modelOption = null
        harness.setConfigOptionCalls = []
        harness.setModeCalls = []
        harness.setModeError = null
        harness.modeListener = null
        harness.currentMode = null
        harness.imagePrompts = false
        harness.askUserCalls = []
        harness.askUserOutcome = null
        harness.newSessionBlocker = null
        harness.promptBlockerQueue = []
        harness.promptContentInputs = []
        harness.permissionHandlerArgs = []
        mcpBridgeMock.mcpServers = {}
    })

    it('creates a fresh ACP session with the MCP bridge mounted and forwards text prompts', async () => {
        mcpBridgeMock.mcpServers = { hapi: { command: 'node', args: ['/bridge.js'] } }
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/zcode-test',
            mcpServers: [{ name: 'hapi', command: 'node', args: ['/bridge.js'], env: [] }]
        })
        expect(session.onSessionFound).toHaveBeenCalledWith('zcode-session-1')
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backend?.disconnect).toHaveBeenCalled()
    })

    it('spawns the backend with the spawn-time ZCODE_ACP_MODE lever (default→build)', async () => {
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        // The bridge's own default for a missing ZCODE_ACP_MODE is "yolo";
        // HAPI must always pin the mapped mode of the live permission
        // setting ('default' → build).
        expect(harness.createCalls).toEqual([{ env: expect.anything(), opts: { acpMode: 'build' } }])
    })

    it('maps a yolo session permission mode onto the yolo spawn lever', async () => {
        const session = createSessionFromQueue(new MessageQueue2<ZcodeMode>((m) => JSON.stringify(m)))
        ;(session as unknown as { getPermissionMode: () => string }).getPermissionMode = () => 'yolo'
        const launcher = new ZcodeRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.newSession).toHaveBeenCalled())
        const queue = session.queue
        queue.push('go', { permissionMode: 'yolo' })
        queue.close()
        await done

        expect(harness.createCalls[0]?.opts?.acpMode).toBe('yolo')
    })

    it('pushes the session mode via session/set_mode with syncThoughtLevel disabled', async () => {
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setModeCalls).toEqual([
            { sessionId: 'zcode-session-1', modeId: 'build', syncThoughtLevel: false }
        ])
    })

    it('maps each queued turn permission mode onto the zcode axis', async () => {
        const session = createSessionWithBatches([
            ['a', { permissionMode: 'read-only' }],
            ['b', { permissionMode: 'safe-yolo' }],
            ['c', { permissionMode: 'yolo' }],
            ['d', { permissionMode: 'default' }]
        ])
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setModeCalls.map((call) => call.modeId)).toEqual([
            'build', // establishment (session default)
            'plan', // read-only
            'guarded', // safe-yolo
            'yolo', // yolo
            'build' // default again
        ])
        for (const call of harness.setModeCalls) {
            expect(call.syncThoughtLevel).toBe(false)
        }
    })

    it('still sends read-only turns — the HAPI permission bridge decides', async () => {
        const session = createSessionWithBatches([['first', { permissionMode: 'read-only' }]])
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
    })

    it('restores the persisted session through session/resume with the MCP servers re-sent', async () => {
        mcpBridgeMock.mcpServers = { hapi: { command: 'node', args: ['/bridge.js'] } }
        const session = createSession(undefined, 'zcode-existing-1')
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.resumeSession).toHaveBeenCalledWith({
            sessionId: 'zcode-existing-1',
            cwd: '/tmp/zcode-test',
            mcpServers: [{ name: 'hapi', command: 'node', args: ['/bridge.js'], env: [] }]
        })
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        expect(session.onSessionFound).toHaveBeenCalledWith('zcode-existing-1')
    })

    it('falls back to a fresh session when the resume fails', async () => {
        const session = createSession(undefined, 'zcode-existing-1')
        const launcher = new ZcodeRemoteLauncher(session as never)
        harness.resumeError = new Error('session 不存在')

        await launcher.launch()

        expect(harness.backend?.resumeSession).toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/zcode-test',
            mcpServers: []
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'ZCode session was not found on the agent; starting a new session.'
        })
    })

    it('falls back without probing resume when the server does not advertise it', async () => {
        const session = createSession(undefined, 'zcode-existing-1')
        const launcher = new ZcodeRemoteLauncher(session as never)
        harness.resumeSupported = false

        await launcher.launch()

        expect(harness.backend?.resumeSession).not.toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalled()
    })

    it('surfaces a friendly status line when the credentials probe fails', async () => {
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)
        harness.authError = new Error('No ZCode credentials found — open the ZCode app or run zcode-acp setup')

        await launcher.launch()

        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('ZCode credentials are not available')
        })
        // The turn still runs (the failure is informational, not fatal).
        expect(harness.prompts).toHaveLength(1)
    })

    it('skips the credentials notice when a wrapper does not implement the probe', async () => {
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)
        harness.authError = new Error('Method not found: _client/authenticate (-32601)')

        await launcher.launch()

        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const credentialNotices = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '')
                .includes('credentials'))
        expect(credentialNotices).toEqual([])
    })

    it('mirrors native session_info_update titles into the session summary', async () => {
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.titleListener).toBeTypeOf('function')
        harness.titleListener?.({ title: 'Refactor the parser' })
        expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'summary', summary: 'Refactor the parser' })
        )
    })

    it('re-asserts the HAPI mode after a foreign current_mode_update', async () => {
        // Another surface (the ZCode app / another editor) switched the
        // mode: the launcher says so, drops the apply dedupe, and the NEXT
        // batch re-issues session/set_mode with the HAPI-side preference.
        // The first prompt parks so the change demonstrably lands BETWEEN
        // the two batches (distinct modes keep them separate).
        let releaseFirst!: () => void
        const park = new Promise<void>((resolve) => { releaseFirst = resolve })
        harness.promptBlockerQueue = [park]
        const session = createSessionWithBatches([
            ['first', {}],
            ['second', { permissionMode: 'default' }]
        ])
        const launcher = new ZcodeRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        harness.modeListener?.({ sessionId: 'zcode-session-1', currentModeId: 'plan' })
        releaseFirst()
        await done

        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'ZCode mode changed elsewhere; re-asserting'
        })
        // Startup build, then build AGAIN on the second batch (the dedupe
        // was cleared by the foreign change) — not silently left in plan.
        expect(harness.setModeCalls.map((call) => call.modeId)).toEqual(['build', 'build'])
    })

    it('ignores the current_mode_update echo of its own set_mode', async () => {
        let releaseFirst!: () => void
        const park = new Promise<void>((resolve) => { releaseFirst = resolve })
        harness.promptBlockerQueue = [park]
        const session = createSessionWithBatches([
            ['first', {}],
            ['second', { permissionMode: 'default' }]
        ])
        const launcher = new ZcodeRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        // The async echo of the launcher's own 'build' switch (and a repeat
        // of it) is not a foreign change: no notice, no extra set_mode.
        harness.modeListener?.({ sessionId: 'zcode-session-1', currentModeId: 'build' })
        harness.modeListener?.({ sessionId: 'zcode-session-1', currentModeId: 'build' })
        releaseFirst()
        await done

        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
            .map((call) => String((call[0] as { message?: string } | undefined)?.message ?? ''))
        expect(events).not.toContain('ZCode mode changed elsewhere; re-asserting')
        expect(harness.setModeCalls.map((call) => call.modeId)).toEqual(['build'])
    })

    it('notices a mismatched observed mode at establishment and re-asserts', async () => {
        harness.currentMode = 'plan'
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'ZCode mode changed elsewhere; re-asserting'
        })
        // The observed plan seeded the dedupe, so the desired build is
        // pushed right away.
        expect(harness.setModeCalls.map((call) => call.modeId)).toEqual(['build'])
    })

    it('answers the ListZcodeModels catalog from the model config option', async () => {
        harness.modelOption = {
            id: 'model',
            category: 'model',
            currentValue: GLM,
            options: [
                { value: GLM, name: 'GLM-5.3' },
                { value: GLM_AIR, name: 'GLM-5.3 Air' }
            ]
        }
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        const handler = catalogHandler(session)
        expect(handler).toBeTypeOf('function')
        const answer = await handler?.() as {
            success: boolean
            availableModels: Array<{ modelId: string; name?: string }>
            currentModelId: string | null
        }
        expect(answer.success).toBe(true)
        expect(answer.availableModels).toEqual([
            { modelId: GLM, name: 'GLM-5.3' },
            { modelId: GLM_AIR, name: 'GLM-5.3 Air' }
        ])
        expect(answer.currentModelId).toBe(GLM)
    })

    it('parks a catalog query that arrives before the session exists', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        let releaseNew!: () => void
        harness.newSessionBlocker = new Promise((resolve) => { releaseNew = resolve })
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)

        const done = launcher.launch()
        const handler = await vi.waitFor(() => {
            expect(catalogHandler(session)).toBeTypeOf('function')
            return catalogHandler(session)!
        })
        const query = handler()
        await vi.waitFor(() => expect(harness.backend?.newSession).toHaveBeenCalled())
        // Still parked while session/new is in flight.
        expect(await settlesQuickly(query)).toBe(false)
        releaseNew()
        await done
        const answer = await query as { success: boolean }
        expect(answer.success).toBe(true)
    })

    it('binds the permission handler before initialize completes', async () => {
        // The hermes lesson: agents may re-offer pending permission cards
        // during initialize/resume; the handler must already be registered
        // on the backend by then. The mock's constructor registers the
        // backend's permission callback — that call must precede initialize.
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        const backend = harness.backends[0]
        expect(harness.permissionHandlerArgs).toHaveLength(1)
        expect(harness.permissionHandlerArgs[0][1]).toBe(backend)
        expect(backend.onPermissionRequest.mock.invocationCallOrder[0])
            .toBeLessThan(backend.initialize.mock.invocationCallOrder[0])
        // The live permission-mode getter is wired.
        expect(typeof harness.permissionHandlerArgs[0][2]).toBe('function')
    })

    it('switches the model through the model config option and reports it', async () => {
        harness.modelOption = {
            id: 'model',
            category: 'model',
            currentValue: GLM,
            options: [
                { value: GLM, name: 'GLM-5.3' },
                { value: GLM_AIR, name: 'GLM-5.3 Air' }
            ]
        }
        const session = createSessionWithBatches([['first', { model: GLM_AIR }]])
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([
            { sessionId: 'zcode-session-1', configId: 'model', value: GLM_AIR }
        ])
    })

    it('resets to the captured default on an explicit model: null request', async () => {
        harness.modelOption = {
            id: 'model',
            category: 'model',
            currentValue: GLM,
            options: [
                { value: GLM, name: 'GLM-5.3' },
                { value: GLM_AIR, name: 'GLM-5.3 Air' }
            ]
        }
        const session = createSessionWithBatches([
            ['switch', { model: GLM_AIR }],
            ['reset', { model: null }]
        ])
        const onModelRollback = vi.fn()
        const launcher = new ZcodeRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([
            { sessionId: 'zcode-session-1', configId: 'model', value: GLM_AIR },
            { sessionId: 'zcode-session-1', configId: 'model', value: GLM }
        ])
        expect(onModelRollback).not.toHaveBeenCalled()
    })

    it('reports a rollback instead of resetting when no default was captured', async () => {
        harness.modelOption = null
        const session = createSessionWithBatches([['reset', { model: null }]])
        const onModelRollback = vi.fn()
        const launcher = new ZcodeRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Cannot reset the ZCode model: the agent did not report a default model.'
        })
        expect(onModelRollback).toHaveBeenCalledWith(null)
    })

    it('routes image attachments into inline ACP image blocks', async () => {
        harness.imagePrompts = true
        const images = [{ path: '/uploads/shot.svg', mimeType: 'image/svg+xml', filename: 'shot.svg' }]
        const session = createSessionWithBatches([
            ['look at this', { imageAttachments: images }]
        ])
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.promptContentInputs).toEqual([{
            text: 'look at this',
            images,
            sessionId: HAPI_ROW_ID
        }])
        expect(harness.prompts).toEqual([[
            { type: 'text', text: 'look at this' },
            { type: 'image', data: 'b64:/uploads/shot.svg', mimeType: 'image/svg+xml' }
        ]])
    })

    it('respawns the backend and retries the prompt when the ACP process dies mid-session', async () => {
        harness.promptErrorQueue = [deadTransportError()]
        const session = createSessionWithBatches([
            ['first', { permissionMode: 'yolo' }],
            ['second', {}]
        ])
        // Distinct modes keep the two messages in separate queue batches.
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(2)
        expect(harness.backends[0].disconnect).toHaveBeenCalledTimes(1)
        // The respawn restored the persisted session id on the fresh
        // backend via session/resume, re-sending the MCP servers.
        expect(harness.backends[1].initialize).toHaveBeenCalled()
        expect(harness.backends[1].resumeSession).toHaveBeenCalledWith({
            sessionId: 'zcode-session-1',
            cwd: '/tmp/zcode-test',
            mcpServers: []
        })
        expect(session.onSessionFound).toHaveBeenCalledTimes(2)
        // The respawn retried the DYING batch first, then the second message
        // ran as its own batch on the fresh backend.
        expect(harness.backends[1].prompt).toHaveBeenCalledWith(
            'zcode-session-1',
            [{ type: 'text', text: 'second' }],
            expect.any(Function)
        )
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }], // failed attempt, recorded too
            [{ type: 'text', text: 'first' }], // exactly-once retry on the respawn
            [{ type: 'text', text: 'second' }]
        ])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('reconnecting')
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        // Cleanup tears down the respawned backend.
        expect(harness.backends[1].disconnect).toHaveBeenCalledTimes(1)
    })

    it('re-applies the mode on the respawned backend before the retry', async () => {
        harness.promptErrorQueue = [deadTransportError()]
        const session = createSessionWithBatches([
            ['first', { permissionMode: 'safe-yolo' }],
            ['second', {}]
        ])
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        // Establishment pushed build (session default) → the safe-yolo batch
        // (guarded) → the respawn establishment re-asserted the SESSION mode
        // (build, dedupe cleared) → the retry re-applied the batch's guarded
        // on the fresh backend.
        expect(harness.setModeCalls.map((call) => call.modeId)).toEqual([
            'build',
            'guarded',
            'build',
            'guarded'
        ])
        expect(harness.setModeCalls[2].sessionId).toBe('zcode-session-1')
    })

    it('does not respawn when the prompt failure is not a transport death', async () => {
        harness.promptErrorQueue = [new Error('unknown model option')]
        const session = createSession()
        const launcher = new ZcodeRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'ZCode prompt failed: unknown model option'
        })
    })

    it('keeps the session alive when a stop arrives while the queue is idle', async () => {
        const queue = new MessageQueue2<ZcodeMode>((m) => JSON.stringify(m))
        const session = createSessionFromQueue(queue)
        const launcher = new ZcodeRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.newSession).toHaveBeenCalled())

        // Stop while the loop is parked on the empty queue.
        await launcher.kill()

        // The session survives: a message sent after the stop still runs.
        queue.push('after-stop', {})
        queue.close()
        await done

        expect(harness.backends).toHaveLength(1)
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'after-stop' }]])
    })

    it('cancels the in-flight prompt through session/cancel on abort', async () => {
        let releasePrompt!: () => void
        harness.promptBlockerQueue = [new Promise((resolve) => { releasePrompt = resolve })]
        const queue = new MessageQueue2<ZcodeMode>((m) => JSON.stringify(m))
        queue.push('first', {})
        const session = createSessionFromQueue(queue)
        const launcher = new ZcodeRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalled())

        const killPromise = launcher.kill()
        releasePrompt()
        await killPromise
        queue.close()
        await done

        // session/cancel notification on the ACP session id (no close
        // fallback — the bridge expects exactly this).
        expect(harness.backend?.cancelPrompt).toHaveBeenCalledWith('zcode-session-1')
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'Session aborted' })
    })
})

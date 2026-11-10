import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { DshMode } from './types'

const FLASH = '["deepseek-official","deepseek-flash"]'
const PRO = '["deepseek-official","deepseek-v4-pro"]'

const harness = vi.hoisted(() => ({
    // Latest created backend (existing tests assert against it); `backends`
    // records every creation in order so respawn tests can tell the dead
    // backend from its replacement apart.
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    backends: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
    createCalls: [] as Array<{ env?: Record<string, string | undefined>; opts?: { permissionMode?: string } }>,
    newSessionConfig: null as unknown,
    newSessionCalls: [] as unknown[],
    promptSessionIds: [] as string[],
    prompts: [] as unknown[][],
    // Per-attempt prompt failures (shifted off the front); a null slot parks
    // the queue without failing, letting tests stage N failures + success.
    promptErrorQueue: [] as Array<Error | null>,
    initializeErrorQueue: [] as Array<Error | null>,
    // When set, prompt() finishes by emitting turn_complete with this reason.
    promptStopReason: null as string | null,
    supportsResume: false,
    resumeCalls: [] as unknown[],
    resumeError: null as Error | null,
    // When set, resumeSession() parks on this promise — lets tests abort
    // inside the post-abort respawn window.
    resumeBlocker: null as null | Promise<void>,
    supportsCancel: true,
    // Registered by onSessionClosedByCancel; fired by the cancelPrompt mock
    // on the close path, mirroring the real backend.
    sessionClosedHandler: null as (() => void) | null,
    // Captured 4th constructor arg of AcpPermissionHandler: the synchronous
    // pending-close handoff for permission 'abort' decisions.
    permissionAbortClose: null as ((cancellation: Promise<void>) => void) | null,
    // Captured 3rd constructor arg: the live permission-mode getter consulted
    // by the ACP permission bridge on every permission request.
    permissionGetMode: null as (() => string | undefined) | null,
    // When set, prompt() parks on this promise — lets tests abort mid-turn.
    promptBlocker: null as null | Promise<void>,
    // When set, a close-path cancelPrompt parks on this promise — lets tests
    // overlap prompt completion with a pending session/close response.
    cancelBlocker: null as null | Promise<void>,
    // When set, newSession() parks on this promise — lets tests abort inside
    // the respawn window, or query the catalog RPC while session/new is still
    // pending.
    newSessionBlocker: null as null | Promise<void>,
    modelOption: null as { id: string; category?: string; currentValue?: string } | null,
    modelsMetadata: null as {
        availableModels: Array<{ modelId: string; name?: string }>
        currentModelId: string | null
    } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    configOptionError: null as Error | null,
    // Mirrors the backend's advertised promptCapabilities.image gate.
    supportsImages: false,
    // Recorded by the buildDshPromptContent mock.
    promptContentInputs: [] as Array<{ text: string; images: unknown[] | undefined }>
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn((env?: unknown, opts?: { permissionMode?: string }) => {
        harness.createCalls.push({
            env: env as Record<string, string | undefined> | undefined,
            opts
        })
        const backend = {
            initialize: vi.fn(async () => {
                if (harness.initializeErrorQueue.length > 0) {
                    const error = harness.initializeErrorQueue.shift()
                    if (error) throw error
                }
            }),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                harness.newSessionCalls.push(config)
                if (harness.newSessionBlocker) {
                    await harness.newSessionBlocker
                }
                return `dsh-session-${harness.newSessionCalls.length}`
            }),
            prompt: vi.fn(async (sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.promptSessionIds.push(sessionId)
                harness.prompts.push(content)
                if (harness.promptBlocker) {
                    await harness.promptBlocker
                }
                if (harness.promptErrorQueue.length > 0) {
                    const error = harness.promptErrorQueue.shift()
                    if (error) throw error
                }
                onUpdate({ type: 'text', text: 'answer' })
                if (harness.promptStopReason !== null) {
                    onUpdate({ type: 'turn_complete', stopReason: harness.promptStopReason })
                }
            }),
            cancelPrompt: vi.fn(async () => {
                if (harness.supportsCancel) return
                if (harness.cancelBlocker) {
                    await harness.cancelBlocker
                }
                harness.sessionClosedHandler?.()
            }),
            supportsSessionResume: vi.fn(() => harness.supportsResume),
            resumeSession: vi.fn(async (config: unknown) => {
                harness.resumeCalls.push(config)
                if (harness.resumeBlocker) {
                    await harness.resumeBlocker
                }
                if (harness.resumeError) throw harness.resumeError
                return (config as { sessionId: string }).sessionId
            }),
            supportsCancelNotification: vi.fn(() => harness.supportsCancel),
            supportsImagePrompts: vi.fn(() => harness.supportsImages),
            getConfigOptionByCategory: vi.fn(() => harness.modelOption),
            getSessionModelsMetadata: vi.fn(() => harness.modelsMetadata),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                harness.setConfigOptionCalls.push({ sessionId, configId, value })
                if (harness.configOptionError) throw harness.configOptionError
                return {}
            }),
            onStderrError: vi.fn(),
            onSessionClosedByCancel: vi.fn((handler: () => void) => {
                harness.sessionClosedHandler = handler
            }),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => {})
        }
        harness.backends.push(backend)
        harness.backend = backend
        return backend
    })
}))

vi.mock('./utils/dshPromptContent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/dshPromptContent')>()
    return {
        ...actual,
        buildDshPromptContent: vi.fn(async (
            _backend: unknown,
            text: string,
            images: unknown[] | undefined,
            _opts: unknown
        ) => {
            harness.promptContentInputs.push({ text, images })
            const prompt: Array<Record<string, unknown>> = [{ type: 'text', text }]
            if (images && images.length > 0 && harness.supportsImages) {
                for (const image of images) {
                    const attachment = image as { path: string; mimeType: string }
                    prompt.push({ type: 'image', data: `b64:${attachment.path}`, mimeType: attachment.mimeType })
                }
            }
            return prompt
        })
    }
})

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: vi.fn(async () => ({
        server: { url: 'http://127.0.0.1:0/mcp', stop: vi.fn() },
        mcpServers: {}
    }))
}))

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        constructor(
            _session: unknown,
            _backend: unknown,
            getPermissionMode: () => string | undefined,
            onAbortClose?: (cancellation: Promise<void>) => void
        ) {
            harness.permissionGetMode = getPermissionMode
            harness.permissionAbortClose = onAbortClose ?? null
        }
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport'
import { DshRemoteLauncher } from './dshRemoteLauncher'

/** The transport's own typed marker for dead-transport failures (process
 *  exit, closed transport, failed stdin write) — what a real dead-child
 *  session/prompt rejection carries. */
function deadTransportError(message = 'ACP process exited (code=1, signal=null)'): Error {
    const error = new Error(message)
    Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true })
    return error
}

function createQueue() {
    const queue = new MessageQueue2<DshMode>((mode) => JSON.stringify(mode))
    return queue
}

function createSession(queue = createQueue(), sessionId: string | null = null) {
    const session = {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn((fn: (metadata: unknown) => unknown) => fn({})),
            flushMetadata: vi.fn(async () => true)
        },
        queue,
        sessionId,
        // Mirrors AgentSessionBase.onSessionFound: re-pin the id and write
        // dshSessionId metadata through the client.
        onSessionFound: vi.fn((id: string) => {
            session.sessionId = id
            session.client.updateMetadata((metadata: unknown) => ({ ...(metadata as Record<string, unknown>), dshSessionId: id }))
        }),
        // Annotated wide so tests can override the method with any mode (or
        // undefined) — the launcher only reads it through the captured getter.
        getPermissionMode: (): string | undefined => 'default',
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return session
}

function createSessionWithBatches(batches: Array<[string, DshMode]>, sessionId: string | null = null) {
    const queue = createQueue()
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    queue.close()
    return createSession(queue, sessionId)
}

function createSessionWithMode(mode?: DshMode) {
    return createSessionWithBatches([['first', mode ?? {}]])
}

describe('DshRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.backends = []
        harness.createCalls = []
        harness.newSessionConfig = null
        harness.newSessionCalls = []
        harness.promptSessionIds = []
        harness.prompts = []
        harness.promptErrorQueue = []
        harness.initializeErrorQueue = []
        harness.promptStopReason = null
        harness.supportsResume = false
        harness.resumeCalls = []
        harness.resumeError = null
        harness.resumeBlocker = null
        harness.supportsCancel = true
        harness.sessionClosedHandler = null
        harness.permissionAbortClose = null
        harness.permissionGetMode = null
        harness.promptBlocker = null
        harness.cancelBlocker = null
        harness.newSessionBlocker = null
        harness.modelOption = null
        harness.modelsMetadata = null
        harness.setConfigOptionCalls = []
        harness.configOptionError = null
        harness.supportsImages = false
        harness.promptContentInputs = []
        harness.newSessionBlocker = null
    })

    it('creates a fresh ACP session and forwards text prompts', async () => {
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backend?.disconnect).toHaveBeenCalled()
    })

    it('wires the session permission mode into the ACP permission bridge', async () => {
        // The bridge must consult the live session mode on every permission
        // request — without this wiring, yolo cannot auto-approve and every
        // request escalates to a permission card.
        const session = createSessionWithMode()
        session.getPermissionMode = () => 'yolo'
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.permissionGetMode).not.toBeNull()
        expect(harness.permissionGetMode?.()).toBe('yolo')
    })

    it('observes runtime mode changes made after launch (SetSessionConfig wiring)', async () => {
        // The mode picker applies changes via SetSessionConfig →
        // session.setPermissionMode; the bridge must read through to the
        // session on each permission request, not a launch-time copy.
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()
        session.getPermissionMode = () => 'yolo'

        expect(harness.permissionGetMode?.()).toBe('yolo')
    })

    it('reports an unset permission mode to the bridge (card escalation)', async () => {
        const session = createSessionWithMode()
        session.getPermissionMode = () => undefined
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.permissionGetMode?.()).toBeUndefined()
    })

    it('resumes the stored ACP session instead of creating a fresh one', async () => {
        harness.supportsResume = true
        const queue = createQueue()
        queue.push('hello again', {})
        queue.close()
        const session = createSession(queue, 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toEqual([{
            sessionId: 'dsh-stored-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        }])
        expect(harness.newSessionCalls).toHaveLength(0)
        expect(harness.promptSessionIds).toEqual(['dsh-stored-1'])
        // Resumed id unchanged → still re-pinned: the write is an idempotent
        // metadata merge that self-heals rows whose earlier pin was lost.
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-stored-1')
        expect(session.client.flushMetadata).toHaveBeenCalled()
    })

    it('persists the native id when an explicit resume opens a fresh HAPI row', async () => {
        // `hapi dsh --resume <id>` without --existing-session-id starts from a
        // new row whose metadata has no dshSessionId; the launcher must pin
        // the id even though the resume returns exactly the requested one.
        harness.supportsResume = true
        const queue = createQueue()
        queue.push('continue', {})
        queue.close()
        const session = createSession(queue, 'dsh-explicit-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-explicit-1'])
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-explicit-1')
        expect(session.client.flushMetadata).toHaveBeenCalled()
    })

    it('falls back to a fresh session when resume fails and re-pins metadata', async () => {
        harness.supportsResume = true
        harness.resumeError = new Error('session not found on disk')
        const queue = createQueue()
        queue.push('hello', {})
        queue.close()
        const session = createSession(queue, 'dsh-stale-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toHaveLength(1)
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1'])
        // The fresh id must replace the stale one in metadata.
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-1')
        expect(session.client.flushMetadata).toHaveBeenCalled()
        expect(session.sessionId).toBe('dsh-session-1')
    })

    it('pins dshSessionId metadata for a fresh session before the main loop', async () => {
        const queue = createQueue()
        queue.push('first', {})
        queue.close()
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-1')
        expect(session.client.updateMetadata).toHaveBeenCalledWith(expect.any(Function))
        expect(session.client.flushMetadata).toHaveBeenCalled()
        expect(session.sessionId).toBe('dsh-session-1')
    })

    it('respawns the ACP session for the next message after a close-based abort', async () => {
        // dsh advertises close/list/resume without cancel: abort falls back to
        // session/close, which ends the ACP session but leaves the process
        // alive. Servers without the resume capability (or a stale stored id,
        // covered below) must open a fresh session before the next prompt.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // Abort while the first turn is still in flight (the real-world path).
        const killPromise = launcher.kill()
        expect(harness.backend?.cancelPrompt).toHaveBeenCalledWith('dsh-session-1')
        releaseFirstPrompt()
        await killPromise

        queue.push('second', {})
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.newSessionCalls[1]).toEqual({ cwd: '/tmp/dsh-test', mcpServers: [] })
        // The post-abort message must run on the respawned session id.
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('resumes the aborted ACP session so the next message keeps its history', async () => {
        // dsh sessions are durable on disk: session/close ends the ACP session
        // but the transcript survives, and session/resume reloads it with every
        // prior turn (verified against dsh 0.2.x). The post-abort respawn must
        // resume the closed id instead of opening a blank session — otherwise
        // a pause mid-run silently forgets the whole conversation.
        harness.supportsCancel = false
        harness.supportsResume = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        const killPromise = launcher.kill()
        expect(harness.backend?.cancelPrompt).toHaveBeenCalledWith('dsh-session-1')
        releaseFirstPrompt()
        await killPromise

        queue.push('second', {})
        queue.close()
        await done

        // The closed session is resumed by id — no second session/new.
        expect(harness.resumeCalls).toEqual([{
            sessionId: 'dsh-session-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        }])
        expect(harness.newSessionCalls).toHaveLength(1)
        // Both turns run on the SAME session: the conversation history carries
        // across the abort.
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('falls back to a fresh session after an abort when the resume fails', async () => {
        // The closed session may no longer be on disk (cleaned ~/.dsh, version
        // migration): the respawn must fall back to session/new instead of
        // stranding the HAPI session.
        harness.supportsCancel = false
        harness.supportsResume = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        // The on-disk session vanishes between the abort and the next message.
        harness.resumeError = new Error('session not found on disk')
        queue.push('second', {})
        queue.close()
        await done

        expect(harness.resumeCalls).toHaveLength(1)
        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
        // The fresh id replaces the unresumable one in metadata.
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-2')
        expect(session.sessionId).toBe('dsh-session-2')
    })

    it('drops the dequeued message when an abort lands while the closed session is being resumed', async () => {
        // An abort inside the post-abort resume window targets the already
        // closed session id; the generation check must discard the dequeued
        // batch and re-enter the respawn branch for the next message.
        harness.supportsCancel = false
        harness.supportsResume = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        // The next message enters the respawn branch; park session/resume.
        let releaseResume!: () => void
        harness.resumeBlocker = new Promise((resolve) => { releaseResume = resolve })
        queue.push('second', {})
        await vi.waitFor(() => expect(harness.resumeCalls).toHaveLength(1))

        // Abort inside the resume window, then let session/resume resolve.
        const secondKill = launcher.kill()
        await secondKill
        releaseResume()

        // The aborted 'second' must be dropped, not executed; 'third' resumes
        // the still-stored id cleanly.
        queue.push('third', {})
        queue.close()
        await done

        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'third' }]
        ])
    })

    it('does not respawn the session after a cancel-notification abort', async () => {
        harness.supportsCancel = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        queue.push('second', {})
        queue.close()
        await done

        // session/cancel keeps the ACP session alive: same session for both turns.
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1'])
    })

    it('respawns the session after a permission abort cancels through the backend directly', async () => {
        // A permission denied with decision 'abort' cancels through
        // AcpPermissionHandler → backend.cancelPrompt, bypassing handleAbort.
        // The backend's close-path event must still mark the session ended so
        // the next message respawns instead of targeting the closed session.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // The permission handler's abort path: direct backend cancellation.
        await (harness.backend?.cancelPrompt as unknown as (sessionId: string) => Promise<void>)('dsh-session-1')

        releaseFirstPrompt()
        queue.push('second', {})
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
    })

    it('discards a follow-up queued before the stop when the prompt finishes before the close', async () => {
        // The in-flight prompt can complete while the session/close response
        // is still on the wire; handleAbort clears the queue synchronously at
        // the top, so a message queued before the stop is dropped before the
        // loop can dequeue it — it must never run on the respawned session.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        let releaseClose!: () => void
        harness.cancelBlocker = new Promise((resolve) => { releaseClose = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // A second message is queued before the abort starts.
        queue.push('second', {})

        // Abort: the close request parks on cancelBlocker.
        const killPromise = launcher.kill()
        await vi.waitFor(() => expect(harness.backend?.cancelPrompt).toHaveBeenCalled())

        // The first turn completes while the close response is still pending.
        releaseFirstPrompt()
        await vi.waitFor(() => expect(harness.promptSessionIds).toHaveLength(1))
        releaseClose()
        await killPromise

        queue.close()
        await done

        // 'second' was queued before the stop, so the synchronous queue.reset()
        // in handleAbort discarded it: no respawn (it is lazy, on next message)
        // and no second prompt.
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1'])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('defers a queued message when a permission-abort close is still pending', async () => {
        // A permission denied with decision 'abort' cancels through
        // AcpPermissionHandler → backend.cancelPrompt and hands the pending
        // close to the launcher synchronously. The loop must park on it even
        // though handleAbort never ran, so the follow-up never targets the
        // closing session.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        let releaseClose!: () => void
        harness.cancelBlocker = new Promise((resolve) => { releaseClose = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        queue.push('second', {})

        // The permission handler's abort path: start the close (parks on
        // cancelBlocker) and hand the pending promise to the launcher before
        // awaiting it — exactly what the real handler does.
        const cancellation = (harness.backend?.cancelPrompt as unknown as (sessionId: string) => Promise<void>)('dsh-session-1')
        harness.permissionAbortClose?.(cancellation)

        // The prompt completes while the close response is still on the wire.
        releaseFirstPrompt()
        await new Promise((resolve) => setTimeout(resolve, 20))
        // The queued follow-up must NOT have been sent to the closing session.
        expect(harness.promptSessionIds).toEqual(['dsh-session-1'])

        releaseClose()
        await cancellation
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('drops the dequeued message when an abort lands while the session is being recreated', async () => {
        // During the respawn's session/new request, session.sessionId still
        // names the closed session; an abort in that window must discard the
        // already-dequeued batch instead of running it on the fresh session.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // Abort while the first turn is still in flight (the real-world path).
        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        // The next message enters the respawn branch; park session/new.
        let releaseNewSession!: () => void
        harness.newSessionBlocker = new Promise((resolve) => { releaseNewSession = resolve })
        queue.push('second', {})
        await vi.waitFor(() => expect(harness.newSessionCalls).toHaveLength(2))

        // Abort inside the recreation window, then let session/new resolve.
        const secondKill = launcher.kill()
        await secondKill
        releaseNewSession()

        // The aborted 'second' must be dropped, not executed.
        queue.push('third', {})
        queue.close()
        await done

        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-3'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'third' }]
        ])
    })

    it('discovers the current model from the model config option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never, { onConfigDiscovered })

        await launcher.launch()

        // No override → no set_config_option call, only discovery.
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(onConfigDiscovered).toHaveBeenCalledWith(FLASH)
    })

    it('applies a spawn model override through session/set_config_option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSessionWithMode({ model: PRO })
        const launcher = new DshRemoteLauncher(session as never, { model: PRO, onConfigDiscovered })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'dsh-session-1',
            configId: 'model',
            value: PRO
        }])
        expect(onConfigDiscovered).toHaveBeenCalledWith(PRO)
    })

    it('switches the model per-turn when the queued mode requests a different one', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const session = createSessionWithMode({ model: PRO })
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'dsh-session-1',
            configId: 'model',
            value: PRO
        }])
        // The prompt still ran after the switch.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('resets to the server default when Default is requested after a spawn-time override', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        // Production sequence: spawn with an override, user later picks
        // "Default" in the picker, next message carries model: null.
        const session = createSessionWithBatches([['first', { model: null }]])
        const launcher = new DshRemoteLauncher(session as never, { model: PRO, onConfigDiscovered })

        await launcher.launch()

        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([PRO, FLASH])
        expect(onConfigDiscovered).toHaveBeenCalledWith(PRO)
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('resets to the server default when Default is requested after a per-turn switch', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const session = createSessionWithBatches([
            ['first', { model: PRO }],
            ['second', { model: null }]
        ])
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([PRO, FLASH])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('keeps the running model and reports back when Default is requested but no default was discovered', async () => {
        // No model config option and no metadata: the server never reported a
        // default to reset to.
        harness.modelOption = null
        harness.modelsMetadata = null
        const onModelRollback = vi.fn()
        const session = createSessionWithBatches([
            ['first', { model: PRO }],
            ['second', { model: null }]
        ])
        const launcher = new DshRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Cannot reset the DSH model: the agent did not report a default model.'
        })
        // Both prompts still ran.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('keeps the previous model and rolls back when a per-turn switch fails', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.configOptionError = new Error('unknown model option')
        const onModelRollback = vi.fn()
        const session = createSessionWithMode({ model: PRO })
        const launcher = new DshRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Failed to switch DSH model: unknown model option'
        })
        expect(onModelRollback).toHaveBeenCalledWith(FLASH)
        // The prompt still ran with the unchanged model.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('does not treat an ordinary turn without model metadata as a reset request', async () => {
        // No model option and no metadata: the server never reported a model,
        // so a preference-less turn (mode {}) must run as an ordinary prompt
        // without emitting the reset-failure event.
        harness.modelOption = null
        harness.modelsMetadata = null
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const resetFailures = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '').includes('Cannot reset'))
        expect(resetFailures).toEqual([])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('answers ListDshModels once a delayed session/new completes', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.modelsMetadata = {
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
        }
        // Park session/new: the picker's catalog query arrives while the ACP
        // session is still being created.
        let releaseNewSession!: () => void
        harness.newSessionBlocker = new Promise((resolve) => { releaseNewSession = resolve })
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        const registered = await vi.waitFor(() => {
            const call = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
                .find((c) => c[0] === 'listDshModels')
            expect(call).toBeTruthy()
            return call!
        })

        // The handler is registered before initialization; invoking it while
        // session/new is pending must park on readiness, not fail.
        const pending = (registered[1] as () => Promise<unknown>)()
        releaseNewSession()
        await done

        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
        })
    })

    it('serves ListDshModels with the live current model', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.modelsMetadata = {
            availableModels: [
                { modelId: FLASH, name: 'DeepSeek-V41-Flash' },
                { modelId: PRO, name: 'DeepSeek-V4-Pro' }
            ],
            currentModelId: FLASH
        }
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        const registered = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
            .find((call) => call[0] === 'listDshModels')
        expect(registered).toBeTruthy()
        const handler = registered![1] as () => Promise<unknown>
        await expect(handler()).resolves.toEqual({
            success: true,
            availableModels: [
                { modelId: FLASH, name: 'DeepSeek-V41-Flash' },
                { modelId: PRO, name: 'DeepSeek-V4-Pro' }
            ],
            currentModelId: FLASH
        })
    })

    it('drops the dequeued message when a user stop lands while it waits for a pending close', async () => {
        // A permission-abort close can still be on the wire when the loop
        // dequeues the next message; a user stop during that wait resets the
        // queue but cannot discard the already-dequeued batch. The generation
        // snapshot taken before the wait must drop it.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        let releaseClose!: () => void
        harness.cancelBlocker = new Promise((resolve) => { releaseClose = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // A follow-up is queued, then a permission abort starts a close that
        // parks on cancelBlocker and hands the pending close to the launcher.
        queue.push('second', {})
        const cancellation = (harness.backend?.cancelPrompt as unknown as (sessionId: string) => Promise<void>)('dsh-session-1')
        harness.permissionAbortClose?.(cancellation)

        // The first turn completes; the loop dequeues 'second' and parks on
        // the pending close.
        releaseFirstPrompt()
        await vi.waitFor(() => expect(harness.promptSessionIds).toHaveLength(1))
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(harness.newSessionCalls).toHaveLength(1)

        // The user stops while 'second' waits for the close response.
        const killPromise = launcher.kill()
        releaseClose()
        await killPromise

        // The aborted 'second' must be dropped; 'third' runs on the
        // respawned session.
        queue.push('third', {})
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'third' }]
        ])
    })

    it('respawns the ACP backend and retries the same batch when the child process dies', async () => {
        // The dsh child died mid-prompt: session/prompt rejects with the
        // transport's typed dead-marker. The launcher must disconnect the
        // corpse, respawn a fresh child, resume the PINNED durable
        // dshSessionId (same cwd — dsh compares resume cwds by realpath),
        // and retry the SAME batch exactly once.
        harness.supportsResume = true
        harness.promptErrorQueue = [deadTransportError()]
        const queue = createQueue()
        queue.push('hello', {})
        queue.close()
        const session = createSession(queue, 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        // The dead backend was disconnected and a fresh one created + initialized.
        expect(harness.backends).toHaveLength(2)
        expect(harness.backends[0].disconnect).toHaveBeenCalled()
        expect(harness.backends[1].initialize).toHaveBeenCalled()
        // The respawn resumes the pinned durable id with the SAME cwd used
        // originally — dsh rejects mismatched resume cwds terminally.
        expect(harness.backends[1].resumeSession).toHaveBeenCalledWith({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
        // The SAME batch ran against the dead transport and again on the
        // replacement — and the retry's answer reached the hub.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'hello' }],
            [{ type: 'text', text: 'hello' }]
        ])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        // Exactly one reconnect status line for the whole respawn.
        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const reconnectLines = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '').includes('reconnecting'))
        expect(reconnectLines).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH connection lost; reconnecting…'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backends[1].disconnect).toHaveBeenCalled()
    })

    it('re-applies the live model on the respawned backend before the retried batch', async () => {
        // The fresh child starts from whatever the server persisted; the
        // respawn must re-apply the session's live model so the retry does
        // not silently run on the server default.
        harness.supportsResume = true
        harness.promptErrorQueue = [deadTransportError()]
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const queue = createQueue()
        queue.push('hello', { model: PRO })
        queue.close()
        const session = createSession(queue, 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        // Discovery default, the batch's switch to PRO on the first backend,
        // then the respawn's restore of PRO on the replacement.
        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([PRO, PRO])
        expect(harness.setConfigOptionCalls[1].sessionId).toBe('dsh-stored-1')
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'hello' }],
            [{ type: 'text', text: 'hello' }]
        ])
    })

    it('surfaces the error and keeps the loop alive when the respawn also fails', async () => {
        harness.supportsResume = true
        harness.promptErrorQueue = [deadTransportError()]
        // First initialize succeeds (initial establishment), the respawn's
        // initialize fails (dsh binary gone); the next message's fresh
        // respawn attempt succeeds again.
        harness.initializeErrorQueue = [null, new Error('Failed to spawn dsh: not found')]
        // Distinct modes so the queue keeps the two messages as separate
        // batches instead of merging them into one turn.
        const session = createSessionWithBatches([
            ['a', {}],
            ['b', { model: PRO }]
        ], 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        // Initial backend, the failed respawn's partial backend (dropped and
        // disconnected), and the successful respawn for the later message.
        expect(harness.backends).toHaveLength(3)
        expect(harness.backends[0].disconnect).toHaveBeenCalled()
        expect(harness.backends[1].disconnect).toHaveBeenCalled()
        // 'a' ran once against the dead transport (no retry — the respawn
        // failed); the error was surfaced and the loop continued into 'b',
        // which respawned fresh and ran on the new backend.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'a' }],
            [{ type: 'text', text: 'b' }]
        ])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH reconnect failed: Failed to spawn dsh: not found'
        })
        expect(harness.backends[2].resumeSession).toHaveBeenCalledWith({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
    })

    it('does not respawn when the prompt fails with a regular agent error', async () => {
        harness.promptErrorQueue = [new Error('unknown session')]
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        // A JSON-RPC rejection is not a dead transport: old behavior only.
        expect(harness.backends).toHaveLength(1)
        expect(harness.backends[0].disconnect).toHaveBeenCalledTimes(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH prompt failed: unknown session'
        })
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('reports a distinct truncation line for a max_tokens turn', async () => {
        // dsh reports stopReason end_turn|max_tokens|cancelled; a turn cut
        // short by the context limit must not read as a normal completion.
        // (Captured via the buffer listener: finalizeTerminal clears the
        // buffer before launch() resolves.)
        harness.promptStopReason = 'max_tokens'
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)
        const lines = new Set<string>()
        ;(launcher as unknown as {
            messageBuffer: { onUpdate: (listener: (messages: Array<{ content: string }>) => void) => void }
        }).messageBuffer.onUpdate((messages) => {
            for (const message of messages) lines.add(message.content)
        })

        await launcher.launch()

        expect([...lines]).toContain('Turn truncated: context limit reached')
        expect([...lines]).not.toContain('Turn complete')
    })

    it('reports the normal completion line for an end_turn turn', async () => {
        harness.promptStopReason = 'end_turn'
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)
        const lines = new Set<string>()
        ;(launcher as unknown as {
            messageBuffer: { onUpdate: (listener: (messages: Array<{ content: string }>) => void) => void }
        }).messageBuffer.onUpdate((messages) => {
            for (const message of messages) lines.add(message.content)
        })

        await launcher.launch()

        expect([...lines]).toContain('Turn complete')
        expect([...lines]).not.toContain('Turn truncated: context limit reached')
    })

    it('mounts the hapi MCP bridge servers on the ACP session', async () => {
        const { buildHapiMcpBridge } = await import('@/codex/utils/buildHapiMcpBridge')
        const stop = vi.fn()
        vi.mocked(buildHapiMcpBridge).mockResolvedValueOnce({
            server: { url: 'http://127.0.0.1:9/mcp', stop },
            mcpServers: {
                hapi: { command: '/usr/local/bin/hapi', args: ['mcp', '--url', 'http://127.0.0.1:9/mcp'], tools: {} }
            }
        } as never)
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(buildHapiMcpBridge).toHaveBeenCalledWith(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: '/tmp/dsh-test', flavor: 'dsh' }
        })
        expect(harness.newSessionCalls[0]).toEqual({
            cwd: '/tmp/dsh-test',
            mcpServers: [{
                name: 'hapi',
                command: '/usr/local/bin/hapi',
                args: ['mcp', '--url', 'http://127.0.0.1:9/mcp'],
                env: []
            }]
        })
        // The bridge server is torn down with the launcher.
        expect(stop).toHaveBeenCalled()
    })

    it('threads the spawn-time permission mode into createDshBackend', async () => {
        // The env overlay itself (read-only → DSH_PERMISSION_MODE=read-only,
        // yolo → danger-full-access, default/safe-yolo unset) is unit-tested
        // against the real createDshBackend in dshBackend.test.ts; this pins
        // the launcher-side threading of the spawn-time mode.
        const session = createSessionWithMode()
        await new DshRemoteLauncher(session as never, { permissionMode: 'read-only' }).launch()

        expect(harness.createCalls).toHaveLength(1)
        expect(harness.createCalls[0].opts?.permissionMode).toBe('read-only')
    })

    it('upgrades image attachments to ACP image blocks when the backend advertises image prompts', async () => {
        harness.supportsImages = true
        const images = [{ path: '/uploads/screenshot.png', mimeType: 'image/png', filename: 'screenshot.png' }]
        const queue = createQueue()
        queue.push('look at this', { imageAttachments: images })
        queue.close()
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.promptContentInputs).toEqual([{ text: 'look at this', images }])
        expect(harness.prompts).toEqual([[
            { type: 'text', text: 'look at this' },
            { type: 'image', data: 'b64:/uploads/screenshot.png', mimeType: 'image/png' }
        ]])
    })

    it('keeps an image turn prompt text-only when the backend does not advertise image prompts', async () => {
        // Older dsh / pinned community wrappers without
        // promptCapabilities.image: the fallback @path form is produced by
        // buildDshPromptContent itself; here the gate must simply keep the
        // turn text-only rather than sending rejected image blocks.
        harness.supportsImages = false
        const queue = createQueue()
        queue.push('look at this', {
            imageAttachments: [{ path: '/uploads/screenshot.png', mimeType: 'image/png' }]
        })
        queue.close()
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.prompts).toEqual([[{ type: 'text', text: 'look at this' }]])
    })
})

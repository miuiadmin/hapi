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
    newSessionConfig: null as unknown,
    newSessionCalls: [] as unknown[],
    promptSessionIds: [] as string[],
    prompts: [] as unknown[][],
    promptErrorQueue: [] as unknown[],
    initializeErrorQueue: [] as unknown[],
    supportsResume: false,
    resumeCalls: [] as unknown[],
    resumeError: null as Error | null,
    // Per-call resume outcomes (shifted per invocation): lets a test make
    // the launch-time resume succeed and the post-death respawn's resume
    // fail (stale on-disk id).
    resumeErrorQueue: [] as Array<Error | null>,
    // Captured 3rd constructor arg: the live permission-mode getter consulted
    // by the ACP permission bridge on every permission request.
    permissionGetMode: null as (() => string | undefined) | null,
    // When set, prompt() parks on this promise — lets tests abort mid-turn.
    promptBlocker: null as null | Promise<void>,
    // When set, newSession() parks on this promise — lets tests query the
    // catalog RPC while session/new is still pending.
    newSessionBlocker: null as null | Promise<void>,
    modelOption: null as { id: string; category?: string; currentValue?: string } | null,
    modelsMetadata: null as {
        availableModels: Array<{ modelId: string; name?: string }>
        currentModelId: string | null
    } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    configOptionError: null as Error | null
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
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
                // Record every attempt (failed ones too) so respawn tests can
                // prove the SAME batch was retried.
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
            }),
            cancelPrompt: vi.fn(async () => {}),
            supportsSessionResume: vi.fn(() => harness.supportsResume),
            resumeSession: vi.fn(async (config: unknown) => {
                harness.resumeCalls.push(config)
                if (harness.resumeError) throw harness.resumeError
                if (harness.resumeErrorQueue.length > 0) {
                    const error = harness.resumeErrorQueue.shift()
                    if (error) throw error
                }
                return (config as { sessionId: string }).sessionId
            }),
            getConfigOptionByCategory: vi.fn(() => harness.modelOption),
            getSessionModelsMetadata: vi.fn(() => harness.modelsMetadata),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                harness.setConfigOptionCalls.push({ sessionId, configId, value })
                if (harness.configOptionError) throw harness.configOptionError
                return {}
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

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        constructor(
            _session: unknown,
            _backend: unknown,
            getPermissionMode: () => string | undefined
        ) {
            harness.permissionGetMode = getPermissionMode
        }
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport'
import { DshRemoteLauncher } from './dshRemoteLauncher'

/** The transport's own typed marker for dead-transport failures (process
 * exit, closed transport, failed stdin write) — what a real dead-child
 * session/prompt rejection carries. */
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
            peerToolsDisabled: undefined,
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
        harness.newSessionConfig = null
        harness.newSessionCalls = []
        harness.promptSessionIds = []
        harness.prompts = []
        harness.promptErrorQueue = []
        harness.initializeErrorQueue = []
        harness.supportsResume = false
        harness.resumeCalls = []
        harness.resumeError = null
        harness.resumeErrorQueue = []
        harness.permissionGetMode = null
        harness.promptBlocker = null
        harness.newSessionBlocker = null
        harness.modelOption = null
        harness.modelsMetadata = null
        harness.setConfigOptionCalls = []
        harness.configOptionError = null
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
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

    it('cancels the in-flight turn through session/cancel and keeps the same session for the next message', async () => {
        // dsh ≥0.2.2 treats session/cancel as a regular ACP notification:
        // it cancels the running turn and keeps BOTH the process and the ACP
        // session alive. A user Stop must therefore NOT respawn anything —
        // the next message continues the SAME session with its full history
        // (the interrupt-amnesia fix: session/close destroyed the session).
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

        // No respawn: one session/new, one backend, and both turns ran on
        // the SAME session — the conversation history carries across the
        // abort.
        expect(harness.backends).toHaveLength(1)
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'Session aborted' })
    })

    it('discards a follow-up queued before the stop', async () => {
        // handleAbort clears the queue synchronously before awaiting the
        // cancel notification, so a message queued before the stop is
        // dropped before the loop can dequeue it — it must never run after
        // the user already saw "Session aborted".
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // A second message is queued before the abort starts.
        queue.push('second', {})

        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        queue.close()
        await done

        // 'second' was queued before the stop, so the synchronous
        // queue.reset() in handleAbort discarded it: no second prompt.
        expect(harness.promptSessionIds).toEqual(['dsh-session-1'])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('respawns the ACP backend and retries the same batch when the dsh child process dies', async () => {
        // The dsh child died mid-turn (crash, upgrade, or a legacy dsh that
        // exits on session/cancel): the first prompt rejects with the
        // transport's typed dead-marker. The launcher must rebuild the
        // backend, resume the persisted on-disk session id (dsh sessions
        // survive process death), and retry the SAME batch.
        harness.supportsResume = true
        harness.promptErrorQueue = [deadTransportError()]
        const session = createSessionWithBatches([['hello', {}]], 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        // The dead backend was disconnected and a fresh one created + initialized.
        expect(harness.backends).toHaveLength(2)
        expect(harness.backends[0].disconnect).toHaveBeenCalled()
        expect(harness.backends[1].initialize).toHaveBeenCalled()
        // The respawn resumes the persisted session id — no session/new.
        expect(harness.backends[1].resumeSession).toHaveBeenCalledWith({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
        expect(harness.newSessionCalls).toHaveLength(0)
        // The SAME batch ran against the dead transport and again on the
        // replacement — and the retry's answer reached the hub.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'hello' }],
            [{ type: 'text', text: 'hello' }]
        ])
        expect(harness.promptSessionIds).toEqual(['dsh-stored-1', 'dsh-stored-1'])
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

    it('falls back to a fresh session during the respawn when the stored id no longer resumes', async () => {
        // The on-disk session can vanish between the process death and the
        // respawn (cleaned ~/.dsh, version migration): the respawn's
        // resume must fall back to session/new and re-pin the fresh id.
        harness.supportsResume = true
        // Launch-time resume succeeds; the respawn's resume fails.
        harness.resumeErrorQueue = [null, new Error('session not found on disk')]
        harness.promptErrorQueue = [deadTransportError()]
        const session = createSessionWithBatches([['hello', {}]], 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(2)
        expect(harness.resumeCalls).toHaveLength(2)
        expect(harness.newSessionCalls).toEqual([{ cwd: '/tmp/dsh-test', mcpServers: [] }])
        // The retried batch ran on the fresh session and the fresh id
        // replaced the stale one in metadata.
        expect(harness.promptSessionIds).toEqual(['dsh-stored-1', 'dsh-session-1'])
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-1')
        expect(session.sessionId).toBe('dsh-session-1')
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
})

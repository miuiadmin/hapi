import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { DshMode } from './types'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    newSessionCalls: [] as unknown[],
    promptSessionIds: [] as string[],
    prompts: [] as unknown[][],
    supportsCancel: true,
    // Registered by onSessionClosedByCancel; fired by the cancelPrompt mock
    // on the close path, mirroring the real backend.
    sessionClosedHandler: null as (() => void) | null,
    // Captured 4th constructor arg of AcpPermissionHandler: the synchronous
    // pending-close handoff for permission 'abort' decisions.
    permissionAbortClose: null as ((cancellation: Promise<void>) => void) | null,
    // When set, prompt() parks on this promise — lets tests abort mid-turn.
    promptBlocker: null as null | Promise<void>,
    // When set, a close-path cancelPrompt parks on this promise — lets tests
    // overlap prompt completion with a pending session/close response.
    cancelBlocker: null as null | Promise<void>,
    // When set, newSession() parks on this promise — lets tests abort inside
    // the respawn window.
    newSessionBlocker: null as null | Promise<void>
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
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
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {
                if (harness.supportsCancel) return
                if (harness.cancelBlocker) {
                    await harness.cancelBlocker
                }
                harness.sessionClosedHandler?.()
            }),
            supportsCancelNotification: vi.fn(() => harness.supportsCancel),
            onStderrError: vi.fn(),
            onSessionClosedByCancel: vi.fn((handler: () => void) => {
                harness.sessionClosedHandler = handler
            }),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => {})
        }
        harness.backend = backend
        return backend
    })
}))

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        constructor(
            _session: unknown,
            _backend: unknown,
            _getPermissionMode: unknown,
            onAbortClose?: (cancellation: Promise<void>) => void
        ) {
            harness.permissionAbortClose = onAbortClose ?? null
        }
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { DshRemoteLauncher } from './dshRemoteLauncher'

function createQueue() {
    const queue = new MessageQueue2<DshMode>((mode) => JSON.stringify(mode))
    return queue
}

function createSession(queue = createQueue()) {
    return {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: { rpcHandlerManager: { registerHandler: vi.fn() } },
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default' as const,
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
}

describe('DshRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.newSessionConfig = null
        harness.newSessionCalls = []
        harness.promptSessionIds = []
        harness.prompts = []
        harness.supportsCancel = true
        harness.sessionClosedHandler = null
        harness.permissionAbortClose = null
        harness.promptBlocker = null
        harness.cancelBlocker = null
        harness.newSessionBlocker = null
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
        const queue = createQueue()
        queue.push('first', 'dsh')
        queue.close()
        const session = createSession(queue)
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

    it('respawns the ACP session for the next message after a close-based abort', async () => {
        // dsh advertises close/list/resume without cancel: abort falls back to
        // session/close, which ends the ACP session but leaves the process
        // alive. The launcher must open a fresh session before the next prompt.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', 'dsh')
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // Abort while the first turn is still in flight (the real-world path).
        const killPromise = launcher.kill()
        expect(harness.backend?.cancelPrompt).toHaveBeenCalledWith('dsh-session-1')
        releaseFirstPrompt()
        await killPromise

        queue.push('second', 'dsh')
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

    it('does not respawn the session after a cancel-notification abort', async () => {
        harness.supportsCancel = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', 'dsh')
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        queue.push('second', 'dsh')
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
        queue.push('first', 'dsh')
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // The permission handler's abort path: direct backend cancellation.
        await (harness.backend?.cancelPrompt as unknown as (sessionId: string) => Promise<void>)('dsh-session-1')

        releaseFirstPrompt()
        queue.push('second', 'dsh')
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
    })

    it('does not send a queued message to the session while its close is still pending', async () => {
        // The in-flight prompt can complete while the session/close response
        // is on the wire; a message queued at that moment must wait for the
        // abort to finish and then run on the respawned session.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        let releaseClose!: () => void
        harness.cancelBlocker = new Promise((resolve) => { releaseClose = resolve })
        const queue = createQueue()
        queue.push('first', 'dsh')
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // A second message is queued before the abort starts.
        queue.push('second', 'dsh')

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

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
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
        queue.push('first', 'dsh')
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        queue.push('second', 'dsh')

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
        queue.push('first', 'dsh')
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
        queue.push('second', 'dsh')
        await vi.waitFor(() => expect(harness.newSessionCalls).toHaveLength(2))

        // Abort inside the recreation window, then let session/new resolve.
        const secondKill = launcher.kill()
        await secondKill
        releaseNewSession()

        // The aborted 'second' must be dropped, not executed.
        queue.push('third', 'dsh')
        queue.close()
        await done

        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-3'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'third' }]
        ])
    })
})

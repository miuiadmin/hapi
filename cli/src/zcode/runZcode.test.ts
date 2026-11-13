import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol'
import { MessageQueue2 } from '@/utils/MessageQueue2'

const zcodePromptMocks = vi.hoisted(() => ({
    imageAttachmentsSentinel: [{ path: '/uploads/shot.png', mimeType: 'image/png' }]
}))

vi.mock('./utils/zcodePromptContent', () => ({
    formatZcodeUserMessage: vi.fn((text: string) => `fmt:${text}`),
    zcodeImageAttachmentsFor: vi.fn((attachments?: unknown[]) =>
        attachments && attachments.length > 0
            ? { imageAttachments: zcodePromptMocks.imageAttachmentsSentinel }
            : {})
}))

const harness = vi.hoisted(() => {
    const session = {
        rpcHandlerManager: { registerHandler: vi.fn() },
        keepAlive: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        updateMetadata: vi.fn(),
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn()
    }
    const lifecycleOptions: { stopKeepAlive?: () => void; onBeforeClose?: () => void | Promise<void> } = {}
    const lifecycle = {
        registerProcessHandlers: vi.fn(),
        cleanupAndExit: vi.fn(async () => {
            lifecycleOptions.stopKeepAlive?.()
        }),
        markCrash: vi.fn(),
        setSessionEndReason: vi.fn(),
        setArchiveReason: vi.fn()
    }

    return {
        session,
        lifecycle,
        lifecycleOptions,
        bootstrapExistingSession: vi.fn(),
        bootstrapSession: vi.fn(),
        setControlledByUser: vi.fn(),
        createRunnerLifecycle: vi.fn((options: typeof lifecycleOptions) => {
            lifecycleOptions.stopKeepAlive = options.stopKeepAlive
            lifecycleOptions.onBeforeClose = options.onBeforeClose
            return lifecycle
        }),
        registerKillSessionHandler: vi.fn(),
        registerSessionConfigRpc: vi.fn(),
        launcherLaunch: vi.fn(async () => {}),
        launcherConstructor: vi.fn()
    }
})

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapExistingSession: harness.bootstrapExistingSession,
    bootstrapSession: harness.bootstrapSession
}))
vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: harness.createRunnerLifecycle,
    setControlledByUser: harness.setControlledByUser
}))
vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: harness.registerKillSessionHandler
}))
vi.mock('@/agent/sessionConfigRpc', () => ({
    registerSessionConfigRpc: harness.registerSessionConfigRpc
}))
vi.mock('@/ui/logger', () => ({
    logger: {
        getLogPath: vi.fn(() => '/tmp/zcode-test/hapi.log'),
        debug: vi.fn()
    }
}))
vi.mock('./zcodeRemoteLauncher', () => ({
    ZcodeRemoteLauncher: class {
        constructor(...args: unknown[]) {
            harness.launcherConstructor(...args)
        }

        async launch(): Promise<void> {
            await harness.launcherLaunch()
        }

        async kill(): Promise<void> {}

        async applyModeNow(): Promise<void> {}
    }
}))

import { runZcode } from './runZcode'
import { formatZcodeUserMessage, zcodeImageAttachmentsFor } from './utils/zcodePromptContent'

describe('runZcode', () => {
    beforeEach(() => {
        harness.session.rpcHandlerManager.registerHandler.mockClear()
        harness.lifecycleOptions.stopKeepAlive = undefined
        harness.lifecycleOptions.onBeforeClose = undefined
        harness.bootstrapExistingSession.mockReset()
        harness.bootstrapSession.mockReset()
        harness.setControlledByUser.mockClear()
        harness.createRunnerLifecycle.mockClear()
        harness.registerKillSessionHandler.mockClear()
        harness.registerSessionConfigRpc.mockClear()
        harness.launcherLaunch.mockClear()
        harness.launcherConstructor.mockClear()
        vi.mocked(formatZcodeUserMessage).mockClear()
        vi.mocked(zcodeImageAttachmentsFor).mockClear()
        harness.bootstrapExistingSession.mockResolvedValue({
            api: {},
            session: harness.session,
            sessionInfo: {
                id: 'hapi-session-zcode',
                metadata: { zcodeSessionId: 'zcode-session-1' }
            }
        })
    })

    it('registers the local handoff RPC for an active ZCode resume', async () => {
        await runZcode({
            existingSessionId: 'hapi-session-zcode',
            resumeSessionId: 'zcode-session-1',
            startedBy: 'terminal',
            startingMode: 'remote',
            workingDirectory: '/tmp/project'
        })

        expect(harness.session.rpcHandlerManager.registerHandler).toHaveBeenCalledWith(
            RPC_METHODS.HandoffLocal,
            expect.any(Function)
        )
    })

    it('registers the session config RPC with nullable models and ignored efforts', async () => {
        await runZcode({
            existingSessionId: 'hapi-session-zcode',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project'
        })

        expect(harness.registerSessionConfigRpc).toHaveBeenCalledWith(expect.objectContaining({
            flavor: 'zcode',
            modelMode: 'nullable',
            modelReasoningEffortMode: 'ignore',
            effortMode: 'ignore'
        }))
    })

    it('hands the stored zcodeSessionId to the launcher when no explicit resume id is given', async () => {
        await runZcode({
            existingSessionId: 'hapi-session-zcode',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project'
        })

        // The launcher's first constructor argument is the ZcodeSession; its
        // native id is seeded from metadata.zcodeSessionId.
        const sessionArg = harness.launcherConstructor.mock.calls[0]?.[0] as { sessionId?: string | null }
        expect(sessionArg.sessionId).toBe('zcode-session-1')
    })

    it('seeds the spawn permission mode into the session state', async () => {
        await runZcode({
            existingSessionId: 'hapi-session-zcode',
            startedBy: 'terminal',
            startingMode: 'remote',
            permissionMode: 'yolo',
            workingDirectory: '/tmp/project'
        })

        const sessionArg = harness.launcherConstructor.mock.calls[0]?.[0] as {
            getPermissionMode?: () => string | undefined
        }
        expect(sessionArg.getPermissionMode?.()).toBe('yolo')
    })

    it('routes image attachments into the queued turn mode instead of @path text', async () => {
        // Inline-capable images must ride the mode (they become ACP image
        // blocks at prompt time) and must NOT be appended to the message
        // text — formatting goes through formatZcodeUserMessage, which
        // excludes them.
        const pushSpy = vi.spyOn(MessageQueue2.prototype, 'push').mockImplementation(() => {})
        try {
            await runZcode({
                existingSessionId: 'hapi-session-zcode',
                startedBy: 'terminal',
                workingDirectory: '/tmp/project'
            })
            const onUserMessage = (harness.session.onUserMessage as ReturnType<typeof vi.fn>)
                .mock.calls[0][0] as (message: unknown, localId?: string) => void
            const attachments = [
                { id: 'a1', path: '/uploads/shot.png', mimeType: 'image/png', filename: 'shot.png', size: 4 }
            ]
            onUserMessage(
                { content: { text: 'look at this', attachments } },
                'local-1'
            )

            expect(formatZcodeUserMessage).toHaveBeenCalledWith('look at this', attachments)
            expect(zcodeImageAttachmentsFor).toHaveBeenCalledWith(attachments)
            expect(pushSpy).toHaveBeenCalledWith(
                'fmt:look at this',
                {
                    permissionMode: 'default',
                    imageAttachments: zcodePromptMocks.imageAttachmentsSentinel
                },
                'local-1'
            )
        } finally {
            pushSpy.mockRestore()
        }
    })

    it('keeps ordinary turns free of image attachment metadata', async () => {
        const pushSpy = vi.spyOn(MessageQueue2.prototype, 'push').mockImplementation(() => {})
        try {
            await runZcode({
                existingSessionId: 'hapi-session-zcode',
                startedBy: 'terminal',
                workingDirectory: '/tmp/project'
            })
            const onUserMessage = (harness.session.onUserMessage as ReturnType<typeof vi.fn>)
                .mock.calls[0][0] as (message: unknown, localId?: string) => void
            onUserMessage({ content: { text: 'hello', attachments: undefined } }, 'local-2')

            expect(pushSpy).toHaveBeenCalledWith(
                'fmt:hello',
                { permissionMode: 'default' },
                'local-2'
            )
        } finally {
            pushSpy.mockRestore()
        }
    })

    it('does not push model:null over the keepalive when zcode reports no catalog', async () => {
        // ZCode without a model catalog reports null on discovery. Mapping
        // that onto the session as setModel(null) would re-send model:null
        // over the keepalive runtime every 2s — wiping the stored --model
        // off the hub row within seconds of spawn and breaking later resume.
        // The three-state preference must survive: undefined stays unset.
        await runZcode({
            existingSessionId: 'hapi-session-zcode',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project',
            model: 'zhipu\\glm-5.3'
        })

        const launcherOpts = harness.launcherConstructor.mock.calls[0]?.[1] as {
            model?: string
            onConfigDiscovered?: (model: string | null) => void
        }
        harness.session.keepAlive.mockClear()
        launcherOpts.onConfigDiscovered?.(null)

        // The sync still pushed a keepalive, but its runtime never carries
        // model:null — the spawn model stays what the hub row already has.
        const runtimes = harness.session.keepAlive.mock.calls
            .map((call) => call[2] as { model?: unknown } | undefined)
        expect(runtimes.length).toBeGreaterThan(0)
        for (const runtime of runtimes) {
            expect(runtime?.model).not.toBeNull()
        }
        expect(runtimes.map((runtime) => runtime?.model)).toContain('zhipu\\glm-5.3')

        // The spawn override still flows at spawn: the launcher lever and
        // the session's live model keep the opts.model seed.
        expect(launcherOpts.model).toBe('zhipu\\glm-5.3')
        const sessionArg = harness.launcherConstructor.mock.calls[0]?.[0] as {
            getModel?: () => unknown
        }
        expect(sessionArg.getModel?.()).toBe('zhipu\\glm-5.3')
    })

    it('still communicates an explicit Default reset through the keepalive', async () => {
        // The gate must not swallow real values: a picker "Default" (null
        // preference) is an actual change and still reaches the session.
        await runZcode({
            existingSessionId: 'hapi-session-zcode',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project',
            model: 'zhipu\\glm-5.3'
        })

        const configOptions = harness.registerSessionConfigRpc.mock.calls[0][0] as {
            onApply: (config: { model?: string | null }) => void
            onAfterApply: () => void
        }
        configOptions.onApply({ model: null })
        harness.session.keepAlive.mockClear()
        configOptions.onAfterApply()

        const runtimes = harness.session.keepAlive.mock.calls
            .map((call) => call[2] as { model?: unknown } | undefined)
        expect(runtimes.length).toBeGreaterThan(0)
        expect(runtimes[0]?.model).toBeNull()
    })
})

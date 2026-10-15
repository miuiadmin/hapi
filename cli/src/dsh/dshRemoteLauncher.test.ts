import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { DshMode } from './types'

const FLASH = '["deepseek-official","deepseek-flash"]'
const PRO = '["deepseek-official","deepseek-v4-pro"]'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    prompts: [] as unknown[][],
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
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                return 'dsh-session-1'
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.prompts.push(content)
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {}),
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
        harness.backend = backend
        return backend
    })
}))

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { DshRemoteLauncher } from './dshRemoteLauncher'

function createSession(mode?: DshMode) {
    const queue = new MessageQueue2<DshMode>((m) => JSON.stringify(m))
    queue.push('first', mode ?? {})
    queue.close()

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
        harness.prompts = []
        harness.modelOption = null
        harness.modelsMetadata = null
        harness.setConfigOptionCalls = []
        harness.configOptionError = null
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
        const session = createSession()
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

    it('discovers the current model from the model config option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never, { onConfigDiscovered })

        await launcher.launch()

        // No override → no set_config_option call, only discovery.
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(onConfigDiscovered).toHaveBeenCalledWith(FLASH)
    })

    it('applies a spawn model override through session/set_config_option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSession({ model: PRO })
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
        const session = createSession({ model: PRO })
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

    it('keeps the previous model and rolls back when a per-turn switch fails', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.configOptionError = new Error('unknown model option')
        const onModelRollback = vi.fn()
        const session = createSession({ model: PRO })
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

    it('serves ListDshModels with the live current model', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.modelsMetadata = {
            availableModels: [
                { modelId: FLASH, name: 'DeepSeek-V41-Flash' },
                { modelId: PRO, name: 'DeepSeek-V4-Pro' }
            ],
            currentModelId: FLASH
        }
        const session = createSession()
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

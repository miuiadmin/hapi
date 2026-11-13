import React from 'react'
import { RPC_METHODS } from '@hapi/protocol'
import type { PermissionMode } from '@hapi/protocol/types'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle'
import { isPeerToolsDisabled, withPeerToolsPreference } from '@/modules/common/peerTools'
import { createZcodeBackend } from './utils/zcodeBackend'
import { buildZcodePromptContent } from './utils/zcodePromptContent'
import type { ZcodeSession } from './session'

/**
 * THE mode map: HAPI permission modes onto zcode's own mode axis
 * (plan/build/edit/guarded/yolo, verified from the zcode-acp-server bridge
 * source). Applied at spawn (ZCODE_ACP_MODE — the bridge's own default for
 * a missing value is "yolo", so HAPI must always pin the mapped mode) and
 * at runtime through session/set_mode on every change, respawn, and
 * foreign-change re-assert.
 */
export const ZCODE_ACP_MODE_BY_PERMISSION: Record<string, string> = {
    default: 'build',
    'read-only': 'plan',
    'safe-yolo': 'guarded',
    yolo: 'yolo'
}

/** The authMethod id the bridge's initialize advertises (a credentials
 * readiness probe: present → {}, absent → an error saying how to get them). */
const ZCODE_AUTH_METHOD_ID = 'zcode-credentials'

/**
 * Readiness handshake for the ListZcodeModels catalog RPC (registered once
 * per launcher in runMainLoop). A pending placeholder is armed BEFORE the
 * awaited bridge build and again at the top of every respawn, so a picker
 * query that arrives in those windows parks instead of eating a terminal
 * error (or stale metadata off a dying backend); each establishment adopts
 * the pending handshake, rebinds it to its own backend, and settles it —
 * and a respawn that fails settles it with the failure instead of hanging
 * forever. The backend of the establishment that resolves the promise
 * travels with it: the handler must read the model config option on the
 * backend that captured that session, which a respawn swap keeps visible
 * to parked queries.
 */
type ZcodeModelsReadiness = {
    /** Backend of the establishment that settles `promise`; null while the
     * handshake is a pre-establishment placeholder (establishBackend rebinds
     * it before the promise can ever resolve). */
    backend: ReturnType<typeof createZcodeBackend> | null
    promise: Promise<string>
    resolve: (acpSessionId: string) => void
    reject: (error: unknown) => void
    /** True once resolve/reject ran: a settled handshake can never re-arm,
     * so the next establishment replaces the object instead of adopting it. */
    settled: boolean
}

export class ZcodeRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createZcodeBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    /** Bumped at the top of every handleAbort (ported from dsh/hermes); lets
     * the prompt-catch respawn branch detect an abort that landed while the
     * replacement backend was being established and drop the retried batch. */
    private abortGeneration = 0
    /** The session's live model (opaque `providerId\modelId` value). */
    private currentBackendModel: string | null = null
    /** Server default captured at session creation, before any override. */
    private initialBackendModel: string | null = null
    /** Last zcode mode id successfully pushed via session/set_mode. */
    private lastAppliedAcpMode: string | null = null
    /** zcode mode currently being pushed via session/set_mode — the async
     * current_mode_update echo of OUR OWN switch must not be mistaken for a
     * foreign change while this is set. */
    private applyingAcpMode: string | null = null
    /** Last foreign mode a "changed elsewhere" notice was emitted for —
     * suppresses repeat notices for repeated echoes of the same change. */
    private lastForeignModeNotice: string | null = null
    private displayPermissionMode: PermissionMode | undefined
    /** ACP session id on the CURRENT backend — swapped by every respawn so
     * the main loop, abort path, and catalog RPC never act on a stale one. */
    private acpSessionId: string | null = null
    private modelsReadiness: ZcodeModelsReadiness | null = null
    /** Guards against concurrent backend rebuilds (prompt retry vs abort). */
    private respawnInProgress = false
    /** HAPI MCP bridge HTTP server; mounted into every (re)established session. */
    private happyServer: { stop: () => void } | null = null
    /** ACP form of the hapi MCP bridge servers (name/command/args/env). */
    private acpMcpServers: McpServerStdio[] = []

    constructor(
        private readonly session: ZcodeSession,
        private readonly opts: {
            /** Spawn-time model override (opaque ACP config-option value). */
            model?: string
            onModelRollback?: (model: string | null) => void
            onConfigDiscovered?: (model: string | null) => void
        } = {}
    ) {
        super(process.env.DEBUG ? session.logPath : undefined)
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.handleExitFromUi() })
    }

    async kill(): Promise<void> {
        if (!this.backend) return
        await this.handleAbort()
    }

    /**
     * Push a mid-session permission-mode switch onto the agent immediately
     * (display mirror + session/set_mode). The queued-turn path re-applies
     * the mode at the next batch anyway; this just avoids the boundary lag.
     */
    async applyModeNow(): Promise<void> {
        if (!this.backend || !this.acpSessionId) return
        const mode = this.session.getPermissionMode() as PermissionMode | undefined
        this.applyDisplayMode(mode)
        await this.applyZcodeAcpMode(this.backend, this.acpSessionId, mode)
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, {
            ...context,
            agentLabel: 'ZCode'
        })
    }

    /**
     * Spawn a zcode ACP backend with the spawn-time levers: ZCODE_BIN (the
     * GLM runtime the bridge spawns underneath) and ZCODE_ACP_MODE (the
     * zcode mode a NEW lazy session materializes in — the bridge defaults
     * to its own "yolo" when unset, so every backend creation — initial
     * launch and respawn alike — pins the mapped mode of the session's
     * live permission setting).
     */
    private spawnBackend(): ReturnType<typeof createZcodeBackend> {
        const permissionMode = this.session.getPermissionMode() as PermissionMode | undefined
        const backend = createZcodeBackend(
            withPeerToolsPreference(this.session.client.peerToolsDisabled ?? isPeerToolsDisabled()),
            { acpMode: ZCODE_ACP_MODE_BY_PERMISSION[permissionMode ?? 'default'] ?? 'build' }
        )
        backend.onStderrError((error) => {
            logger.debug('[zcode-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })
        return backend
    }

    protected async runMainLoop(): Promise<void> {
        // Seed a pending placeholder BEFORE the awaited bridge build (dsh
        // pattern): the handler below is registered immediately, and a
        // picker query that lands while the bridge HTTP server is still
        // being built must park on the placeholder — not get a terminal
        // "not available" answer — and be answered by the first
        // establishment (which adopts it).
        this.armModelsReadiness()
        // Register the catalog RPC before initialization: a client that opens
        // the model picker while initialize/session/new is still pending
        // would otherwise hit an unregistered-method rejection, and the
        // picker has no retry path — it would stay empty until remounted.
        // The handler parks on readiness and answers once the session
        // exists, reading the `model` config option off the backend of
        // whichever establishment resolved it — a respawn swap is always
        // visible.
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListZcodeModels, async () => {
            const readiness = this.modelsReadiness
            if (!readiness) {
                return { success: false, error: 'ZCode session is not available' }
            }
            let acpSessionId: string
            try {
                acpSessionId = await readiness.promise
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `ZCode session is not available: ${message}` }
            }
            const option = readiness.backend?.getConfigOptionByCategory(acpSessionId, 'model')
            if (!option) {
                return { success: false, error: 'ZCode model options are not available' }
            }
            return {
                success: true,
                availableModels: (option.options ?? []).map((choice) => ({
                    modelId: choice.value,
                    ...(choice.name !== undefined ? { name: choice.name } : {})
                })),
                currentModelId: option.currentValue ?? this.currentBackendModel ?? null
            }
        })

        // The zcode-acp-server bridge accepts client MCP servers as ACP
        // stdio entries as-is (session/new AND every session/resume — the
        // bridge remembers them as session-lifetime state and re-sends them
        // on each backend reload). Bridge the hapi MCP tools exactly like
        // the dsh/hermes/kimi ACP flavors: the bridge HTTP server is built
        // ONCE per launcher and every (re)establishment passes the same
        // server list, so a respawn remounts the tools cleanly.
        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(this.session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: this.session.path, flavor: 'zcode' },
            // The MCP bridge provides `ask_user_question`; questions surface
            // through the shared permission bridge as the interactive
            // AskUserQuestion card on every HAPI client, and the answer
            // batch returns to the model in-band as the tool result. The
            // closure reads the CURRENT handler: establishBackend swaps it
            // on every respawn, and the tool can only run once a session
            // exists.
            askUserTool: {
                escalate: async (input) => {
                    const handler = this.permissionHandler
                    if (!handler) {
                        return { status: 'canceled' as const, reason: 'ZCode session is not established' }
                    }
                    return await handler.askUser(input)
                }
            }
        })
        this.happyServer = happyServer
        this.acpMcpServers = toAcpMcpServers(mcpServers)

        // A failed INITIAL establishment does not kill the session: the
        // stored zcodeSessionId is kept and the loop's per-message respawn
        // attempt retries the resume later (e.g. the bridge coming back
        // after a restart).
        try {
            await this.establishBackend({ respawn: false })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[zcode-acp] initial establishment failed', { message })
            this.session.sendSessionEvent({ type: 'message', message: `ZCode session failed to start: ${message}` })
            this.messageBuffer.addMessage(`ZCode session failed to start: ${message}`, 'status')
            const partial = this.backend
            this.backend = null
            this.acpSessionId = null
            try {
                await partial?.disconnect()
            } catch (disconnectError) {
                logger.debug('[zcode-acp] disconnect of partial backend failed', disconnectError)
            }
        }

        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })

        while (!this.shouldExit) {
            // Capture the signal per iteration (ported from dsh/berry):
            // handleAbort swaps in a fresh AbortController right after
            // aborting, so re-reading this.abortController.signal below
            // would see the replacement (never aborted) and mistake an
            // aborted wait for a closed queue — exiting the loop and
            // tearing down the whole session on a Stop that arrived while
            // the queue was idle.
            const signal = this.abortController.signal
            const batch = await this.session.queue.waitForMessagesAndGetAsString(signal)
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue
                break
            }

            // Snapshot before any await in this iteration (ported from dsh):
            // a user stop that lands while the batch runs — or while the
            // respawn below rebuilds the backend — bumps the generation, and
            // the mismatch is what discards the already-dequeued batch.
            const generationAtDequeue = this.abortGeneration

            // A respawn that failed on an earlier batch leaves no backend
            // behind: rebuild before touching this batch. One fresh attempt
            // per message — a permanently down bridge surfaces one error per
            // message instead of wedging or exiting the loop.
            if (!this.backend || !this.acpSessionId) {
                let reconnected = false
                try {
                    await this.respawnBackend()
                    reconnected = true
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[zcode-acp] reconnect failed', { message })
                    this.session.sendSessionEvent({ type: 'message', message: `ZCode reconnect failed: ${message}` })
                    this.messageBuffer.addMessage(`ZCode reconnect failed: ${message}`, 'status')
                }
                if (!reconnected) {
                    if (this.session.queue.size() === 0 && !this.shouldExit) {
                        this.session.sendSessionEvent({ type: 'ready' })
                    }
                    continue
                }
            }

            // Reference the CURRENT backend/session per iteration (not a
            // const captured at loop start): a respawn swaps both.
            const backend = this.backend!
            const acpSessionId = this.acpSessionId!

            this.applyDisplayMode(batch.mode.permissionMode)
            if (batch.mode.permissionMode !== undefined) {
                await this.applyZcodeAcpMode(backend, acpSessionId, batch.mode.permissionMode)
            }

            const requestedModel = batch.mode.model
            if (requestedModel === null) {
                // Explicit "Default": switch back to the server default
                // captured at session creation. The web picker resets the
                // session model to null and the next queued turn carries it
                // here.
                if (this.initialBackendModel && this.initialBackendModel !== this.currentBackendModel) {
                    const applied = await this.applyModelSwitch(backend, acpSessionId, this.initialBackendModel)
                    if (applied) {
                        batch.mode.model = applied
                    } else {
                        batch.mode.model = this.currentBackendModel ?? undefined
                        this.opts.onModelRollback?.(this.currentBackendModel)
                    }
                } else if (!this.initialBackendModel) {
                    // Nothing captured to go back to — keep the running model
                    // and report it back so the picker does not claim "Default".
                    batch.mode.model = this.currentBackendModel ?? undefined
                    this.opts.onModelRollback?.(this.currentBackendModel)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Cannot reset the ZCode model: the agent did not report a default model.'
                    })
                } else {
                    // Already running the default.
                    batch.mode.model = this.currentBackendModel ?? undefined
                }
            } else if (requestedModel && requestedModel !== this.currentBackendModel) {
                const applied = await this.applyModelSwitch(backend, acpSessionId, requestedModel)
                if (applied) {
                    batch.mode.model = applied
                } else {
                    batch.mode.model = this.currentBackendModel ?? undefined
                    this.opts.onModelRollback?.(this.currentBackendModel)
                }
            }

            this.session.onThinkingChange(true)
            this.messageBuffer.addMessage(batch.message, 'user')
            // Image attachments are read once here (authorized per session)
            // and the built content is reused verbatim by the respawn retry,
            // so a reconnect never re-reads or re-orders the batch's images.
            // Per-image failures are handled inside (status notice + skip);
            // this guard only catches unexpected preparation errors so they
            // degrade to a text-only turn instead of killing the loop.
            let prompt: PromptContent[]
            try {
                prompt = await buildZcodePromptContent(
                    backend,
                    batch.message,
                    batch.mode.imageAttachments,
                    {
                        sessionId: this.session.client.sessionId,
                        onNotice: (message) => this.session.sendSessionEvent({ type: 'message', message })
                    }
                )
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[zcode-acp] prompt preparation failed', { message })
                prompt = [{ type: 'text', text: batch.message }]
            }
            let failureMessage: string | null = null
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[zcode-acp] prompt failed', { message })
                // isAcpIndeterminateError is the transport's own typed marker
                // for failures whose request never reached a JSON-RPC outcome
                // (child exited, transport closed, stdin write failed). For
                // session/prompt — which carries an infinite timeout — that
                // marker means exactly one thing: the zcode-acp-server
                // subprocess died and the closed transport would fail every
                // later request the same way. Regular JSON-RPC rejections do
                // not carry it and keep the surface-and-continue behavior.
                if (isAcpIndeterminateError(error) && !this.shouldExit) {
                    // Rebuild the backend, re-establish the ACP session
                    // (resume re-sends the MCP bridge servers), and retry
                    // THIS batch exactly once (hermes pattern); a failure
                    // here surfaces and falls through — the loop stays alive
                    // and the next message attempts a fresh respawn.
                    let revived = false
                    try {
                        await this.respawnBackend()
                        revived = true
                    } catch (respawnError) {
                        const reconnectMessage = respawnError instanceof Error ? respawnError.message : String(respawnError)
                        logger.warn('[zcode-acp] reconnect failed', { message: reconnectMessage })
                        failureMessage = `ZCode reconnect failed: ${reconnectMessage}`
                    }
                    if (revived) {
                        if (generationAtDequeue !== this.abortGeneration) {
                            // A user stop landed while the replacement backend
                            // was being established (ported from dsh): the
                            // user already saw 'Session aborted' and the queue
                            // was reset, so the retried batch must not run.
                            this.messageBuffer.addMessage('Aborted while reconnecting the ZCode session; dropping the queued message', 'status')
                        } else {
                            // The fresh bridge process lost the dead turn's
                            // session state: re-apply the batch's mode and
                            // model before the retry (establishBackend
                            // already restored the session-stored values; the
                            // dedupes make these no-ops when they match).
                            if (batch.mode.permissionMode !== undefined) {
                                await this.applyZcodeAcpMode(this.backend!, this.acpSessionId!, batch.mode.permissionMode)
                            }
                            const retryModel = batch.mode.model
                            if (retryModel && retryModel !== this.currentBackendModel) {
                                await this.applyModelSwitch(this.backend!, this.acpSessionId!, retryModel)
                            }
                            // Re-assert the thinking state around the retry:
                            // the failed prompt left it asserted, but making
                            // the retry self-contained guarantees the hub
                            // shows the turn as running even if anything reset
                            // it during the reconnect window.
                            this.session.onThinkingChange(true)
                            try {
                                await this.backend!.prompt(this.acpSessionId!, prompt, (message) => this.handleAgentMessage(message))
                            } catch (retryError) {
                                const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
                                logger.warn('[zcode-acp] prompt failed after reconnect', { message: retryMessage })
                                failureMessage = `ZCode prompt failed after reconnect: ${retryMessage}`
                            }
                        }
                    }
                } else {
                    failureMessage = `ZCode prompt failed: ${message}`
                }
            }
            if (failureMessage !== null) {
                this.session.sendSessionEvent({ type: 'message', message: failureMessage })
                this.messageBuffer.addMessage(failureMessage, 'status')
            }
            this.session.onThinkingChange(false)
            await this.permissionHandler?.cancelAll('Prompt finished')
            if (this.session.queue.size() === 0 && !this.shouldExit) {
                this.session.sendSessionEvent({ type: 'ready' })
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        await this.permissionHandler?.cancelAll('Session ended')
        this.permissionHandler = null
        await this.backend?.disconnect()
        this.backend = null
        if (this.happyServer) {
            this.happyServer.stop()
            this.happyServer = null
        }
    }

    /**
     * Create a zcode backend and drive it to a live, fully configured ACP
     * session: initialize → credentials readiness probe → resume-or-new
     * session → pin + flush zcodeSessionId → native title sync → model
     * discovery/override → catalog readiness → zcode mode.
     *
     * Shared by the initial launch and by post-death respawns. The `respawn`
     * flag only changes model handling: an initial establishment captures the
     * server default and applies the spawn-time override, while a respawn
     * keeps the captured default and re-applies the LIVE user preference
     * (the bridge re-asserts its own remembered choice on resume too — this
     * is the HAPI-side belt-and-braces for values the bridge never saw).
     *
     * The permission handler is created BEFORE initialize (hermes lesson):
     * agents may re-offer pending permission cards as
     * session/request_permission during initialize/resume — BEFORE the RPC
     * resolves — and a backend with no registered handler would answer them
     * away. Registered early, the re-offered cards surface as real HAPI
     * cards and answers travel on THIS backend.
     */
    private async establishBackend(opts: { respawn: boolean }): Promise<void> {
        const backend = this.spawnBackend()
        this.backend = backend
        this.acpSessionId = null

        // Auto-approval consults the LIVE session mode: a mid-turn switch to
        // yolo starts auto-approving request_permission immediately, while
        // the zcode mode axis (session/set_mode) catches up at the next turn
        // boundary below.
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.session.getPermissionMode() as PermissionMode | undefined
        )

        // Foreign mode changes arrive as current_mode_update while this
        // backend is attached (the bridge emits them on every attached
        // client when another surface switched the mode).
        backend.setCurrentModeUpdateListener?.((update) => this.handleZcodeModeUpdate(update))

        // Adopt the pending handshake armed before this establishment began
        // (a query that parked during the bridge build or the respawn
        // teardown must be answered by THIS establishment); when the standing
        // handshake is settled — a finished or failed earlier establishment —
        // arm a fresh one. The backend rebind happens before any await below,
        // so a resolve can only ever surface the establishment's own backend.
        const readiness = (!this.modelsReadiness || this.modelsReadiness.settled)
            ? this.armModelsReadiness()
            : this.modelsReadiness
        readiness.backend = backend

        let acpSessionId: string
        try {
            await backend.initialize()
            await this.checkCredentials(backend)

            const resumeSessionId = this.session.sessionId
            if (resumeSessionId) {
                try {
                    // Resume is ACP session/resume (NOT session/load — the
                    // bridge's lazy session ids are stable across bridge
                    // restarts, and session/resume is the verified restore
                    // path). Editor clients get no history replay from the
                    // bridge ("no history by ACP design" for non-TUI
                    // clients), so no suppression window is needed — the
                    // hub stays the transcript source simply because nothing
                    // is re-sent. mcpServers ride EVERY resume: the bridge
                    // remembers them as session-lifetime state and re-sends
                    // them to its backend on each reload.
                    if (!backend.supportsSessionResume()) {
                        throw new Error('ZCode ACP server does not advertise session/resume')
                    }
                    acpSessionId = await backend.resumeSession({
                        sessionId: resumeSessionId,
                        cwd: this.session.path,
                        mcpServers: this.acpMcpServers
                    })
                } catch (error) {
                    logger.warn('[zcode-acp] resume failed; starting a new session', error)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'ZCode session was not found on the agent; starting a new session.'
                    })
                    acpSessionId = await backend.newSession({
                        cwd: this.session.path,
                        mcpServers: this.acpMcpServers
                    })
                }
            } else {
                acpSessionId = await backend.newSession({
                    cwd: this.session.path,
                    mcpServers: this.acpMcpServers
                })
            }
            this.acpSessionId = acpSessionId
            this.session.onSessionFound(acpSessionId)
            // Pin zcodeSessionId before the main loop so a runner restart can
            // resume (ported from dsh/hermes: gate until the metadata write
            // reaches the hub — a SIGTERM before that strands the session
            // with no resume key). Re-pinning after a respawn is an
            // idempotent metadata merge.
            const flushed = await this.session.client.flushMetadata()
            if (!flushed) {
                logger.warn(`[zcode-acp] zcodeSessionId metadata write did not ACK within the flush window (acpSessionId=${acpSessionId})`)
            }
            // Native titles: the bridge maintains its own session title and
            // pushes session_info_update — mirror it into the HAPI session
            // summary (zcode is NOT on the no-native-title list).
            registerAcpSessionTitleSync(backend, this.session.client)
        } catch (error) {
            readiness.reject(error)
            throw error
        }

        const modelOption = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!opts.respawn) {
            // Capture the server default BEFORE applying any override: an
            // explicit "Default" reset later in the session (queued as
            // model: null) switches back to this value; without it the reset
            // would silently keep the last explicitly-applied model.
            this.initialBackendModel = modelOption?.currentValue ?? null
            if (this.opts.model && modelOption) {
                this.currentBackendModel = await this.applyModelSwitch(backend, acpSessionId, this.opts.model)
            }
            if (!this.currentBackendModel) {
                this.currentBackendModel = this.initialBackendModel
            }
            this.opts.onConfigDiscovered?.(this.currentBackendModel)
        } else if (this.currentBackendModel && modelOption && modelOption.currentValue !== this.currentBackendModel) {
            // The respawned bridge starts from its own remembered state;
            // re-apply the live user preference so the retried batch runs on
            // the model the session is showing.
            await this.applyModelSwitch(backend, acpSessionId, this.currentBackendModel)
        }
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }
        readiness.resolve(acpSessionId)

        const sessionPermissionMode = this.session.getPermissionMode() as PermissionMode | undefined
        this.applyDisplayMode(sessionPermissionMode)
        // Inspect the mode the bridge itself reports for this session (seeded
        // by the backend from the resume/new response's modes block and any
        // live current_mode_update): a respawned bridge may have started at
        // its own default — or another surface changed the mode while this
        // client was detached. Seeding the dedupe from the OBSERVED mode
        // means the set_mode below only fires when zcode actually differs
        // from what HAPI wants, and a mismatch is surfaced as a re-assert.
        const observedMode = backend.getSessionCurrentMode?.(acpSessionId)
        if (observedMode) {
            const desiredAcpMode = ZCODE_ACP_MODE_BY_PERMISSION[sessionPermissionMode ?? 'default'] ?? 'build'
            if (observedMode !== desiredAcpMode) {
                this.session.sendSessionEvent({
                    type: 'message',
                    message: 'ZCode mode changed elsewhere; re-asserting'
                })
                this.messageBuffer.addMessage('ZCode mode changed elsewhere; re-asserting', 'status')
                this.lastForeignModeNotice = observedMode
            }
            this.lastAppliedAcpMode = observedMode
            logger.debug(`[zcode-acp] zcode reported current mode ${observedMode}`)
        }
        await this.applyZcodeAcpMode(backend, acpSessionId, sessionPermissionMode)
    }

    /**
     * Credentials readiness probe. initialize advertises exactly one
     * authMethod (`zcode-credentials`) whose `_client/authenticate` call is
     * a readiness check: credentials present (the ZCode desktop app's
     * ~/.zcode/v2 or a saved account) → {}; absent → an error whose message
     * says how to get them. `authenticateIfAvailable` would swallow that
     * failure into a debug log — surface it as a status line instead so the
     * user knows why every turn will fail. A method-not-found answer means
     * a custom wrapper does not implement the probe: skip silently.
     */
    private async checkCredentials(backend: ReturnType<typeof createZcodeBackend>): Promise<void> {
        try {
            await backend.authenticate(ZCODE_AUTH_METHOD_ID)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/method not found|-32601/i.test(message)) {
                return
            }
            logger.warn('[zcode-acp] credentials check failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `ZCode credentials are not available: ${message}`
            })
            this.messageBuffer.addMessage(`ZCode credentials are not available: ${message}`, 'status')
        }
    }

    /**
     * `current_mode_update` from the CURRENT backend: the bridge emits it
     * when another surface changed the session's mode. Echoes of our own
     * session/set_mode are filtered (applyingAcpMode / lastAppliedAcpMode);
     * a genuinely foreign mode drops the apply-dedupe so the next queued
     * batch re-asserts HAPI's mode, and says so once per distinct foreign
     * mode (repeated echoes of the same mode stay quiet).
     */
    private handleZcodeModeUpdate(update: { sessionId: string | null; currentModeId: string }): void {
        if (update.currentModeId === this.applyingAcpMode) return
        if (update.currentModeId === this.lastAppliedAcpMode) return
        if (update.currentModeId === this.lastForeignModeNotice) return
        this.lastForeignModeNotice = update.currentModeId
        logger.warn('[zcode-acp] zcode mode changed elsewhere', { currentModeId: update.currentModeId })
        this.session.sendSessionEvent({
            type: 'message',
            message: 'ZCode mode changed elsewhere; re-asserting'
        })
        this.messageBuffer.addMessage('ZCode mode changed elsewhere; re-asserting', 'status')
        // Drop the dedupe: the next batch re-issues session/set_mode with the
        // HAPI-side preference.
        this.lastAppliedAcpMode = null
    }

    /**
     * Arm a fresh pending readiness handshake, make it current, and return
     * it. Called before the bridge build (pre-first-establishment
     * placeholder) and at the top of every respawn (before the teardown
     * awaits): catalog queries that arrive in those windows park on it.
     * establishBackend adopts the pending handshake, rebinds its backend,
     * and settles it with the establishment's outcome.
     */
    private armModelsReadiness(): ZcodeModelsReadiness {
        let markReady!: (acpSessionId: string) => void
        let markFailed!: (error: unknown) => void
        const ready = new Promise<string>((resolve, reject) => {
            markReady = resolve
            markFailed = reject
        })
        // A failing establishment rejects `ready` through the reject wrapper;
        // with no catalog query parked on it yet, that rejection would
        // otherwise surface as an unhandled promise rejection.
        ready.catch(() => {})
        const readiness: ZcodeModelsReadiness = {
            backend: null,
            promise: ready,
            settled: false,
            resolve: (acpSessionId) => {
                readiness.settled = true
                markReady(acpSessionId)
            },
            reject: (error) => {
                readiness.settled = true
                markFailed(error)
            }
        }
        this.modelsReadiness = readiness
        return readiness
    }

    /**
     * Tear down a dead backend and re-establish the ACP session on a fresh
     * zcode-acp-server child process.
     *
     * Once the bridge subprocess dies its transport is closed permanently —
     * every request on it rejects immediately — so recovery requires a
     * brand-new backend: initialize, resume the persisted lazy session id
     * (stable across bridge restarts, MCP servers re-sent), re-apply the
     * current model preference and zcode mode, and re-arm the catalog
     * readiness. Posts exactly one 'connection lost; reconnecting' status
     * line per attempt.
     *
     * Throws when re-establishment fails; `this.backend` is then null so the
     * next message starts a fresh attempt instead of reusing the corpse.
     */
    private async respawnBackend(): Promise<void> {
        if (this.respawnInProgress) {
            throw new Error('ZCode reconnect already in progress')
        }
        this.respawnInProgress = true
        try {
            this.session.sendSessionEvent({ type: 'message', message: 'ZCode connection lost; reconnecting…' })
            this.messageBuffer.addMessage('ZCode connection lost; reconnecting…', 'status')
            const deadBackend = this.backend
            const deadPermissionHandler = this.permissionHandler
            // Detach everything bound to the dead backend BEFORE rebuilding so
            // concurrent aborts, catalog queries, and the retry below can only
            // ever observe the replacement. The permission handler detaches
            // last: cancelAll settles ITS pending cards first, and the
            // replacement backend registers its own handler inside
            // establishBackend before initialize — the re-offer window is
            // covered from both sides.
            this.backend = null
            this.acpSessionId = null
            this.permissionHandler = null
            deadBackend?.setCurrentModeUpdateListener?.(null)
            // Swap the catalog readiness to a fresh pending handshake BEFORE
            // the teardown awaits below: the standing one is settled on the
            // dead backend, and a picker query that lands while
            // cancelAll/disconnect are still in flight must park here to be
            // answered by the replacement establishment — not be served stale
            // options off the corpse. establishBackend adopts it.
            this.armModelsReadiness()
            // The fresh bridge process starts at its own default mode; clear
            // the dedupe so establishBackend re-issues session/set_mode.
            this.lastAppliedAcpMode = null
            try {
                await deadPermissionHandler?.cancelAll('ZCode connection lost')
            } catch (error) {
                logger.debug('[zcode-acp] permission cancelAll during reconnect failed', error)
            }
            try {
                await deadBackend?.disconnect()
            } catch (error) {
                logger.debug('[zcode-acp] disconnect of dead backend failed', error)
            }
            await this.establishBackend({ respawn: true })
        } catch (error) {
            // establishBackend may have parked a half-initialized backend in
            // this.backend; drop it so the next message rebuilds cleanly.
            const partial = this.backend
            this.backend = null
            this.acpSessionId = null
            // A catalog query that parked during the teardown or the failed
            // rebuild must get the failure, not an eternal park: settle the
            // handshake armed at the top of this respawn (establishBackend
            // already settled its own adoptee, so this is usually a no-op —
            // it covers failures that predate the adopt). The next respawn
            // attempt re-arms.
            const pending = this.modelsReadiness
            if (pending && !pending.settled) {
                pending.reject(error)
            }
            try {
                await partial?.disconnect()
            } catch (disconnectError) {
                logger.debug('[zcode-acp] disconnect of partial backend failed', disconnectError)
            }
            throw error
        } finally {
            this.respawnInProgress = false
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendAgentMessage(converted)

        switch (message.type) {
            case 'text':
                // Interim idle snapshots; the settled text arrives at the
                // segment boundary, which is what belongs in the local log.
                if (message.live) break
                this.messageBuffer.addMessage(message.text, 'assistant')
                break
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant')
                break
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status')
                break
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status')
                break
            case 'usage':
            case 'reasoning':
            case 'tool_call':
            case 'tool_result':
            case 'plan':
                break
            default: {
                const _exhaustive: never = message
                return _exhaustive
            }
        }
    }

    /** Mirrors the effective permission mode into the terminal log so remote
     *  sessions show what the bridge will auto-approve (kimi-style). */
    private applyDisplayMode(permissionMode: PermissionMode | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system')
        }
    }

    /**
     * Push the HAPI permission mode onto zcode's own mode axis via
     * session/set_mode (default→build, read-only→plan, safe-yolo→guarded,
     * yolo→yolo). syncThoughtLevel stays false: zcode models expose
     * per-model thought variants through a separate config option, and the
     * mode push must not pollute it. No-op when the mode is unchanged;
     * failures degrade to a status note because the HAPI permission bridge
     * still honors the mode on its side.
     */
    private async applyZcodeAcpMode(
        backend: ReturnType<typeof createZcodeBackend>,
        acpSessionId: string,
        permissionMode: PermissionMode | undefined
    ): Promise<void> {
        const acpMode = ZCODE_ACP_MODE_BY_PERMISSION[permissionMode ?? 'default'] ?? 'build'
        if (acpMode === this.lastAppliedAcpMode) return
        this.applyingAcpMode = acpMode
        try {
            await backend.setMode(acpSessionId, acpMode, { syncThoughtLevel: false })
            this.lastAppliedAcpMode = acpMode
            // Our own mode is authoritative again — a later
            // current_mode_update reporting something else is a NEW foreign
            // change.
            this.lastForeignModeNotice = null
            logger.debug(`[zcode-acp] Applied zcode mode via set_mode: ${acpMode}`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[zcode-acp] set_mode failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `ZCode mode switch failed: ${message}`
            })
        } finally {
            this.applyingAcpMode = null
        }
    }

    /**
     * Switch the ZCode model through `session/set_config_option` on the
     * `model` option (category model, verified bridge shape). Model ids are
     * opaque `providerId\modelId` values sent back verbatim; unknown ids
     * fail loud. Returns the applied model, or null when the switch failed
     * (caller keeps the previous model).
     */
    private async applyModelSwitch(
        backend: ReturnType<typeof createZcodeBackend>,
        acpSessionId: string,
        model: string
    ): Promise<string | null> {
        const option = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!option) {
            logger.warn('[zcode-acp] Cannot switch model: agent exposes no model config option')
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Cannot switch model: the ZCode agent exposes no model config option.'
            })
            return null
        }
        try {
            await backend.setConfigOption(acpSessionId, option.id, model)
            this.currentBackendModel = model
            this.messageBuffer.addMessage(`[MODEL:${model}]`, 'system')
            return model
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[zcode-acp] model switch failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch ZCode model: ${message}`
            })
            return null
        }
    }

    private async handleAbort(): Promise<void> {
        // Bump first, synchronously (ported from dsh): the prompt-catch
        // respawn branch compares generations around its respawnBackend
        // `await` to detect aborts that land inside that window.
        this.abortGeneration += 1
        // Tear the wait down synchronously FIRST (ported from dsh):
        // aborting and replacing the controller unparks a waiting loop
        // iteration via its captured signal, and resetting the queue before
        // the awaits drops anything queued ahead of the stop — a message
        // dequeued while the cancel requests are still on the wire must not
        // run after the user already saw "Session aborted".
        this.abortController.abort()
        this.abortController = new AbortController()
        this.session.queue.reset()
        // Reads the CURRENT backend: after a respawn this cancels on the
        // replacement; mid-respawn it is null and the skip is correct (the
        // dead transport cannot accept a cancel anyway). The backend's
        // standard cancelMode sends the session/cancel NOTIFICATION —
        // exactly what the zcode bridge expects (it cancels the in-flight
        // turn and keeps the session alive); there is deliberately no
        // close fallback.
        if (this.backend && this.session.sessionId) {
            await this.backend.cancelPrompt(this.session.sessionId)
        }
        await this.permissionHandler?.cancelAll('User aborted')
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' })
        this.session.onThinkingChange(false)
        this.messageBuffer.addMessage('Turn aborted', 'status')
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort())
    }
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({
        name,
        command: entry.command,
        args: entry.args,
        env: []
    }))
}

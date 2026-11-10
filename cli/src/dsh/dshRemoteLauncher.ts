import React from 'react'
import { RPC_METHODS } from '@hapi/protocol'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, PromptContent } from '@/agent/types'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import type { PermissionMode } from '@hapi/protocol/types'
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import { createDshBackend } from './utils/dshBackend'
import { isPeerToolsDisabled, withPeerToolsPreference } from '@/modules/common/peerTools'
import type { DshSession } from './session'

/**
 * Readiness handshake for the ListDshModels catalog RPC (registered once
 * per launcher in runMainLoop). Replaced on every backend (re)establishment
 * so a picker query that arrives mid-respawn parks until the replacement
 * session exists and model discovery has settled — and one that arrives
 * while a respawn fails gets the failure instead of hanging forever. The
 * backend of the establishment the promise belongs to travels with it: the
 * handler must query metadata on the backend that captured that session,
 * which a respawn swap keeps visible to parked queries.
 */
type ModelsReadiness = {
    backend: ReturnType<typeof createDshBackend>
    promise: Promise<string>
    resolve: (acpSessionId: string) => void
    reject: (error: unknown) => void
}

export class DshRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createDshBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    private currentBackendModel: string | null = null
    /** Server default captured at session creation, before any override. */
    private initialBackendModel: string | null = null
    /** ACP session id on the CURRENT backend — swapped by every respawn so
     * the main loop, abort path, and catalog RPC never act on a stale one. */
    private acpSessionId: string | null = null
    private modelsReadiness: ModelsReadiness | null = null
    /** Guards against concurrent backend rebuilds (prompt retry vs abort). */
    private respawnInProgress = false

    constructor(
        private readonly session: DshSession,
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

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, {
            ...context,
            agentLabel: 'DeepSeek Harness'
        })
    }

    protected async runMainLoop(): Promise<void> {
        // Register the catalog RPC before initialization: a client that opens
        // the model picker while initialize/session/new is still pending
        // would otherwise hit an unregistered-method rejection, and the
        // picker has no retry path — it would stay empty until remounted.
        // The handler parks on readiness and answers once the session exists
        // and model discovery has settled, using the backend of whichever
        // establishment resolved it — a respawn swap is always visible.
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListDshModels, async () => {
            const readiness = this.modelsReadiness
            if (!readiness) {
                return { success: false, error: 'DSH session is not available' }
            }
            let acpSessionId: string
            try {
                acpSessionId = await readiness.promise
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `DSH session is not available: ${message}` }
            }
            const metadata = readiness.backend.getSessionModelsMetadata(acpSessionId)
            if (!metadata) {
                return { success: false, error: 'DSH model metadata is not available' }
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: this.currentBackendModel ?? metadata.currentModelId
            }
        })

        await this.establishBackend({ respawn: false })

        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })

        while (!this.shouldExit) {
            // Capture the signal per iteration: handleAbort swaps in a fresh
            // AbortController right after aborting, so re-reading
            // this.abortController.signal below would see the replacement
            // (never aborted) and mistake an aborted wait for a closed queue,
            // exiting the loop. The captured signal stays aborted forever.
            const signal = this.abortController.signal
            const batch = await this.session.queue.waitForMessagesAndGetAsString(signal)
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue
                break
            }

            // A respawn that failed on an earlier batch leaves no backend
            // behind: rebuild before touching this batch. One fresh attempt
            // per message — a permanently down dsh surfaces one error per
            // message instead of wedging or exiting the loop.
            if (!this.backend || !this.acpSessionId) {
                let reconnected = false
                try {
                    await this.respawnBackend()
                    reconnected = true
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[dsh-acp] reconnect failed', { message })
                    this.session.sendSessionEvent({ type: 'message', message: `DSH reconnect failed: ${message}` })
                    this.messageBuffer.addMessage(`DSH reconnect failed: ${message}`, 'status')
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

            const requestedModel = batch.mode.model
            if (requestedModel === null) {
                // Explicit "Default": switch back to the server default captured
                // at session creation. The web picker resets the session model
                // to null and the next queued turn carries it here.
                if (this.initialBackendModel && this.initialBackendModel !== this.currentBackendModel) {
                    const applied = await this.applyModelSwitch(backend, acpSessionId, this.initialBackendModel)
                    if (applied) {
                        batch.mode.model = applied
                    } else {
                        batch.mode.model = this.currentBackendModel ?? undefined
                        this.opts.onModelRollback?.(this.currentBackendModel)
                    }
                } else if (!this.initialBackendModel) {
                    // Nothing captured to go back to — keep the running model and
                    // report it back so the picker does not claim "Default".
                    batch.mode.model = this.currentBackendModel ?? undefined
                    this.opts.onModelRollback?.(this.currentBackendModel)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Cannot reset the DSH model: the agent did not report a default model.'
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
            const prompt: PromptContent[] = [{ type: 'text', text: batch.message }]
            let failureMessage: string | null = null
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[dsh-acp] prompt failed', { message })
                // isAcpIndeterminateError is the transport's own typed marker
                // for failures whose request never reached a JSON-RPC outcome
                // (child exited, transport closed, stdin write failed). For
                // session/prompt — which carries an infinite timeout — that
                // marker means exactly one thing: the dsh child process died
                // (crash, upgrade, or a legacy dsh 0.2.0/0.2.1 that still
                // exits its process on session/cancel), and the closed
                // transport would fail every later request the same way. The
                // persisted on-disk session survives the process death
                // (verified against dsh 0.2.2: kill → session/resume restores
                // every prior turn), so rebuilding the backend and resuming
                // keeps the conversation. Regular JSON-RPC rejections
                // (unknown session, etc.) do not carry the marker and keep
                // the old surface-and-continue behavior.
                if (isAcpIndeterminateError(error) && !this.shouldExit) {
                    // Rebuild the backend, re-establish the ACP session, and
                    // retry THIS batch exactly once; a failure here surfaces
                    // and falls through — the loop stays alive and the next
                    // message attempts a fresh respawn.
                    let revived = false
                    try {
                        await this.respawnBackend()
                        revived = true
                    } catch (respawnError) {
                        const reconnectMessage = respawnError instanceof Error ? respawnError.message : String(respawnError)
                        logger.warn('[dsh-acp] reconnect failed', { message: reconnectMessage })
                        failureMessage = `DSH reconnect failed: ${reconnectMessage}`
                    }
                    if (revived) {
                        try {
                            await this.backend!.prompt(this.acpSessionId!, prompt, (message) => this.handleAgentMessage(message))
                        } catch (retryError) {
                            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
                            logger.warn('[dsh-acp] prompt failed after reconnect', { message: retryMessage })
                            failureMessage = `DSH prompt failed after reconnect: ${retryMessage}`
                        }
                    }
                } else {
                    failureMessage = `DSH prompt failed: ${message}`
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
    }

    /**
     * Create a dsh backend and drive it to a live, fully configured ACP
     * session: initialize → resume-or-new session → pin + flush
     * dshSessionId → model discovery/override → catalog readiness →
     * permission handler.
     *
     * Shared by the initial launch and by post-death respawns. The `respawn`
     * flag only changes model handling: an initial establishment captures the
     * server default and applies the spawn-time override, while a respawn
     * keeps the captured default and re-applies the LIVE user preference.
     */
    private async establishBackend(opts: { respawn: boolean }): Promise<void> {
        const backend = createDshBackend(withPeerToolsPreference(this.session.client.peerToolsDisabled ?? isPeerToolsDisabled()))
        this.backend = backend
        this.acpSessionId = null
        backend.onStderrError((error) => {
            logger.debug('[dsh-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })

        let markReady!: (acpSessionId: string) => void
        let markFailed!: (error: unknown) => void
        const ready = new Promise<string>((resolve, reject) => {
            markReady = resolve
            markFailed = reject
        })
        // A failing establishment rejects `ready` through markFailed below;
        // with no catalog query parked on it yet, that rejection would
        // otherwise surface as an unhandled promise rejection.
        ready.catch(() => {})
        this.modelsReadiness = { backend, promise: ready, resolve: markReady, reject: markFailed }

        let acpSessionId: string
        try {
            await backend.initialize()
            const resumeSessionId = this.session.sessionId
            if (resumeSessionId && backend.supportsSessionResume()) {
                try {
                    // DSH's current ACP profile exposes the non-standard
                    // `session/resume` method rather than ACP's `session/load`.
                    // It restores model context but intentionally emits no
                    // history; HAPI's Hub remains the transcript source for
                    // the UI — so no replay suppression is needed here
                    // (unlike Hermes, which replays its history on resume).
                    acpSessionId = await backend.resumeSession({
                        sessionId: resumeSessionId,
                        cwd: this.session.path,
                        // Same as session/new: the official DSH ACP composition
                        // rejects non-empty MCP servers.
                        mcpServers: []
                    })
                    this.messageBuffer.addMessage('DSH session resumed', 'status')
                } catch (error) {
                    // The on-disk dsh session may be gone (cleaned ~/.dsh,
                    // version migration): start fresh instead of stranding
                    // the HAPI session.
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[dsh-acp] session/resume failed; starting a fresh session', { message })
                    acpSessionId = await backend.newSession({
                        cwd: this.session.path,
                        mcpServers: []
                    })
                    this.messageBuffer.addMessage('DSH resume failed; started a fresh session', 'status')
                }
            } else {
                acpSessionId = await backend.newSession({
                    cwd: this.session.path,
                    // The official DSH ACP composition rejects non-empty MCP
                    // servers; its tools are configured by the DSH server
                    // itself.
                    mcpServers: []
                })
            }
            this.acpSessionId = acpSessionId
            // Pin dshSessionId before the main loop so a runner restart can
            // resume (tiann/hapi#913: gate until the metadata write reaches
            // the hub — a SIGTERM before that strands the session). Persist
            // even when the id matches the requested resume: an explicit
            // `--resume` on a fresh HAPI row must still store it, and
            // re-pinning a stored id is an idempotent metadata merge.
            this.session.onSessionFound(acpSessionId)
            const flushed = await this.session.client.flushMetadata()
            if (!flushed) {
                logger.warn(`[dsh-acp] dshSessionId metadata write did not ACK within the flush window (acpSessionId=${acpSessionId})`)
            }
        } catch (error) {
            markFailed(error)
            throw error
        }

        const modelOption = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!opts.respawn) {
            // Capture the server default BEFORE applying any override: an
            // explicit "Default" reset later in the session (queued as
            // model: null) switches back to this value; without it the reset
            // would silently keep the last explicitly-applied model.
            this.initialBackendModel = modelOption?.currentValue
                ?? backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
                ?? null
            if (this.opts.model && modelOption) {
                this.currentBackendModel = await this.applyModelSwitch(backend, acpSessionId, this.opts.model)
            }
            if (!this.currentBackendModel) {
                this.currentBackendModel = this.initialBackendModel
            }
            this.opts.onConfigDiscovered?.(this.currentBackendModel)
        } else if (this.currentBackendModel && modelOption && modelOption.currentValue !== this.currentBackendModel) {
            // The respawned process starts from whatever dsh persisted in the
            // session record; re-apply the live user preference so the
            // retried batch runs on the model the session is showing.
            await this.applyModelSwitch(backend, acpSessionId, this.currentBackendModel)
        }
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }
        markReady(acpSessionId)

        // The session's current permission mode drives auto-approval
        // decisions (e.g. yolo approves for the session); without this,
        // every DSH permission request escalates to a permission card.
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.session.getPermissionMode() as PermissionMode | undefined
        )
    }

    /**
     * Tear down a dead backend and re-establish the ACP session on a fresh
     * `dsh --profile acp` child process.
     *
     * Once the ACP child dies (crash, upgrade, or a legacy dsh that exits on
     * session/cancel) its transport is closed permanently — every request on
     * it rejects immediately — so recovery requires a brand-new backend:
     * initialize, resume the persisted on-disk session id (dsh sessions are
     * durable; resume restores the full conversation — verified against dsh
     * 0.2.2), re-apply the current model preference, and re-arm the catalog
     * readiness. Posts exactly one 'connection lost; reconnecting' status
     * line per attempt.
     *
     * Throws when re-establishment fails; `this.backend` is then null so the
     * next message starts a fresh attempt instead of reusing the corpse.
     */
    private async respawnBackend(): Promise<void> {
        if (this.respawnInProgress) {
            throw new Error('DSH reconnect already in progress')
        }
        this.respawnInProgress = true
        try {
            this.session.sendSessionEvent({ type: 'message', message: 'DSH connection lost; reconnecting…' })
            this.messageBuffer.addMessage('DSH connection lost; reconnecting…', 'status')
            const deadBackend = this.backend
            const deadPermissionHandler = this.permissionHandler
            // Detach everything bound to the dead backend BEFORE rebuilding so
            // concurrent aborts, catalog queries, and the retry below can only
            // ever observe the replacement.
            this.backend = null
            this.acpSessionId = null
            this.permissionHandler = null
            try {
                await deadPermissionHandler?.cancelAll('DSH connection lost')
            } catch (error) {
                logger.debug('[dsh-acp] permission cancelAll during reconnect failed', error)
            }
            try {
                await deadBackend?.disconnect()
            } catch (error) {
                logger.debug('[dsh-acp] disconnect of dead backend failed', error)
            }
            await this.establishBackend({ respawn: true })
        } catch (error) {
            // establishBackend may have parked a half-initialized backend in
            // this.backend; drop it so the next message rebuilds cleanly.
            const partial = this.backend
            this.backend = null
            this.acpSessionId = null
            try {
                await partial?.disconnect()
            } catch (disconnectError) {
                logger.debug('[dsh-acp] disconnect of partial backend failed', disconnectError)
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

    /**
     * Switch the DSH model through `session/set_config_option` — dsh does not
     * implement `session/set_model` (verified against 0.2.0-rc.2: -32601).
     * Model ids are opaque config-option values (JSON provider+model tuples)
     * and are sent back verbatim; unknown ids fail loud with -32602.
     * Returns the applied model, or null when the switch failed (caller keeps
     * the previous model).
     */
    private async applyModelSwitch(
        backend: ReturnType<typeof createDshBackend>,
        acpSessionId: string,
        model: string
    ): Promise<string | null> {
        const option = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!option) {
            logger.warn('[dsh-acp] Cannot switch model: agent exposes no model config option')
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Cannot switch model: the DSH agent exposes no model config option.'
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
            logger.warn('[dsh-acp] model switch failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch DSH model: ${message}`
            })
            return null
        }
    }

    private async handleAbort(): Promise<void> {
        // Tear the wait down synchronously FIRST: aborting (and replacing)
        // the controller unparks a waiting loop iteration via its captured
        // signal, and resetting the queue before the awaits drops anything
        // queued ahead of the stop — a message dequeued while the cancel
        // notification is still on the wire must not run after the user
        // already saw "Session aborted".
        this.abortController.abort()
        this.abortController = new AbortController()
        this.session.queue.reset()
        // Reads the CURRENT backend: after a respawn this cancels on the
        // replacement; mid-respawn it is null and the skip is correct (the
        // dead transport cannot accept a cancel anyway).
        //
        // dsh ≥0.2.2 handles session/cancel as a regular ACP notification —
        // it cancels the in-flight turn and keeps BOTH the process and the
        // ACP session alive, so the next message continues the same
        // conversation (verified against 0.2.2: cancel → prompt on the same
        // session still has every prior turn). Legacy dsh 0.2.0/0.2.1 exits
        // its process on session/cancel; that is equally recoverable — the
        // persisted on-disk session survives the process death, and the
        // prompt-failure respawn below rebuilds and resumes it. session/close
        // must NEVER be used to abort: on dsh ≥0.2.2 it destroys the session
        // (session/resume afterwards restores an EMPTY context — the
        // interrupt-amnesia bug this handling replaced).
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

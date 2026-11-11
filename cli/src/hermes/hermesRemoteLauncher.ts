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
import { isPeerToolsDisabled, withPeerToolsPreference } from '@/modules/common/peerTools'
import { createHermesBackend } from './utils/hermesBackend'
import { buildHermesPromptContent } from './utils/hermesPromptContent'
import { escapeHermesDestructiveSlash } from './utils/hermesSlashGuard'
import {
    HERMES_RESUME_TIMEOUT_MS,
    isHermesResumeUnsupportedError,
    isHermesSessionGoneError
} from './utils/hermesResume'
import type { HermesSession } from './session'

/** Hermes ACP edit-approval axis (acp_adapter/modes.py). Sensitive paths still
 * emit request_permission in every mode — the HAPI-side bridge decides those. */
const HERMES_EDIT_MODE_BY_PERMISSION: Record<string, string> = {
    default: 'default',
    'safe-yolo': 'accept_edits',
    yolo: 'dont_ask'
}

/**
 * Readiness handshake for the ListHermesModels catalog RPC (registered once
 * per launcher in runMainLoop). A pending placeholder is armed BEFORE the
 * awaited bridge build and again at the top of every respawn, so a picker
 * query that arrives in those windows parks instead of eating a terminal
 * error (or stale metadata off a dying backend); each establishment adopts
 * the pending handshake, rebinds it to its own backend, and settles it —
 * and a respawn that fails settles it with the failure instead of hanging
 * forever. The backend of the establishment that resolves the promise
 * travels with it: the handler must query metadata on the backend that
 * captured that session, which a respawn swap keeps visible to parked
 * queries.
 */
type ModelsReadiness = {
    /** Backend of the establishment that settles `promise`; null while the
     * handshake is a pre-establishment placeholder (establishBackend rebinds
     * it before the promise can ever resolve). */
    backend: ReturnType<typeof createHermesBackend> | null
    promise: Promise<string>
    resolve: (acpSessionId: string) => void
    reject: (error: unknown) => void
    /** True once resolve/reject ran: a settled handshake can never re-arm,
     * so the next establishment replaces the object instead of adopting it. */
    settled: boolean
}

export class HermesRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createHermesBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    /** Bumped at the top of every handleAbort (ported from dsh); lets the
     * prompt-catch respawn branch detect an abort that landed while the
     * replacement backend was being established and drop the retried batch. */
    private abortGeneration = 0
    private currentBackendModel: string | null = null
    /** Live reasoning-effort preference in Hermes's wire domain ('default' =
     *  Provider default); re-applied on respawn. null = none tracked. */
    private currentReasoningEffort: string | null = null
    /** Server default captured at session creation, before any override. */
    private initialBackendModel: string | null = null
    private lastAppliedEditMode: string | null = null
    /** Edit mode currently being pushed via session/set_mode — the async
     * current_mode_update echo of OUR OWN switch must not be mistaken for a
     * foreign change while this is set. */
    private applyingEditMode: string | null = null
    /** Last foreign mode a "changed elsewhere" notice was emitted for —
     * suppresses repeat notices for repeated echoes of the same change. */
    private lastForeignModeNotice: string | null = null
    private displayPermissionMode: PermissionMode | undefined
    /** ACP session id on the CURRENT backend — swapped by every respawn so
     * the main loop, abort path, and catalog RPC never act on a stale one. */
    private acpSessionId: string | null = null
    private modelsReadiness: ModelsReadiness | null = null
    /** Guards against concurrent backend rebuilds (prompt retry vs abort). */
    private respawnInProgress = false
    /** HAPI MCP bridge HTTP server; mounted into every (re)established session. */
    private happyServer: { stop: () => void } | null = null
    /** ACP form of the hapi MCP bridge servers (name/command/args/env). */
    private acpMcpServers: McpServerStdio[] = []

    constructor(
        private readonly session: HermesSession,
        private readonly opts: {
            /** Spawn-time model override (opaque ACP config-option value). */
            model?: string
            onModelRollback?: (model: string | null) => void
            onConfigDiscovered?: (model: string | null) => void
            /** A reasoning-effort switch failed (or the model exposes no
             * thought_level option): the argument is the live effort
             * preference in the picker's domain — undefined = none tracked,
             * null = "Default"/provider default, string = a concrete value.
             * The host resets its tracking and re-syncs so the hub picker
             * stops showing the failed value and later turns stop
             * re-requesting it (mirror of onModelRollback). */
            onEffortRollback?: (effort: string | null | undefined) => void
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
            agentLabel: 'Hermes'
        })
    }

    protected async runMainLoop(): Promise<void> {
        // Seed a pending placeholder BEFORE the awaited bridge build: the
        // handler below is registered immediately, and a picker query that
        // lands while the bridge HTTP server is still being built must park
        // on the placeholder — not get a terminal "not available" answer —
        // and be answered by the first establishment (which adopts it).
        this.armModelsReadiness()
        // Register the catalog RPC before initialization: a client that opens
        // the model picker while initialize/session/new is still pending
        // would otherwise hit an unregistered-method rejection, and the
        // picker has no retry path — it would stay empty until remounted.
        // The handler parks on readiness and answers once the session exists
        // and model discovery has settled, using the backend of whichever
        // establishment resolved it — a respawn swap is always visible.
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListHermesModels, async () => {
            const readiness = this.modelsReadiness
            if (!readiness) {
                return { success: false, error: 'Hermes session is not available' }
            }
            let acpSessionId: string
            try {
                acpSessionId = await readiness.promise
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `Hermes session is not available: ${message}` }
            }
            const metadata = readiness.backend?.getSessionModelsMetadata(acpSessionId)
            if (!metadata) {
                return { success: false, error: 'Hermes model metadata is not available' }
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: this.currentBackendModel ?? metadata.currentModelId
            }
        })

        // Hermes mounts client MCP servers as the session's "editor MCP" on
        // BOTH session/new and session/resume (verified in the hermes ACP
        // source) — the old `mcpServers: []` sites pinned a stale claim that
        // v1 did not bridge MCP, the same class of myth the dsh launcher
        // carried until v29.3. Bridge the hapi MCP tools exactly like the
        // dsh/kimi/copilot/grok ACP flavors: the bridge HTTP server is built
        // ONCE per launcher and every (re)establishment passes the same
        // server list, so a respawn remounts the tools cleanly (each fresh
        // `hermes acp` child mounts its own stdio bridge process via
        // `--tools`, which also gates the exposed tool set). Peer-tools
        // gating matches the other flavors: the backend env gets the
        // session's captured preference, and buildHapiMcpBridge itself drops
        // list_peers from the auto-approved shortlist when disabled.
        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(this.session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: this.session.path, flavor: 'hermes' },
            // Hermes's automation-only ACP profile has no native ask-user
            // tool over the wire (the HAPI user is remote and cannot answer
            // an interactive prompt inside the child). The MCP bridge
            // provides `ask_user_question` instead; the questions surface
            // through the shared permission bridge as the interactive
            // AskUserQuestion card on every HAPI client, and the answer
            // batch returns to the model in-band as the tool result. The
            // closure reads the CURRENT handler: establishBackend swaps it
            // on every respawn, and the tool can only run once a session
            // exists.
            //
            // Agent-side approval of the MCP call needs no hermes-specific
            // wiring, but the name it arrives under is NOT `mcp__hapi__*`:
            // hermes scopes editor MCP servers per session
            // (gateway/session_local_mcp._server_names), so the model — and
            // the tool_call title, which is "<name>: <preview>" — uses the
            // tagged bridge form `mcp__editor_hapi_<8-hex-tag>__<tool>`.
            // The shared layer matches the allowlist names as '__'-segments
            // of that derived name (BasePermissionHandler), and the title
            // derivation strips the ": <preview>" suffix
            // (agent/utils.deriveToolNameWithSource).
            askUserTool: {
                escalate: async (input) => {
                    const handler = this.permissionHandler
                    if (!handler) {
                        return { status: 'canceled' as const, reason: 'Hermes session is not established' }
                    }
                    return await handler.askUser(input)
                }
            }
        })
        this.happyServer = happyServer
        this.acpMcpServers = toAcpMcpServers(mcpServers)

        // A failed INITIAL establishment no longer kills the session: the
        // stored hermesSessionId is kept and the loop's per-message respawn
        // attempt retries the resume later (e.g. the gateway daemon coming
        // back after a restart). Silent forking to a new session only
        // happens when hermes itself reports the session gone (see
        // establishBackend).
        try {
            await this.establishBackend({ respawn: false })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[hermes-acp] initial establishment failed', { message })
            this.session.sendSessionEvent({ type: 'message', message: `Hermes session failed to start: ${message}` })
            this.messageBuffer.addMessage(`Hermes session failed to start: ${message}`, 'status')
            const partial = this.backend
            this.backend = null
            this.acpSessionId = null
            try {
                await partial?.disconnect()
            } catch (disconnectError) {
                logger.debug('[hermes-acp] disconnect of partial backend failed', disconnectError)
            }
        }

        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })

        while (!this.shouldExit) {
            // Capture the signal per iteration (ported from dsh): handleAbort
            // swaps in a fresh AbortController right after aborting, so
            // re-reading this.abortController.signal below would see the
            // replacement (never aborted) and mistake an aborted wait for a
            // closed queue — exiting the loop and tearing down the whole
            // session on a Stop that arrived while the queue was idle.
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
            // per message — a permanently down gateway surfaces one error per
            // message instead of wedging or exiting the loop.
            if (!this.backend || !this.acpSessionId) {
                let reconnected = false
                try {
                    await this.respawnBackend()
                    reconnected = true
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[hermes-acp] reconnect failed', { message })
                    this.session.sendSessionEvent({ type: 'message', message: `Hermes reconnect failed: ${message}` })
                    this.messageBuffer.addMessage(`Hermes reconnect failed: ${message}`, 'status')
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
                await this.applyHermesEditMode(backend, acpSessionId, batch.mode.permissionMode)
            }

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
                        message: 'Cannot reset the Hermes model: the agent did not report a default model.'
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

            // Hermes surfaces reasoning effort as the 'reasoning_effort'
            // config option (category thought_level; 'default' = Provider
            // default/reset). The web reasoning-effort picker drives this via
            // the queued turn's mode, exactly like the dsh rail.
            const requestedEffort = batch.mode.modelReasoningEffort
            if (requestedEffort !== undefined) {
                const appliedEffort = await this.applyReasoningEffort(backend, acpSessionId, requestedEffort)
                if (appliedEffort === null) {
                    // Same contract as the model switch: the failed
                    // preference never took, so the host's tracking (and
                    // through it the hub picker) is corrected back to the
                    // live value — later turns stop re-requesting the failed
                    // one, and the respawn below skips it too.
                    this.opts.onEffortRollback?.(this.liveEffortPreference())
                }
            }

            this.session.onThinkingChange(true)
            // Slash-verb guard (hermes intercepts REGISTERED slash commands
            // inside the prompt text — /clear wipes the conversation): a
            // plain chat send matching a destructive verb is escaped with a
            // notice line (prefixing a space would NOT work: hermes lstrips
            // before matching). Read-only verbs (/help /model …) and paths
            // (/etc/hosts) pass through untouched.
            const slashGuard = escapeHermesDestructiveSlash(batch.message)
            if (slashGuard.escaped) {
                logger.warn(`[hermes-acp] escaped destructive slash verb /${slashGuard.verb} in a plain send`)
            }
            const batchText = slashGuard.text
            this.messageBuffer.addMessage(batchText, 'user')
            // Image attachments are read once here (authorized per session)
            // and the built content is reused verbatim by the respawn retry,
            // so a reconnect never re-reads or re-orders the batch's images.
            let prompt: PromptContent[]
            try {
                prompt = await buildHermesPromptContent(
                    backend,
                    batchText,
                    batch.mode.imageAttachments,
                    {
                        sessionId: this.session.client.sessionId,
                        onNotice: (message) => this.session.sendSessionEvent({ type: 'message', message })
                    }
                )
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[hermes-acp] prompt preparation failed', { message })
                prompt = [{ type: 'text', text: batchText }]
            }
            let failureMessage: string | null = null
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[hermes-acp] prompt failed', { message })
                // isAcpIndeterminateError is the transport's own typed marker
                // for failures whose request never reached a JSON-RPC outcome
                // (child exited, transport closed, stdin write failed). For
                // session/prompt — which carries an infinite timeout — that
                // marker means exactly one thing: the ACP child process died
                // (routinely a hermes gateway daemon restart) and the closed
                // transport would fail every later request the same way.
                // Regular JSON-RPC rejections (unknown session, etc.) do not
                // carry it and keep the old surface-and-continue behavior.
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
                        logger.warn('[hermes-acp] reconnect failed', { message: reconnectMessage })
                        failureMessage = `Hermes reconnect failed: ${reconnectMessage}`
                    }
                    if (revived) {
                        if (generationAtDequeue !== this.abortGeneration) {
                            // A user stop landed while the replacement backend
                            // was being established (ported from dsh): the
                            // user already saw 'Session aborted' and the queue
                            // was reset, so the retried batch must not run.
                            this.messageBuffer.addMessage('Aborted while reconnecting the Hermes session; dropping the queued message', 'status')
                        } else {
                            // The fresh process lost the dead turn's session
                            // state: re-apply the batch's edit mode before the
                            // retry (establishBackend already restored the
                            // session-stored mode; the dedupe makes this a no-op
                            // when they map to the same edit mode).
                            if (batch.mode.permissionMode !== undefined) {
                                await this.applyHermesEditMode(this.backend!, this.acpSessionId!, batch.mode.permissionMode)
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
                                logger.warn('[hermes-acp] prompt failed after reconnect', { message: retryMessage })
                                failureMessage = `Hermes prompt failed after reconnect: ${retryMessage}`
                            }
                        }
                    }
                } else {
                    failureMessage = `Hermes prompt failed: ${message}`
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
     * Create a Hermes backend and drive it to a live, fully configured ACP
     * session: initialize → resume-or-new session (replay-suppressed) → pin +
     * flush hermesSessionId → model discovery/override → catalog readiness →
     * edit mode.
     *
     * Shared by the initial launch and by post-death respawns. The `respawn`
     * flag only changes model handling: an initial establishment captures the
     * server default and applies the spawn-time override, while a respawn
     * keeps the captured default and re-applies the LIVE user preference.
     *
     * The permission handler is created BEFORE initialize: hermes re-offers
     * pending permission cards as session/request_permission during
     * initialize/resume/reattach — BEFORE the RPC resolves — and a backend
     * with no registered handler would answer them away (no-answer semantics
     * at best, a cancelled card at worst). Registered early, the re-offered
     * cards surface as real HAPI cards and answers travel on THIS backend.
     */
    private async establishBackend(opts: { respawn: boolean }): Promise<void> {
        const backend = createHermesBackend(
            withPeerToolsPreference(this.session.client.peerToolsDisabled ?? isPeerToolsDisabled())
        )
        this.backend = backend
        this.acpSessionId = null
        // Native session_info_update titles are deliberately NOT mirrored:
        // Hermes seeds its gateway session title with the raw first user
        // message, and mirroring it into metadata.summary suppresses the
        // Hub's own title generation. The Hub owns Hermes session titles,
        // matching the other ACP flavors without a native rename tool.
        backend.onStderrError((error) => {
            logger.debug('[hermes-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })

        // Auto-approval consults the LIVE session mode: a mid-turn switch to
        // yolo starts auto-approving request_permission immediately, while the
        // Hermes-side edit mode (session/set_mode) catches up at the next turn
        // boundary below.
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.session.getPermissionMode() as PermissionMode | undefined
        )

        // Foreign edit-policy changes arrive as current_mode_update while
        // this backend is attached (hermes pumps them from session.info).
        backend.setCurrentModeUpdateListener?.((update) => this.handleHermesModeUpdate(update))

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

            const resumeSessionId = this.session.sessionId
            if (resumeSessionId) {
                try {
                    // Hermes implements `session/resume` and — unlike DSH —
                    // REPLAYS the restored session history as session/update
                    // notifications before the RPC resolves (unbounded on
                    // long histories — hence the explicit 10-minute
                    // per-request budget). HAPI's hub remains the transcript
                    // source for the UI, so the replay is suppressed; without
                    // this every resume would duplicate the transcript.
                    if (!backend.supportsSessionResume()) {
                        throw new Error('Hermes ACP server does not advertise session/resume')
                    }
                    acpSessionId = await backend.suppressUpdatesDuring(() =>
                        backend.resumeSession({
                            sessionId: resumeSessionId,
                            cwd: this.session.path,
                            // Hermes mounts client MCP servers on resume too:
                            // same bridge list as session/new so a respawned
                            // child remounts the hapi tools.
                            mcpServers: this.acpMcpServers,
                            resumeTimeoutMs: HERMES_RESUME_TIMEOUT_MS
                        })
                    )
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    // Fork to a fresh session ONLY when hermes itself says the
                    // stored id is gone/unknown (gateway not_found reason,
                    // invalidParams, or no session/resume support at all).
                    // Any other failure — a replay timeout, transport loss,
                    // an internal error — leaves the stored hermesSessionId
                    // in place and surfaces instead: silently forking would
                    // strand the user on a new session that lost the whole
                    // transcript while the old one may still be alive.
                    if (!isHermesSessionGoneError(error) && !isHermesResumeUnsupportedError(error)) {
                        logger.warn('[hermes-acp] resume failed; keeping the stored session id', error)
                        this.session.sendSessionEvent({
                            type: 'message',
                            message: `Hermes resume failed: ${message}. Keeping the previous session; will retry.`
                        })
                        this.messageBuffer.addMessage(`Hermes resume failed: ${message}`, 'status')
                        throw error
                    }
                    logger.warn('[hermes-acp] resume failed (session gone); starting a new session', error)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Hermes session was not found on the agent; starting a new session.'
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
            // Pin hermesSessionId before the main loop so a runner restart can
            // resume (tiann/hapi#913, ported from dsh: gate until the metadata
            // write reaches the hub — a SIGTERM before that strands the session
            // with no resume key). Re-pinning after a respawn is an idempotent
            // metadata merge.
            const flushed = await this.session.client.flushMetadata()
            if (!flushed) {
                logger.warn(`[hermes-acp] hermesSessionId metadata write did not ACK within the flush window (acpSessionId=${acpSessionId})`)
            }
        } catch (error) {
            readiness.reject(error)
            throw error
        }

        const modelOption = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!opts.respawn) {
            // Capture the server default BEFORE applying any override: an explicit
            // "Default" reset later in the session (queued as model: null) switches
            // back to this value; without it the reset would silently keep the
            // last explicitly-applied model.
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
            // The respawned child starts from whatever the daemon persisted;
            // re-apply the live user preference so the retried batch runs on
            // the model the session is showing.
            await this.applyModelSwitch(backend, acpSessionId, this.currentBackendModel)
        }
        if (opts.respawn && this.currentReasoningEffort !== null) {
            // Same re-apply contract as the model preference, with one
            // difference: a failure here DROPS the effort preference. The
            // replacement child is the preference's only chance to
            // re-materialize (the session it was proven on is gone — and a
            // failed resume even starts a fresh one), so a value the new
            // session rejects — e.g. after a model switch to one without that
            // effort level — is cleared instead of failing every later
            // respawn; the host is told so the hub picker follows.
            const reapplied = await this.applyEffortValue(backend, acpSessionId, this.currentReasoningEffort)
            if (reapplied === null) {
                this.currentReasoningEffort = null
                this.opts.onEffortRollback?.(undefined)
            }
        }
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }
        readiness.resolve(acpSessionId)

        const sessionPermissionMode = this.session.getPermissionMode() as PermissionMode | undefined
        this.applyDisplayMode(sessionPermissionMode)
        // Inspect the mode hermes itself reports for this session (seeded by
        // the backend from the resume/new response and any live
        // current_mode_update): a respawned child may have started at the
        // server default — or another surface changed the policy while this
        // client was detached. Seeding the dedupe from the OBSERVED mode
        // means the set_mode below only fires when hermes actually differs
        // from what HAPI wants, and a mismatch is surfaced as a re-assert.
        const observedMode = backend.getSessionCurrentMode?.(acpSessionId)
        if (observedMode) {
            const desiredEditMode = HERMES_EDIT_MODE_BY_PERMISSION[sessionPermissionMode ?? 'default'] ?? 'default'
            if (observedMode !== desiredEditMode) {
                this.session.sendSessionEvent({
                    type: 'message',
                    message: 'Hermes mode changed elsewhere; re-asserting'
                })
                this.messageBuffer.addMessage('Hermes mode changed elsewhere; re-asserting', 'status')
                this.lastForeignModeNotice = observedMode
            }
            this.lastAppliedEditMode = observedMode
            logger.debug(`[hermes-acp] hermes reported current mode ${observedMode}`)
        }
        await this.applyHermesEditMode(backend, acpSessionId, sessionPermissionMode)
    }

    /**
     * `current_mode_update` from the CURRENT backend: hermes emits it when
     * another surface changed the session's edit-approval policy. Echoes of
     * our own session/set_mode are filtered (applyingEditMode /
     * lastAppliedEditMode); a genuinely foreign mode drops the apply-dedupe
     * so the next queued batch re-asserts HAPI's mode, and says so once per
     * distinct foreign mode (repeated echoes of the same mode stay quiet).
     */
    private handleHermesModeUpdate(update: { sessionId: string | null; currentModeId: string }): void {
        if (update.currentModeId === this.applyingEditMode) return
        if (update.currentModeId === this.lastAppliedEditMode) return
        if (update.currentModeId === this.lastForeignModeNotice) return
        this.lastForeignModeNotice = update.currentModeId
        logger.warn('[hermes-acp] hermes mode changed elsewhere', { currentModeId: update.currentModeId })
        this.session.sendSessionEvent({
            type: 'message',
            message: 'Hermes mode changed elsewhere; re-asserting'
        })
        this.messageBuffer.addMessage('Hermes mode changed elsewhere; re-asserting', 'status')
        // Drop the dedupe: the next batch re-issues session/set_mode with the
        // HAPI-side preference.
        this.lastAppliedEditMode = null
    }

    /**
     * Arm a fresh pending readiness handshake, make it current, and return
     * it. Called before the bridge build (pre-first-establishment
     * placeholder) and at the top of every respawn (before the teardown
     * awaits): catalog queries that arrive in those windows park on it.
     * establishBackend adopts the pending handshake, rebinds its backend,
     * and settles it with the establishment's outcome.
     */
    private armModelsReadiness(): ModelsReadiness {
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
        const readiness: ModelsReadiness = {
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
     * `hermes acp` child process.
     *
     * Once the ACP child dies (gateway daemon restart, crash) its transport
     * is closed permanently — every request on it rejects immediately — so
     * recovery requires a brand-new backend: initialize, resume the persisted
     * daemon session id (Hermes keeps gateway sessions alive across ACP
     * child restarts, replay-suppressed exactly like the initial resume),
     * re-apply the current model preference and edit mode, and re-arm the
     * catalog readiness. Posts exactly one 'connection lost; reconnecting'
     * status line per attempt.
     *
     * Throws when re-establishment fails; `this.backend` is then null so the
     * next message starts a fresh attempt instead of reusing the corpse.
     */
    private async respawnBackend(): Promise<void> {
        if (this.respawnInProgress) {
            throw new Error('Hermes reconnect already in progress')
        }
        this.respawnInProgress = true
        try {
            this.session.sendSessionEvent({ type: 'message', message: 'Hermes connection lost; reconnecting…' })
            this.messageBuffer.addMessage('Hermes connection lost; reconnecting…', 'status')
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
            // metadata off the corpse. establishBackend adopts it.
            this.armModelsReadiness()
            // The fresh process starts at the server-default edit mode; clear
            // the dedupe so establishBackend re-issues session/set_mode.
            this.lastAppliedEditMode = null
            try {
                await deadPermissionHandler?.cancelAll('Hermes connection lost')
            } catch (error) {
                logger.debug('[hermes-acp] permission cancelAll during reconnect failed', error)
            }
            try {
                await deadBackend?.disconnect()
            } catch (error) {
                logger.debug('[hermes-acp] disconnect of dead backend failed', error)
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
            // it covers failures that predate the adopt, e.g. a synchronous
            // backend-factory throw). The next respawn attempt re-arms.
            const pending = this.modelsReadiness
            if (pending && !pending.settled) {
                pending.reject(error)
            }
            try {
                await partial?.disconnect()
            } catch (disconnectError) {
                logger.debug('[hermes-acp] disconnect of partial backend failed', disconnectError)
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
     * Push the HAPI permission mode onto Hermes's edit-approval axis via
     * `session/set_mode` (default / accept_edits / dont_ask). Only the edit
     * axis lives in Hermes; dangerous-command approvals always arrive as
     * request_permission and are decided by the HAPI permission bridge. No-op
     * when the mode is unchanged; failures degrade to a status note because
     * the bridge still honors the mode on the HAPI side.
     */
    private async applyHermesEditMode(
        backend: ReturnType<typeof createHermesBackend>,
        acpSessionId: string,
        permissionMode: PermissionMode | undefined
    ): Promise<void> {
        const editMode = HERMES_EDIT_MODE_BY_PERMISSION[permissionMode ?? 'default'] ?? 'default'
        if (editMode === this.lastAppliedEditMode) return
        this.applyingEditMode = editMode
        try {
            await backend.setMode(acpSessionId, editMode, { syncThoughtLevel: false })
            this.lastAppliedEditMode = editMode
            // Our own mode is authoritative again — a later current_mode_update
            // reporting something else is a NEW foreign change.
            this.lastForeignModeNotice = null
            logger.debug(`[hermes-acp] Applied edit mode via set_mode: ${editMode}`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[hermes-acp] set_mode failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Hermes edit mode switch failed: ${message}`
            })
        } finally {
            this.applyingEditMode = null
        }
    }

    /**
     * Switch the Hermes model through `session/set_config_option` — Hermes
     * has no parameterized model picker; models surface as config options of
     * category `model`. Model ids are opaque `provider:model` strings sent
     * back verbatim; unknown ids fail loud with -32602. Returns the applied
     * model, or null when the switch failed (caller keeps the previous model).
     */
    private async applyModelSwitch(
        backend: ReturnType<typeof createHermesBackend>,
        acpSessionId: string,
        model: string
    ): Promise<string | null> {
        const option = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!option) {
            logger.warn('[hermes-acp] Cannot switch model: agent exposes no model config option')
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Cannot switch model: the Hermes agent exposes no model config option.'
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
            logger.warn('[hermes-acp] model switch failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch Hermes model: ${message}`
            })
            return null
        }
    }

    /**
     * Apply a reasoning-effort change through the 'reasoning_effort' config
     * option (category thought_level). Hermes's value space is the thought
     * level vocabulary (none/minimal/low/medium/high/xhigh/max/ultra) with
     * 'default' meaning "reset to the provider default", so the picker's
     * null ("Default") maps to 'default'. Returns the applied value, or null
     * when the switch failed or the model exposes no thought_level option
     * (the caller keeps the previous effort and corrects the host via
     * onEffortRollback) — the same contract as applyModelSwitch. A request
     * that already matches the live value returns it without a wire call.
     */
    private async applyReasoningEffort(
        backend: ReturnType<typeof createHermesBackend>,
        acpSessionId: string,
        effort: string | null
    ): Promise<string | null> {
        const value = effort ?? 'default'
        if (value === this.currentReasoningEffort) return value
        return this.applyEffortValue(backend, acpSessionId, value)
    }

    /**
     * Fire the set_config_option for a concrete effort value without the
     * preference dedupe — the respawn path re-applies the live preference to
     * a FRESH child whose thought level is unknown, so even a value equal to
     * `currentReasoningEffort` must go over the wire. Only a success updates
     * the tracked preference; on failure the previous value stands and null
     * is returned.
     */
    private async applyEffortValue(
        backend: ReturnType<typeof createHermesBackend>,
        acpSessionId: string,
        value: string
    ): Promise<string | null> {
        const option = backend.getConfigOptionByCategory(acpSessionId, 'thought_level')
        if (!option) {
            logger.warn('[hermes-acp] Cannot set reasoning effort: agent exposes no thought_level config option')
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Cannot set reasoning effort: the current Hermes model exposes no thought levels.'
            })
            return null
        }
        try {
            await backend.setConfigOption(acpSessionId, option.id, value)
            this.currentReasoningEffort = value
            this.messageBuffer.addMessage(`[EFFORT:${value || 'default'}]`, 'system')
            return value
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[hermes-acp] reasoning effort switch failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch Hermes reasoning effort: ${message}`
            })
            return null
        }
    }

    /** The live effort preference in the picker's domain: undefined = none
     * tracked, null = "Default" (Hermes's 'default'), string = a concrete
     * value. This is what onEffortRollback reports after a failed apply. */
    private liveEffortPreference(): string | null | undefined {
        if (this.currentReasoningEffort === null) return undefined
        return this.currentReasoningEffort === 'default' ? null : this.currentReasoningEffort
    }

    private async handleAbort(): Promise<void> {
        // Bump first, synchronously (ported from dsh): the prompt-catch
        // respawn branch compares generations around its respawnBackend
        // `await` to detect aborts that land inside that window.
        this.abortGeneration += 1
        // Tear the wait down synchronously FIRST (ported from dsh): aborting
        // and replacing the controller unparks a waiting loop iteration via
        // its captured signal, and resetting the queue before the awaits drops
        // anything queued ahead of the stop — a message dequeued while the
        // cancel requests are still on the wire must not run after the user
        // already saw "Session aborted".
        this.abortController.abort()
        this.abortController = new AbortController()
        this.session.queue.reset()
        // Reads the CURRENT backend: after a respawn this cancels on the
        // replacement; mid-respawn it is null and the skip is correct (the
        // dead transport cannot accept a cancel anyway).
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

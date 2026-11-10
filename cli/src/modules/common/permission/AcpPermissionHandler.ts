import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import type { PermissionMode } from '@hapi/protocol/types'
import { randomUUID } from 'node:crypto'
import { deriveToolInput, deriveToolName } from '@/agent/utils'
import { logger } from '@/ui/logger'
import {
    BasePermissionHandler,
    isUnclassifiablePermissionRequest,
    type AutoApprovalDecision,
    type PendingPermissionRequest,
    type PermissionCompletion
} from './BasePermissionHandler'
import { mapAskUserAnswers, type AskUserAnswer } from './askUserAnswers'

interface PermissionResponseMessage {
    id: string
    approved: boolean
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    reason?: string
    /** AskUserQuestion payloads from web/mobile: Record<questionIndex, string[]>
     * (labels + free-text "Other" appended). Absent on plain approve/deny. */
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>
}

/** Outcome of a synthetic ask-user escalation surfaced to the HAPI client. */
export type AcpAskUserOutcome =
    | { status: 'answered'; answers: AskUserAnswer[] }
    | { status: 'denied'; reason?: string }
    | { status: 'canceled'; reason?: string }

function pickOptionId(request: PermissionRequest, preferredKinds: string[]): string | null {
    for (const kind of preferredKinds) {
        const match = request.options.find((option) => option.kind === kind)
        if (match) return match.optionId
    }
    return request.options[0]?.optionId ?? null
}

/** Per-backend options for the ACP permission bridge. */
export interface AcpPermissionHandlerOptions {
    /**
     * Map session-scoped grant decisions (`approved_for_session`) to
     * `allow_once` instead of `allow_always`.
     *
     * Berry persists allow_always answers STICKILY in tool-policy.json
     * inside its dataDir — they survive the session and even process
     * restarts, so a HAPI "allow for session" pick must not become one.
     * Flavors without sticky grant storage (or that treat allow_always as
     * session-scoped) keep the default preference.
     */
    sessionScopedPermissionGrants?: boolean
}

function mapDecisionToOutcome(
    request: PermissionRequest,
    decision: PermissionResponseMessage['decision'],
    opts?: AcpPermissionHandlerOptions
): PermissionResponse {
    if (decision === 'abort') return { outcome: 'cancelled' }
    if (decision === 'approved_for_session') {
        const preference = opts?.sessionScopedPermissionGrants
            ? ['allow_once', 'allow_always']
            : ['allow_always', 'allow_once']
        const optionId = pickOptionId(request, preference)
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
    }
    if (decision === 'approved') {
        const optionId = pickOptionId(request, ['allow_once', 'allow_always'])
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
    }
    const optionId = pickOptionId(request, ['reject_once', 'reject_always'])
    return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
}

/** Shared HAPI permission bridge for ACP agents with one-shot choices. */
export class AcpPermissionHandler extends BasePermissionHandler<PermissionResponseMessage, void> {
    /** Synthetic ask-user escalations (MCP ask_user_question bridge). Keyed by
     * the same request id registered in the agent-state pending map; resolved
     * from Permission responses that carry `answers`. */
    private readonly askUserResolvers = new Map<string, (outcome: AcpAskUserOutcome) => void>()
    private readonly pendingBackendRequests = new Map<string, PermissionRequest>()

    constructor(
        session: ApiSessionClient,
        private readonly backend: AgentBackend,
        private readonly getPermissionMode: () => PermissionMode | undefined,
        /** Called synchronously with the pending close-based cancellation when
         *  a permission decision aborts, before the handler awaits it — lets
         *  the host serialize follow-up work against the close response. */
        private readonly onAbortClose?: (cancellation: Promise<void>) => void,
        private readonly handlerOptions: AcpPermissionHandlerOptions = {}
    ) {
        super(session)
        this.backend.onPermissionRequest((request) => this.handlePermissionRequest(request))
    }

    private handlePermissionRequest(request: PermissionRequest): void {
        const toolName = deriveToolName({
            title: request.title,
            kind: request.kind,
            rawInput: request.rawInput
        })
        const toolInput = deriveToolInput(request)
        // Fail closed on unclassifiable requests: when the request still has
        // neither a kind nor a rawInput after the backend-side toolCallId
        // correlation (berry's APPROVAL-* ids never correlate, so its
        // human-summary title is the only identity), the title write-hints
        // must not drive read-only auto-approval. Flavors that fill the
        // request fields are classified exactly as before.
        const unclassifiable = isUnclassifiablePermissionRequest(request)
        const autoDecision = this.resolveAutoApprovalDecision(
            this.getPermissionMode(),
            toolName,
            request.toolCallId,
            undefined,
            { unclassifiable }
        )
        if (autoDecision) {
            void this.autoApprove(request, toolName, toolInput, autoDecision)
            return
        }

        this.pendingBackendRequests.set(request.id, request)
        this.addPendingRequest(request.id, toolName, toolInput, {
            resolve: () => {},
            reject: () => {}
        })
        logger.debug(`[ACP] Permission request queued for ${toolName} (${request.id})`)
    }

    private async autoApprove(
        request: PermissionRequest,
        toolName: string,
        toolInput: unknown,
        decision: AutoApprovalDecision
    ): Promise<void> {
        await this.backend.respondToPermission(
            request.sessionId,
            request,
            mapDecisionToOutcome(request, decision, this.handlerOptions)
        )
        const timestamp = Date.now()
        this.client.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [request.id]: {
                    tool: toolName,
                    arguments: toolInput,
                    createdAt: timestamp,
                    completedAt: timestamp,
                    status: 'approved',
                    decision
                }
            }
        }))
    }

    /**
     * Surface an `ask_user_question` payload to the HAPI user and await the
     * answer batch.
     *
     * DSH's automation-only ACP profile deliberately omits its native
     * ask-user tool (there is no UI to answer it over raw ACP); the hapi MCP
     * bridge provides the tool instead and routes the question through this
     * escalation. The pending request is registered in the agent state under
     * the exact tool name `ask_user_question` with the questions as
     * arguments, which every HAPI client (web/iOS/Android) already renders
     * as the interactive AskUserQuestion card and answers through
     * approvePermission({answers}) — the same path Claude Code's native
     * AskUserQuestion takes. No backend request exists for these ids: the
     * response resolves the caller directly (the MCP tool returns the answer
     * batch to the model in-band).
     */
    askUser(input: unknown): Promise<AcpAskUserOutcome> {
        return new Promise<AcpAskUserOutcome>((resolve) => {
            const id = `askuser-${randomUUID()}`
            this.askUserResolvers.set(id, resolve)
            this.addPendingRequest(id, 'ask_user_question', input, {
                resolve: () => {},
                reject: (error) => {
                    this.askUserResolvers.delete(id)
                    resolve({ status: 'canceled', reason: error.message })
                }
            })
        })
    }

    protected async handlePermissionResponse(
        response: PermissionResponseMessage,
        pending: PendingPermissionRequest<void>
    ): Promise<PermissionCompletion> {
        const askUserResolver = this.askUserResolvers.get(response.id)
        if (askUserResolver) {
            this.askUserResolvers.delete(response.id)
            if (response.approved) {
                const answers = mapAskUserAnswers(pending.input, response.answers)
                const hasAnyAnswer = answers.some((answer) => answer.selected.length > 0 || answer.custom !== undefined)
                askUserResolver(hasAnyAnswer
                    ? { status: 'answered', answers }
                    : { status: 'denied', reason: response.reason ?? 'No answers were provided.' })
            } else {
                askUserResolver({ status: 'denied', reason: response.reason })
            }
            pending.resolve()
            return {
                status: response.approved ? 'approved' : 'denied',
                decision: response.decision,
                reason: response.reason,
                answers: response.answers
            }
        }

        const request = this.pendingBackendRequests.get(response.id)
        this.pendingBackendRequests.delete(response.id)
        const decision = response.decision ?? (response.approved ? 'approved' : 'denied')

        if (decision === 'abort' && request) {
            // Hand the pending cancellation to the host synchronously (before
            // awaiting) so it can record it as an in-flight close immediately —
            // the current prompt may complete while session/close is still on
            // the wire, and the host must not send follow-up work to the
            // closing session in that gap.
            const cancellation = this.backend.cancelPrompt(request.sessionId)
            this.onAbortClose?.(cancellation)
            await cancellation
        }
        if (request) {
            await this.backend.respondToPermission(
                request.sessionId,
                request,
                mapDecisionToOutcome(request, decision, this.handlerOptions)
            )
        }
        pending.resolve()

        return {
            status: response.approved ? 'approved' : 'denied',
            decision,
            reason: response.reason
        }
    }

    protected handleMissingPendingResponse(response: PermissionResponseMessage): void {
        logger.debug('[ACP] Permission response received for unknown request', response.id)
    }

    async cancelAll(reason: string): Promise<void> {
        const pending = Array.from(this.pendingBackendRequests.values())
        this.pendingBackendRequests.clear()
        for (const request of pending) {
            await this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' })
        }
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'abort'
        })
    }
}

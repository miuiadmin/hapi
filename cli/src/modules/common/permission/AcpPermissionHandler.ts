import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import type { PermissionMode } from '@hapi/protocol/types'
import { isObject } from '@hapi/protocol'
import { randomUUID } from 'node:crypto'
import { deriveToolInput, deriveToolName } from '@/agent/utils'
import { logger } from '@/ui/logger'
import { settleRequestsOfPreviousAgentProcess } from '@/modules/common/permission/settleStaleRequests'
import {
    BasePermissionHandler,
    isUnclassifiablePermissionRequest,
    isWriteClassifiedToolName,
    type AutoApprovalDecision,
    type AutoApprovalRuleSet,
    type PendingPermissionRequest,
    type PermissionCompletion
} from './BasePermissionHandler'
import { firstAnswerLabel, mapAskUserAnswers, type AskUserAnswer } from './askUserAnswers'

interface PermissionResponseMessage {
    id: string
    approved: boolean
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    reason?: string
    /** AskUserQuestion payloads from web/mobile: Record<questionIndex, string[]>
     * (labels + free-text "Other" appended). Absent on plain approve/deny. */
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>
}

export type UserAnswer = {
    decision: NonNullable<PermissionResponseMessage['decision']>
    answers?: Record<string, string[]>
}

/** Upstream also accepts a nested answers shape (request_user_input); flatten
 *  it into the Record<string, string[]> form HAPI's ask-user pipeline uses. */
function normalizeUserAnswers(
    answers: PermissionResponseMessage['answers']
): Record<string, string[]> | undefined {
    if (!answers) return undefined
    const out: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(answers)) {
        out[key] = Array.isArray(value) ? value : value.answers
    }
    return out
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

/** Hermes' elicitation fallback (acp_adapter/elicitation.py
 * `build_clarify_permission`) renders a canonical `clarify` prompt as a
 * permission card when the client lacks `elicitation.form`: one allow_once
 * option per offered choice (optionId `choice-<i>`, the choice text as the
 * option NAME) plus a reject_once Skip (optionId `skip`). */
const CLARIFY_SKIP_OPTION_ID = 'skip'

function normalizeOptionName(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Whether a request_permission is a hermes clarify card — a QUESTION whose
 * option names are the answers, not a tool approval. Two shapes, both from
 * `build_clarify_permission`:
 *  - two or more allow_once options with distinct names (the usual
 *    multi-choice clarify), or
 *  - a single allow_once choice plus the fixed Skip reject option.
 *
 * Ordinary cards never match: hermes' tool approvals carry exactly one
 * allow_once ("Allow once"/"Allow edit"/"Switch anyway") with a durable or
 * standard-named reject ("Deny"/"Deny always"/"Cancel"), and other flavors'
 * one-shot cards (dsh allow-once/reject-once, berry) never carry the skip
 * marker. A card with any allow_always/reject_always option is never a
 * clarify.
 */
export function isClarifyPermissionRequest(request: PermissionRequest): boolean {
    const options = request.options
    if (options.length < 2) return false
    const allowOnce = options.filter((option) => option.kind === 'allow_once')
    const rejectOnce = options.filter((option) => option.kind === 'reject_once')
    if (allowOnce.length + rejectOnce.length !== options.length) return false
    if (new Set(allowOnce.map((option) => normalizeOptionName(option.name))).size >= 2) {
        return true
    }
    return allowOnce.length === 1
        && rejectOnce.length === 1
        && (rejectOnce[0].optionId === CLARIFY_SKIP_OPTION_ID
            || normalizeOptionName(rejectOnce[0].name) === CLARIFY_SKIP_OPTION_ID)
}

/**
 * The AskUserQuestion payload a clarify card renders as: one question (the
 * clarify prompt's question text — the tool_call title / rawInput.question)
 * whose selectable options are the allow_once option names.
 */
function buildClarifyQuestionInput(request: PermissionRequest): unknown {
    const rawQuestion = isObject(request.rawInput) && typeof request.rawInput.question === 'string'
        ? request.rawInput.question
        : (typeof request.title === 'string' ? request.title : '')
    const labels = request.options
        .filter((option) => option.kind === 'allow_once')
        .map((option) => option.name.trim())
        .filter((name) => name.length > 0)
    return {
        questions: [{
            question: rawQuestion,
            header: null,
            multiSelect: false,
            options: labels.map((label) => ({ label }))
        }]
    }
}

/**
 * Whether a request_permission carries the raw AskUserQuestion payload —
 * the zcode-acp-server bridge degrades AskUserQuestion (when the client
 * lacks elicitation forms) into per-question request_permission popups
 * whose `toolCall.rawInput` is the ORIGINAL tool input (its `questions`
 * array) and whose popup title is the question text. The option labels are
 * the answer choices (`__skip__` reject = skip), not tool approvals.
 */
export function isAskUserPermissionRequest(request: PermissionRequest): boolean {
    if (!isObject(request.rawInput)) return false
    if (!Array.isArray(request.rawInput.questions) || request.rawInput.questions.length === 0) {
        return false
    }
    return request.rawInput.questions.some((question) =>
        isObject(question) && typeof question.question === 'string')
}

/**
 * The AskUserQuestion payload a zcode ask popup renders as: one question
 * (the popup title — the bridge puts the question text there) whose
 * selectable options are the request's allow_once option names (the answer
 * labels the bridge generated).
 */
function buildAskUserQuestionInput(request: PermissionRequest): unknown {
    const fallback = isObject(request.rawInput) && Array.isArray(request.rawInput.questions)
        && isObject(request.rawInput.questions[0])
        && typeof (request.rawInput.questions[0] as { question?: unknown }).question === 'string'
        ? (request.rawInput.questions[0] as { question: string }).question
        : ''
    const rawQuestion = typeof request.title === 'string' && request.title.length > 0
        ? request.title
        : fallback
    const labels = request.options
        .filter((option) => option.kind === 'allow_once')
        .map((option) => option.name.trim())
        .filter((name) => name.length > 0)
    return {
        questions: [{
            question: rawQuestion,
            header: null,
            multiSelect: false,
            options: labels.map((label) => ({ label }))
        }]
    }
}

/**
 * Map an AskUserQuestion-style answer payload (selected option LABELS) back
 * to the clarify optionId hermes expects (`answers.get(option_id)` in
 * `_answer_clarify`). Null when the payload carries no answer text.
 */
function mapClarifyAnswerToOptionId(request: PermissionRequest, answers: PermissionResponseMessage['answers']): string | null {
    const label = firstAnswerLabel(answers)
    if (label === null) return null
    const match = request.options.find((option) =>
        option.kind === 'allow_once' && option.name.trim() === label)
    return match ? match.optionId : null
}

/** Hermes' sensitive-path list (acp_adapter/edit_approval.py
 * `_is_sensitive_auto_approve_path`): any `.git`/`.ssh` path segment, or a
 * `.env`-prefixed / `id_rsa` / `id_ed25519` basename. Hermes force-asks
 * edits to these even under its auto-approve policies ("...except
 * sensitive paths"). */
const SENSITIVE_PATH_DIR_SEGMENTS = new Set(['.git', '.ssh'])
const SENSITIVE_PATH_BASENAMES = new Set(['id_rsa', 'id_ed25519'])
const SENSITIVE_PATH_BASENAME_PREFIXES = ['.env']
/** Keys whose string values are treated as file paths when scanning a
 * request for sensitive targets (hermes edit approval nests the real path
 * under `arguments.path`; dsh edit/write carry Claude-shaped `file_path`). */
const SENSITIVE_PATH_KEYS = [
    'path', 'file_path', 'filePath', 'filename', 'fileName', 'file',
    'target', 'notebook_path', 'full_path', 'relative_path'
]
const EDIT_SHAPED_KINDS = new Set(['edit', 'write', 'write_file', 'replace', 'modify', 'file_edit', 'apply_patch'])
const MAX_SENSITIVE_SCAN_DEPTH = 6

function collectSensitivePathCandidates(request: PermissionRequest, out: string[]): void {
    if (typeof request.title === 'string' && request.title.length > 0) {
        out.push(request.title)
    }
    const walk = (node: unknown, depth: number): void => {
        if (depth > MAX_SENSITIVE_SCAN_DEPTH) return
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1)
            return
        }
        if (!isObject(node)) return
        for (const [key, value] of Object.entries(node)) {
            if (SENSITIVE_PATH_KEYS.includes(key) && typeof value === 'string' && value.length > 0) {
                out.push(value)
            } else {
                walk(value, depth + 1)
            }
        }
    }
    walk(request.rawInput, 0)
}

function referencesSensitivePath(candidates: readonly string[]): boolean {
    for (const candidate of candidates) {
        const segments = candidate.split(/[/\\]/).filter((segment) => segment.length > 0)
        for (let i = 0; i < segments.length; i += 1) {
            const segment = segments[i].toLowerCase()
            if (SENSITIVE_PATH_DIR_SEGMENTS.has(segment)) return true
            if (i === segments.length - 1) {
                if (SENSITIVE_PATH_BASENAMES.has(segment)) return true
                if (SENSITIVE_PATH_BASENAME_PREFIXES.some((prefix) => segment.startsWith(prefix))) return true
            }
        }
    }
    return false
}

/**
 * Bridge-side sensitive-path valve: hermes deliberately re-asks edits to
 * .git, .ssh, .env-prefixed and id_rsa-class files even under its
 * auto-approve policies, so the HAPI
 * bridge must not steamroll that with a yolo/safe-yolo auto-answer — an
 * edit-shaped card (kind edit or a write-classified derived name)
 * referencing a sensitive path is always surfaced to the user.
 */
export function isSensitiveEditPermissionRequest(request: PermissionRequest, toolName: string): boolean {
    const kind = typeof request.kind === 'string' ? request.kind.trim().toLowerCase() : ''
    const editShaped = EDIT_SHAPED_KINDS.has(kind) || isWriteClassifiedToolName(toolName)
    if (!editShaped) return false
    const candidates: string[] = []
    collectSensitivePathCandidates(request, candidates)
    return referencesSensitivePath(candidates)
}

/** The agent-state extras forwarded for a pending backend card: the offered
 * permission options (id/name/kind) so clients can gate their footers on
 * what the agent actually supports (no allow_always kind → no durable
 * "Allow for session" promise). */
function buildPendingStateOptions(request: PermissionRequest): Record<string, unknown> | undefined {
    if (request.options.length === 0) return undefined
    return {
        options: request.options.map((option) => ({
            optionId: option.optionId,
            name: option.name,
            kind: option.kind
        }))
    }
}

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
function mapDecisionToOutcome(
    request: PermissionRequest,
    decision: PermissionResponseMessage['decision'],
    sessionScopedPermissionGrants?: boolean
): PermissionResponse {
    if (decision === 'abort') return { outcome: 'cancelled' }
    if (decision === 'approved_for_session') {
        const preference = sessionScopedPermissionGrants
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
    private readonly userWaitEnds = new Map<string, () => void>()
    private readonly userQuestions = new Map<string, (answer: UserAnswer) => void>()
    // Clients hide a pending request whose id was already completed.
    private readonly usedIds = new Set<string>()

    constructor(
        session: ApiSessionClient,
        private readonly backend: AgentBackend,
        private readonly getPermissionMode: () => PermissionMode | undefined,
        private readonly options: {
            // Agents that title requests with free text (agy: the command
            // line) turn off the HAPI tool-name hints, which could match it.
            autoApprovalRules?: AutoApprovalRuleSet
            // A long-lived agent process outlives mode switches, so automatic
            // approvals must not leave standing grants behind.
            autoApproveOnce?: boolean
            // Questions need the user's answer in every mode.
            requiresUser?: (request: PermissionRequest) => boolean
            // Called when a request starts waiting for the user; the returned
            // callback runs once it is answered (agents timing their own work).
            onUserWait?: () => () => void
            // Called synchronously when a permission 'abort' decision cancels
            // the prompt through the backend directly (never via the
            // launcher's abort handler). Flavors that track cancels — e.g.
            // dsh's implicit session-end detection on custom wrappers that
            // close the session on session/cancel — use this to arm their
            // detector for that cancel.
            onCancelIssued?: () => void
            /** Called synchronously with the pending close-based cancellation
             * when a permission decision aborts, before the handler awaits it
             * — lets the host serialize follow-up work against the close
             * response (dsh records it as its in-flight abortCompletion so
             * queued prompts defer until the session/close response lands). */
            onAbortClose?: (cancellation: Promise<void>) => void
            /**
             * Map session-scoped grant decisions (`approved_for_session`) to
             * `allow_once` instead of `allow_always` (berry's sticky
             * tool-policy.json grants — see mapDecisionToOutcome).
             */
            sessionScopedPermissionGrants?: boolean
        } = {}
    ) {
        super(session)
        settleRequestsOfPreviousAgentProcess(this.backend, session)
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
        // Clarify cards and zcode ask-user popups are QUESTIONS, not
        // approvals — NEVER auto-answer one (yolo/safe-yolo picking
        // choice-1 behind the user's back is the exact bug this mirrors the
        // ask-user escalation exemption for). The sensitive-path valve
        // likewise surfaces edit-shaped cards that hermes itself force-asks
        // under auto-approve policies. `requiresUser` is the per-flavor
        // equivalent of the same exemption (e.g. agy questions).
        const clarify = isClarifyPermissionRequest(request)
        const askUser = isAskUserPermissionRequest(request)
        const autoDecision = (this.options.requiresUser?.(request)
            || clarify
            || askUser
            || isSensitiveEditPermissionRequest(request, toolName))
            ? null
            : this.resolveAutoApprovalDecision(
                this.getPermissionMode(),
                toolName,
                request.toolCallId,
                this.options.autoApprovalRules,
                { unclassifiable }
            )
        if (autoDecision) {
            const decision = this.options.autoApproveOnce && autoDecision === 'approved_for_session'
                ? 'approved'
                : autoDecision
            void this.autoApprove(request, toolName, toolInput, decision)
            return
        }

        this.pendingBackendRequests.set(request.id, request)
        this.usedIds.add(request.id)
        this.startUserWait(request.id)
        // A clarify card or a zcode ask popup rides the existing
        // ask_user_question pipeline: the pending entry is registered under
        // that exact tool name with the choices as the question's options,
        // so every HAPI client renders the interactive AskUserQuestion card
        // and answers through approvePermission({answers}) — the same path
        // the MCP ask-user escalation takes.
        this.addPendingRequest(
            request.id,
            clarify || askUser ? 'ask_user_question' : toolName,
            clarify
                ? buildClarifyQuestionInput(request)
                : (askUser ? buildAskUserQuestionInput(request) : toolInput),
            {
                resolve: () => {},
                reject: () => {}
            },
            clarify || askUser ? undefined : request.toolCallId,
            buildPendingStateOptions(request)
        )
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
            mapDecisionToOutcome(request, decision, this.options.sessionScopedPermissionGrants)
        )
        const timestamp = Date.now()
        this.client.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [request.id]: {
                    tool: toolName,
                    toolCallId: request.toolCallId,
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
    askUser(input: unknown): Promise<AcpAskUserOutcome>
    /**
     * A question the agent asks the user, shown as `toolName` with `input`.
     * Never answered automatically, whatever the permission mode.
     */
    askUser(id: string, toolName: string, input: unknown, toolCallId?: string): Promise<UserAnswer>
    askUser(idOrInput: unknown, toolName?: string, input?: unknown, toolCallId?: string): Promise<AcpAskUserOutcome | UserAnswer> {
        if (typeof idOrInput === 'string' && toolName !== undefined) {
            const id = idOrInput
            return new Promise((resolve) => {
                this.userQuestions.set(id, resolve)
                this.usedIds.add(id)
                this.startUserWait(id)
                this.addPendingRequest(id, toolName, input, { resolve: () => {}, reject: () => {} }, toolCallId)
            })
        }
        return new Promise<AcpAskUserOutcome>((resolve) => {
            // Supersede: dsh enforces a 60s per-call MCP timeout it cannot
            // raise, so an unanswered question times out and the model retries
            // the tool call — escalating a SECOND question while the first
            // card is still pending. Without this, retry cycles stack
            // interactive cards and the turn-end cancelAll silently settles
            // cards the user is mid-way through filling. At most ONE
            // ask-user card may be pending: resolve every prior one as
            // canceled (state entry moves to completedRequests with the
            // reason) the instant a newer question arrives.
            //
            // Clarify cards ride the same `ask_user_question` tool name, so
            // the sweep covers them too — and their BACKEND request must be
            // settled (cancelled = hermes' skip semantics) or the agent
            // keeps waiting on a card no client can answer anymore.
            let settledBackendClarify = false
            for (const [id, pending] of this.pendingRequests.entries()) {
                if (pending.toolName !== 'ask_user_question') continue
                if (this.askUserResolvers.has(id)) continue
                const backendRequest = this.pendingBackendRequests.get(id)
                if (backendRequest) {
                    this.pendingBackendRequests.delete(id)
                    settledBackendClarify = true
                    void this.backend.respondToPermission(
                        backendRequest.sessionId,
                        backendRequest,
                        { outcome: 'cancelled' }
                    )
                }
            }
            if (this.askUserResolvers.size > 0 || settledBackendClarify) {
                this.cancelPendingRequests({
                    completedReason: 'Superseded by a newer question',
                    rejectMessage: 'Superseded by a newer question',
                    filter: (toolName) => toolName === 'ask_user_question'
                });
            }
            const id = `askuser-${randomUUID()}`
            this.askUserResolvers.set(id, resolve)
            this.addPendingRequest(id, 'ask_user_question', idOrInput, {
                resolve: () => {},
                reject: (error) => {
                    this.askUserResolvers.delete(id)
                    resolve({ status: 'canceled', reason: error.message })
                }
            }, toolCallId)
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
                answers: normalizeUserAnswers(response.answers)
            }
        }
        const question = this.userQuestions.get(response.id)
        if (question) {
            this.userQuestions.delete(response.id)
            const decision = response.decision ?? (response.approved ? 'approved' : 'denied')
            this.endUserWait(response.id)
            const flatAnswers = normalizeUserAnswers(response.answers)
            question(flatAnswers ? { decision, answers: flatAnswers } : { decision })
            pending.resolve()
            return {
                status: response.approved ? 'approved' : 'denied',
                decision,
                reason: response.reason,
                answers: flatAnswers
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
            this.options.onAbortClose?.(cancellation)
            this.options.onCancelIssued?.()
            await cancellation
        }
        if (request) {
            let outcome = mapDecisionToOutcome(request, decision, this.options.sessionScopedPermissionGrants)
            if (response.approved && (isClarifyPermissionRequest(request) || isAskUserPermissionRequest(request))) {
                const answeredOptionId = mapClarifyAnswerToOptionId(request, response.answers)
                if (answeredOptionId !== null) {
                    outcome = { outcome: 'selected', optionId: answeredOptionId }
                } else if (firstAnswerLabel(response.answers) !== null) {
                    // Free-text ("Other") that matches no offered choice
                    // cannot be expressed on the permission surface — send
                    // hermes' dismissal semantics (the Skip option) instead
                    // of fabricating an answer the user never picked.
                    outcome = mapDecisionToOutcome(request, 'denied', this.options.sessionScopedPermissionGrants)
                }
                // No answer text at all → plain-approve mapping (first
                // allow_once choice) already applies.
            }
            await this.backend.respondToPermission(
                request.sessionId,
                request,
                outcome
            )
        }
        this.endUserWait(response.id)
        pending.resolve()

        return {
            status: response.approved ? 'approved' : 'denied',
            decision,
            reason: response.reason,
            answers: response.answers
        }
    }

    protected handleMissingPendingResponse(response: PermissionResponseMessage): void {
        logger.debug('[ACP] Permission response received for unknown request', response.id)
    }

    private startUserWait(id: string): void {
        const end = this.options.onUserWait?.()
        if (end) this.userWaitEnds.set(id, end)
    }

    private endUserWait(id: string): void {
        const end = this.userWaitEnds.get(id)
        this.userWaitEnds.delete(id)
        end?.()
    }

    /** Whether a request with this id is open or was already shown. */
    isUsed(id: string): boolean {
        return this.usedIds.has(id) || this.pendingRequests.has(id)
    }

    hasPendingRequests(): boolean {
        return this.pendingBackendRequests.size > 0 || this.userQuestions.size > 0
    }

    async cancelAll(reason: string): Promise<void> {
        // Questions first: answering them cannot fail, while a permission
        // reply can throw once the agent process is gone.
        const questions = Array.from(this.userQuestions.entries())
        this.userQuestions.clear()
        for (const [id, answer] of questions) {
            this.endUserWait(id)
            answer({ decision: 'abort' })
        }
        const pending = Array.from(this.pendingBackendRequests.values())
        this.pendingBackendRequests.clear()
        for (const request of pending) {
            await this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' })
            this.endUserWait(request.id)
        }
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'abort'
        })
    }
}

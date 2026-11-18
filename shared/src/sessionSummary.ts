import type { AgentState, AttachedJob, ExternalRef, Metadata, Session, TodoItem, WorktreeMetadata } from './schemas'
import type { SessionReadState } from './sessionReadState'
import type { ConversationHistoryCapabilities } from './conversationHistory'
import { isKnownFlavor } from './flavors'
import type { AgentFlavor } from './modes'

export type ForkSessionSummary = {
    text: string
    updatedAt: number
}

/** Seed a fork's generated/native title without claiming manual-name ownership. */
export function buildForkSessionSummary(
    metadata: { name?: string; summary?: { text?: string } | null } | null | undefined,
    updatedAt: number = Date.now()
): ForkSessionSummary | undefined {
    const sourceTitle = metadata?.name?.trim() || metadata?.summary?.text?.trim()
    if (!sourceTitle) return undefined

    return {
        text: `Fork: ${sourceTitle}`,
        updatedAt
    }
}

export type PendingRequestKind = 'permission' | 'input'

const INPUT_REQUEST_TOOLS = new Set([
    'AskUserQuestion',
    'ask_user_question',
    'CursorAskQuestion',
    'cursor_ask_question',
    'ExitPlanMode',
    'exit_plan_mode',
    'request_user_input'
])

/** Cap on `pendingRequests` carried in `SessionSummary`. The list is meant for
 *  per-row hover copy ("Approve `Bash`, `Edit` (+1 more)"); deep inspection
 *  should use `Session.agentState.requests`. The `pendingRequestsCount` field
 *  is the authoritative total — `pendingRequests.length` may be smaller. */
export const PENDING_REQUEST_SUMMARY_CAP = 5

export type PendingRequest = {
    id: string
    kind: PendingRequestKind
    tool: string
    /** Epoch ms when the request was raised; falls back to the caller-supplied
     *  `fallbackSince` (typically `session.updatedAt`) for older requests
     *  stored without `createdAt`. */
    since: number
}

/** Whether a request asks the user to answer something (a question, a plan)
 *  or to allow a tool. */
export function classifyKind(tool: string): PendingRequestKind {
    return INPUT_REQUEST_TOOLS.has(tool) ? 'input' : 'permission'
}

export type SessionSummaryMetadata = {
    name?: string
    titleLocked?: boolean
    path: string
    machineId?: string
    summary?: { text: string }
    promptTitle?: string
    flavor?: string | null
    worktree?: WorktreeMetadata
    agentSessionId?: string
    lifecycleState?: string
    /** Structured contribution links (GitHub PRs, …). tiann/hapi#1160. */
    externalRefs?: ExternalRef[]
    conversationHistory?: ConversationHistoryCapabilities
    /** Loopback MCP URL when session CLI happy server is running (#956). */
    hapiMcpUrl?: string
    lastModelError?: {
        eventId: string
        kind: string
        transient: boolean
        rawSnippet: string
        atTs: number
        priorAssistantClaimsDone: boolean
        bridgedForEventId?: string
        retriedAndFailed?: boolean
        supersededByUserTurn?: boolean
        bridgeable?: boolean
        acknowledgedAt?: number
        notifiedAt?: number
    }
}

export type SessionSummary = {
    contentRevision?: number
    readState?: SessionReadState
    hasConversationContent?: boolean
    id: string
    active: boolean
    thinking: boolean
    activeAt: number
    updatedAt: number
    /** Creation time is the stable order key before the first user message. */
    createdAt?: number
    /** Original timestamp of the latest user message; absent before any input. */
    lastUserMessageAt?: number
    pinned?: boolean
    globalPinned?: boolean
    metadata: SessionSummaryMetadata | null
    /** Watermarks for structured SSE patches (PR #897). List cache must gate
     *  without requiring a detail query — otherwise global SSE forces O(N)
     *  /sessions invalidation for every versioned write. */
    metadataVersion: number
    agentStateVersion: number
    todosUpdatedAt: number
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    pendingRequestKinds: PendingRequestKind[]
    /** Capped, oldest-first slice of pending tool requests. Use this for tooltip
     *  / per-row UX. The full count (which may exceed the cap) is in
     *  `pendingRequestsCount`. */
    pendingRequests: PendingRequest[]
    backgroundTaskCount: number
    /**
     * Hub-derived "open tool work exists in the transcript tail" (work-scoped
     * liveness). True when the hub's sweep found a tool call that started but
     * never settled — the autonomous-round case where `thinking` is false and
     * no background task is declared, yet the agent is demonstrably working.
     * Optional because older hubs never send it.
     */
    derivedToolWork?: boolean
    futureScheduledMessageCount: number
    /** Epoch ms of the soonest uninvoked future scheduled message, or null. */
    nextScheduledAt: number | null
    /**
     * Primary running session-attached job (tiann/hapi#1404), or null.
     * Independent of agent `active` / thinking — work that outlives the agent.
     */
    attachedJob: AttachedJob | null
    /** Watermark for versioned `attachedJob` SSE patches (dual EventSource race). */
    attachedJobUpdatedAt: number
    model: string | null
    modelReasoningEffort?: string | null
    effort: string | null
}

// Re-exported as a standalone derivation so SSE patch handlers can recompute
// summary fields from a structured `agentState` patch without needing the
// full Session in hand.
export function computePendingRequestKinds(agentState: AgentState | null | undefined): PendingRequestKind[] {
    const requests = agentState?.requests
    if (!requests) {
        return []
    }

    const kinds = new Set<PendingRequestKind>()
    for (const request of Object.values(requests)) {
        kinds.add(classifyKind(request.tool))
    }

    return kinds.has('permission') && kinds.has('input')
        ? ['permission', 'input']
        : Array.from(kinds)
}

export function computePendingRequests(
    agentState: AgentState | null | undefined,
    fallbackSince: number,
    cap: number = PENDING_REQUEST_SUMMARY_CAP
): PendingRequest[] {
    const requests = agentState?.requests
    if (!requests) {
        return []
    }

    const items: PendingRequest[] = []
    for (const [id, request] of Object.entries(requests)) {
        items.push({
            id,
            kind: classifyKind(request.tool),
            tool: request.tool,
            since: typeof request.createdAt === 'number' ? request.createdAt : fallbackSince
        })
    }

    items.sort((a, b) => {
        if (a.since !== b.since) return a.since - b.since
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    return cap >= items.length ? items : items.slice(0, cap)
}

export function getPendingRequestKinds(session: Session): PendingRequestKind[] {
    return computePendingRequestKinds(session.agentState)
}

export function getPendingRequests(
    session: Session,
    cap: number = PENDING_REQUEST_SUMMARY_CAP
): PendingRequest[] {
    return computePendingRequests(session.agentState, session.updatedAt, cap)
}

export function computePendingRequestsCount(agentState: AgentState | null | undefined): number {
    return agentState?.requests ? Object.keys(agentState.requests).length : 0
}

export function computeTodoProgress(todos: TodoItem[] | undefined): SessionSummary['todoProgress'] {
    if (!todos?.length) {
        return null
    }
    return {
        completed: todos.filter((todo) => todo.status === 'completed').length,
        total: todos.length
    }
}

const AGENT_SESSION_ID_FIELD_BY_FLAVOR: Partial<Record<AgentFlavor, keyof Metadata>> = {
    claude: 'claudeSessionId',
    codex: 'codexSessionId',
    gemini: 'geminiSessionId',
    opencode: 'opencodeSessionId',
    grok: 'grokSessionId',
    agy: 'agySessionId',
    cursor: 'cursorSessionId',
    kimi: 'kimiSessionId',
    copilot: 'copilotSessionId',
    pi: 'piSessionId',
    dsh: 'dshSessionId',
    hermes: 'hermesSessionId',
    berry: 'berrySessionId'
}

function getSummaryAgentSessionId(metadata: Metadata): string | undefined {
    const flavor = metadata.flavor
    if (isKnownFlavor(flavor)) {
        const flavorField = AGENT_SESSION_ID_FIELD_BY_FLAVOR[flavor]
        if (!flavorField) return undefined
        const flavorSessionId = metadata[flavorField]
        return typeof flavorSessionId === 'string' && flavorSessionId.trim()
            ? flavorSessionId.trim()
            : undefined
    }

    // Legacy fallback only applies when the stored flavor is missing or unknown.
    return metadata.codexSessionId
        ?? metadata.claudeSessionId
        ?? metadata.geminiSessionId
        ?? metadata.opencodeSessionId
        ?? metadata.grokSessionId
        ?? metadata.agySessionId
        ?? metadata.cursorSessionId
        ?? metadata.kimiSessionId
        ?? metadata.copilotSessionId
        ?? metadata.dshSessionId
        ?? undefined
}

export function toSessionSummaryMetadata(metadata: Metadata | null | undefined): SessionSummaryMetadata | null {
    if (!metadata) {
        return null
    }
    return {
        name: metadata.name,
        titleLocked: metadata.titleLocked,
        path: metadata.path,
        machineId: metadata.machineId ?? undefined,
        summary: metadata.summary ? { text: metadata.summary.text } : undefined,
        promptTitle: metadata.promptTitle,
        flavor: metadata.flavor ?? null,
        worktree: metadata.worktree,
        agentSessionId: getSummaryAgentSessionId(metadata),
        lifecycleState: metadata.lifecycleState,
        externalRefs: metadata.externalRefs,
        conversationHistory: metadata.capabilities?.conversationHistory,
        hapiMcpUrl: metadata.hapiMcpUrl ?? undefined,
        // Omit lastUserMessage — bridge recovery text stays in full session
        // metadata only; list/SSE summaries must not ship up to 32 KB of prompt.
        lastModelError: metadata.lastModelError
            ? (() => {
                const {
                    lastUserMessage: _omitLastUserMessage,
                    ...summaryError
                } = metadata.lastModelError
                return summaryError
            })()
            : undefined
    }
}

/**
 * `lastModelError` as carried by view=slim list rows. The list row only
 * renders the urgent-model-error halo, which needs the state fields
 * (`eventId`, `kind`, `transient`, bridge/outcome flags, `acknowledgedAt`).
 * The diagnostic payload (`rawSnippet`, `priorAssistantClaimsDone`,
 * timestamps) belongs to the detail banner, which reads the full session
 * metadata from GET /sessions/:id — never this projection.
 */
export type SessionSummaryModelErrorSlim = Omit<
    NonNullable<SessionSummaryMetadata['lastModelError']>,
    'rawSnippet' | 'priorAssistantClaimsDone' | 'atTs' | 'notifiedAt'
>

/**
 * Metadata projection for view=slim list rows. Same fields as
 * {@link SessionSummaryMetadata} minus `hapiMcpUrl` (no list surface reads
 * it) and with the detail-only model-error payload trimmed to its state
 * fields. Everything the session list, its hover tooltips, search and
 * mention chips read stays.
 */
export type SessionSummaryMetadataSlim = Omit<SessionSummaryMetadata, 'hapiMcpUrl' | 'lastModelError'> & {
    lastModelError?: SessionSummaryModelErrorSlim
}

/**
 * view=slim projection of {@link SessionSummary} for GET /api/sessions?view=slim.
 *
 * Runtime contract (audited against every web list consumer): fields that no
 * list surface reads are absent (`model`, `modelReasoningEffort`, `effort`,
 * `metadata.hapiMcpUrl`, `activeAt`, model-error diagnostics), and fields at
 * their empty default are omitted instead of materialized
 * (`pendingRequests: []`, `todoProgress: null`, `attachedJob: null`,
 * `backgroundTaskCount: 0`, default `readState`, `thinking/active/pinned`
 * when false, …). All web readers access them through optional chaining,
 * `?? default` or falsy checks, so an absent key is indistinguishable from
 * the default. SSE keep-alive patches re-materialize the concrete values
 * they carry, so cache rows self-heal to full fidelity between refetches.
 *
 * Always present even when at their default: `id`, `updatedAt`, `createdAt`
 * (stable order key fallback), and the version watermarks
 * `metadataVersion` / `agentStateVersion` / `todosUpdatedAt` — the SSE patch
 * gates compare `patch.version >= current`, and `>= undefined` is always
 * false, so omitting them would silently drop structured patches.
 */
export type SessionSummarySlim = Partial<Omit<SessionSummary, 'metadata'>> & {
    id: string
    updatedAt: number
    createdAt?: number
    metadataVersion: number
    agentStateVersion: number
    todosUpdatedAt: number
    metadata: SessionSummaryMetadataSlim | null
}

function toSlimSessionSummaryMetadata(
    metadata: SessionSummaryMetadata | null
): SessionSummaryMetadataSlim | null {
    if (!metadata) {
        return null
    }
    const { hapiMcpUrl: _omitHapiMcpUrl, lastModelError, ...rest } = metadata
    if (!lastModelError) {
        return rest
    }
    const {
        rawSnippet: _omitRawSnippet,
        priorAssistantClaimsDone: _omitPriorClaims,
        atTs: _omitAtTs,
        notifiedAt: _omitNotifiedAt,
        ...slimError
    } = lastModelError
    return { ...rest, lastModelError: slimError }
}

/** True when the read state is the all-default "never interacted" state and
 *  carries no signal for the list (unread dot, merge winner). */
function isDefaultReadState(readState: SessionSummary['readState']): boolean {
    return readState !== undefined
        && (readState.version ?? 0) === 0
        && (readState.readRevision ?? 0) === 0
        && readState.manualUnread !== true
}

/** view=slim projection for list rows: drop detail-only fields and omit
 *  empty-default fields so the wire payload stays compact. See
 *  {@link SessionSummarySlim} for the runtime contract. */
export function toSlimSessionSummary(
    session: Session,
    extras?: Parameters<typeof toSessionSummary>[1]
): SessionSummarySlim {
    const summary = toSessionSummary(session, extras)
    const {
        model: _omitModel,
        modelReasoningEffort: _omitModelReasoningEffort,
        effort: _omitEffort,
        activeAt: _omitActiveAt,
        metadata,
        ...rest
    } = summary

    const slim: SessionSummarySlim = {
        ...rest,
        metadata: toSlimSessionSummaryMetadata(metadata)
    }

    if (slim.thinking === false) delete slim.thinking
    if (slim.active === false) delete slim.active
    if (slim.pinned === false) delete slim.pinned
    if (slim.globalPinned === false) delete slim.globalPinned
    if (slim.derivedToolWork === false) delete slim.derivedToolWork
    if (slim.hasConversationContent === false) delete slim.hasConversationContent
    if (slim.contentRevision === 0) delete slim.contentRevision
    if (slim.backgroundTaskCount === 0) delete slim.backgroundTaskCount
    if (slim.futureScheduledMessageCount === 0) delete slim.futureScheduledMessageCount
    if (slim.pendingRequestsCount === 0) delete slim.pendingRequestsCount
    if (slim.pendingRequests?.length === 0) delete slim.pendingRequests
    if (slim.pendingRequestKinds?.length === 0) delete slim.pendingRequestKinds
    if (slim.todoProgress === null) delete slim.todoProgress
    if (slim.nextScheduledAt === null) delete slim.nextScheduledAt
    if (slim.attachedJob === null) delete slim.attachedJob
    if (slim.attachedJobUpdatedAt === 0) delete slim.attachedJobUpdatedAt
    if (isDefaultReadState(slim.readState)) delete slim.readState

    return slim
}

export function toSessionSummary(
    session: Session,
    extras?: {
        attachedJob?: AttachedJob | null
        /** Explicit SSE/list watermark; required when attachedJob is null so
         *  a REST refetch does not reset the client gate to 0. */
        attachedJobUpdatedAt?: number
    }
): SessionSummary {
    const attachedJob = extras?.attachedJob ?? null
    return {
        hasConversationContent: session.hasConversationContent ?? false,
        id: session.id,
        active: session.active,
        thinking: session.thinking,
        activeAt: session.activeAt,
        updatedAt: session.updatedAt,
        contentRevision: session.contentRevision,
        readState: session.readState,
        createdAt: session.createdAt,
        lastUserMessageAt: session.lastUserMessageAt,
        pinned: session.pinned ?? false,
        globalPinned: session.globalPinned ?? false,
        metadata: toSessionSummaryMetadata(session.metadata),
        metadataVersion: session.metadataVersion,
        agentStateVersion: session.agentStateVersion,
        todosUpdatedAt: session.todosUpdatedAt ?? 0,
        todoProgress: computeTodoProgress(session.todos),
        pendingRequestsCount: computePendingRequestsCount(session.agentState),
        pendingRequestKinds: computePendingRequestKinds(session.agentState),
        pendingRequests: computePendingRequests(session.agentState, session.updatedAt),
        backgroundTaskCount: session.backgroundTaskCount ?? 0,
        derivedToolWork: session.derivedToolWork === true,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        attachedJob,
        attachedJobUpdatedAt: extras?.attachedJobUpdatedAt
            ?? attachedJob?.updatedAt
            ?? 0,
        model: session.model,
        modelReasoningEffort: session.modelReasoningEffort,
        effort: session.effort
    }
}

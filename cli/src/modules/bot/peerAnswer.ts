/**
 * Answer another session's pending request on its behalf (`hapi peer-answer`):
 * a worker's tool-permission prompt or its structured question (Claude Code's
 * `AskUserQuestion`, DSH's `ask_user_question`, Cursor's `CursorAskQuestion`,
 * Codex's `request_user_input`). Wraps the routes the web permission cards use:
 *
 *   POST /api/sessions/:id/permissions/:requestId/approve   { answers?, decision? }
 *   POST /api/sessions/:id/permissions/:requestId/deny      { decision? }
 *
 * The command surface is deliberately narrow, because a wrong answer here
 * steers another agent:
 *
 * - a permission prompt is answered with `--approve` or `--deny`, nothing else;
 *   answer flags on it are an error (they would otherwise read as "approve");
 * - a question is canceled with `--deny` or answered completely — a
 *   single question with `--option <text or 1-based index>` / `--text`, several
 *   with one `--answer <n>=<option or text>` each; a missing question is an
 *   error and nothing partial is ever sent;
 * - `--option` must hit exactly one option and is never passed through as free
 *   text; free text goes through `--text` / `--answer` only.
 *
 * The answer shape follows the web client (`AskUserQuestionFooter`): flat
 * `Record<questionKey, string[]>` keyed by question index for the Claude family,
 * by question id for Cursor; option values are option labels (Cursor: option
 * id first). `request_user_input` takes the nested
 * `Record<id, { answers: string[] }>` with free text as `user_note: …`.
 */

import { z } from 'zod'
import { isObject } from '@hapi/protocol'
import { resolveSessionByPrefix, type PingPeerSessionSummary } from '@/modules/pingPeer/pingPeer'
import {
    BotClientError,
    botAuthHeaders,
    botStatusError,
    resolveBotAuth,
    type BotAuthContext,
    type BotClientOptions
} from './botClient'

export type PeerAnswerRequest = {
    tool: string
    arguments?: unknown
}

export type PeerAnswerInput = {
    /** Permission prompts only. */
    approve?: boolean
    /** Permission prompts: reject. Questions: cancel. */
    deny?: boolean
    /** Single-question form: option text (exact) or 1-based index; repeatable for multi-select. */
    options?: string[]
    /** Single-question form: free-text answer. */
    text?: string
    /** Which question `options` / `text` answer, 1-based. Default: the only question. */
    question?: number
    /** Several questions: one `<n>=<option or text>` per question, `n` 1-based. */
    answers?: string[]
}

export type PeerAnswerPlan = {
    approve: boolean
    body: Record<string, unknown>
    /** What the agent will see, in one line. */
    summary: string
}

type QuestionOption = { label: string; id?: string }
type Question = { index: number; key: string; prompt: string; options: QuestionOption[]; multi: boolean }
type AnswerShape = 'flat-index' | 'flat-id' | 'nested-id'

const CLAUDE_QUESTION_TOOLS = new Set(['AskUserQuestion', 'ask_user_question', 'mcp__hapi__ask_user_question'])
const CURSOR_QUESTION_TOOL = 'CursorAskQuestion'
const REQUEST_USER_INPUT_TOOL = 'request_user_input'

export function isQuestionTool(tool: string): boolean {
    return CLAUDE_QUESTION_TOOLS.has(tool) || tool === CURSOR_QUESTION_TOOL || tool === REQUEST_USER_INPUT_TOOL
}

function answerShapeFor(tool: string): AnswerShape {
    if (tool === CURSOR_QUESTION_TOOL) return 'flat-id'
    if (tool === REQUEST_USER_INPUT_TOOL) return 'nested-id'
    return 'flat-index'
}

function readString(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    return typeof value === 'string' ? value.trim() : ''
}

/** Questions of a question tool's input, in the web client's key / value conventions. */
export function parseQuestionToolInput(tool: string, input: unknown): Question[] {
    const shape = answerShapeFor(tool)
    if (!isObject(input) || !Array.isArray(input.questions)) return []
    const questions: Question[] = []
    input.questions.forEach((raw, index) => {
        if (!isObject(raw)) return
        const record = raw as Record<string, unknown>
        const id = readString(record, 'id')
        const key = shape === 'flat-index' ? String(index) : (id || String(index))
        const prompt = readString(record, 'question') || readString(record, 'prompt') || `Question ${index + 1}`
        const rawOptions = Array.isArray(record.options) ? record.options : []
        const options: QuestionOption[] = rawOptions.flatMap((option) => {
            if (!isObject(option)) return []
            const optionRecord = option as Record<string, unknown>
            const label = readString(optionRecord, 'label')
            const optionId = readString(optionRecord, 'id')
            return label ? [{ label, ...(optionId ? { id: optionId } : {}) }] : []
        })
        const multi = record.multiSelect === true || record.multiple === true
        questions.push({ index, key, prompt, options, multi })
    })
    return questions
}

function optionValue(tool: string, option: QuestionOption): string {
    return tool === CURSOR_QUESTION_TOOL && option.id ? option.id : option.label
}

function optionsList(question: Question): string {
    return question.options.length === 0
        ? 'no options; answer in your own words with --text'
        : question.options.map((option, i) => `${i + 1}. ${option.label}`).join('  ')
}

/**
 * Resolve one choice against a question's options: an exact label (after
 * trimming) or a 1-based index. With `strict` anything else is an error —
 * it is never passed through as free text.
 */
export function resolveOptionChoice(question: Question, rawChoice: string, tool: string, options: { strict: boolean }): string {
    const choice = rawChoice.trim()
    if (!choice) {
        throw new BotClientError('bad_args', 'an option cannot be blank')
    }
    const exact = question.options.filter((option) => option.label === choice)
    if (exact.length === 1) return optionValue(tool, exact[0]!)
    if (exact.length > 1) {
        throw new BotClientError('bad_args', `"${choice}" names ${exact.length} options of question ${question.index + 1}; use the index`)
    }
    if (/^\d+$/.test(choice)) {
        const option = question.options[Number(choice) - 1]
        if (option) return optionValue(tool, option)
        throw new BotClientError('bad_args', `option ${choice} is out of range for question ${question.index + 1} (${optionsList(question)})`)
    }
    if (options.strict) {
        throw new BotClientError('bad_args', `"${choice}" is not an option of question ${question.index + 1} (${optionsList(question)}); free text goes through --text`)
    }
    return choice
}

/** Decide what to send. Every refusal is a `bad_args` with the reason. */
export function buildPeerAnswerPlan(request: PeerAnswerRequest, input: PeerAnswerInput): PeerAnswerPlan {
    const tool = request.tool
    const questionTool = isQuestionTool(tool)
    const answerFieldsUsed = Boolean(input.options?.length || input.text !== undefined || input.question !== undefined || input.answers?.length)

    if (input.approve && input.deny) {
        throw new BotClientError('bad_args', 'choose --approve or --deny, not both')
    }

    if (!questionTool) {
        if (answerFieldsUsed) {
            throw new BotClientError('bad_args', `${tool} is a permission request, not a question: answer it with --approve or --deny`)
        }
        if (input.deny) {
            return { approve: false, body: {}, summary: `denied ${tool}` }
        }
        if (input.approve) {
            return { approve: true, body: { decision: 'approved' }, summary: `approved ${tool} (once)` }
        }
        throw new BotClientError('bad_args', `${tool} is a permission request, not a question: pass --approve or --deny`)
    }

    if (input.approve) {
        throw new BotClientError('bad_args', `${tool} is a question, not a permission request: answer it with --option / --text / --answer, or cancel it with --deny`)
    }
    if (input.deny) {
        if (answerFieldsUsed) {
            throw new BotClientError('bad_args', '--deny cancels the whole question and takes no answers')
        }
        return { approve: false, body: {}, summary: `canceled ${tool}` }
    }

    const questions = parseQuestionToolInput(tool, request.arguments)
    if (questions.length === 0) {
        throw new BotClientError('bad_args', `the ${tool} request has no questions to answer; cancel it with --deny`)
    }
    const shape = answerShapeFor(tool)
    const byQuestion = new Map<number, string[]>()
    const target = (n: number): Question => {
        const question = questions[n - 1]
        if (!question) {
            throw new BotClientError('bad_args', `question ${n} does not exist; this request has ${questions.length} (1..${questions.length})`)
        }
        return question
    }
    const add = (n: number, value: string) => {
        const list = byQuestion.get(n) ?? []
        list.push(value)
        byQuestion.set(n, list)
    }

    for (const raw of input.answers ?? []) {
        const match = /^(\d+)\s*=\s*([\s\S]*)$/.exec(raw.trim())
        if (!match) {
            throw new BotClientError('bad_args', `--answer must look like <n>=<option or text> (got "${raw}")`)
        }
        const n = Number(match[1])
        const value = match[2]!.trim()
        if (!value) {
            throw new BotClientError('bad_args', `--answer ${n}= is empty`)
        }
        add(n, resolveOptionChoice(target(n), value, tool, { strict: false }))
    }

    if (input.options?.length || input.text !== undefined) {
        const n = input.question ?? (questions.length === 1 ? 1 : undefined)
        if (n === undefined) {
            throw new BotClientError(
                'bad_args',
                `this request has ${questions.length} questions; answer each with --answer <n>=<option or text> (1..${questions.length})`
            )
        }
        const question = target(n)
        for (const choice of input.options ?? []) {
            add(n, resolveOptionChoice(question, choice, tool, { strict: true }))
        }
        const text = input.text?.trim() ?? ''
        if (input.text !== undefined && !text) {
            throw new BotClientError('bad_args', '--text is empty')
        }
        if (text) add(n, text)
    }

    const missing = questions.filter((question) => !(byQuestion.get(question.index + 1)?.length))
    if (missing.length > 0) {
        const given = [...byQuestion.values()].some((values) => values.length > 0)
        throw new BotClientError(
            'bad_args',
            given
                ? `no answer for question(s): ${missing.map((question) => `${question.index + 1}. ${question.prompt}`).join('; ')} — nothing was sent`
                : `answer every question: ${missing.map((question) => `${question.index + 1}. ${question.prompt}`).join('; ')} — with --answer <n>=<option or text>, with --option / --text for a single question, or cancel with --deny`
        )
    }

    const flat: Record<string, string[]> = {}
    const nested: Record<string, { answers: string[] }> = {}
    const parts: string[] = []
    for (const question of questions) {
        const values = byQuestion.get(question.index + 1)!
        if (shape === 'nested-id') {
            nested[question.key] = { answers: values.map((value) => (question.options.some((option) => optionValue(tool, option) === value) ? value : `user_note: ${value}`)) }
        } else {
            flat[question.key] = values
        }
        parts.push(`${question.index + 1}. ${question.prompt} → ${values.join(', ')}`)
    }
    return {
        approve: true,
        body: { answers: shape === 'nested-id' ? nested : flat },
        summary: `answered ${tool}: ${parts.join('; ')}`
    }
}

// ── Hub call ─────────────────────────────────────────────────────────────

export type PeerAnswerOptions = BotClientOptions & {
    /** Full id or unique prefix of the session that waits on the request. */
    sessionIdPrefix: string
    requestId: string
    input: PeerAnswerInput
}

export type PeerAnswerResult = {
    sessionId: string
    requestId: string
    tool: string
    plan: PeerAnswerPlan
}

const FULL_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SessionListSchema = z.object({ sessions: z.array(z.object({ id: z.string() })).optional() })
// Looser than the shared AgentStateRequestSchema on purpose: only the tool
// name and (when present) the input matter here.
const PendingRequestSchema = z.object({
    tool: z.string(),
    arguments: z.unknown().optional(),
    createdAt: z.number().nullish()
})
const SessionWithRequestsSchema = z.object({
    session: z.object({
        id: z.string(),
        agentState: z.object({ requests: z.record(z.string(), PendingRequestSchema).nullish() }).nullish()
    })
})

/** A full id goes straight to the row; a prefix is resolved through the session list (same rule as ping-peer). */
export async function resolvePeerSessionId(auth: BotAuthContext, prefix: string): Promise<string> {
    const trimmed = prefix.trim()
    if (!trimmed) throw new BotClientError('bad_args', 'session id prefix is required')
    if (FULL_SESSION_UUID.test(trimmed)) {
        return trimmed
    }
    const response = await auth.http.get(`${auth.apiUrl}/api/sessions`, {
        headers: botAuthHeaders(auth.jwt),
        timeout: 15_000,
        validateStatus: () => true
    })
    const error = botStatusError('list sessions', response)
    if (error) throw error
    const sessions = SessionListSchema.parse(response.data).sessions ?? []
    try {
        return resolveSessionByPrefix(sessions as unknown as PingPeerSessionSummary[], trimmed).id
    } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'not_found' || code === 'ambiguous') {
            throw new BotClientError(code === 'ambiguous' ? 'bad_args' : 'not_found', (error as Error).message)
        }
        throw error
    }
}

/**
 * Load the pending request (its options are needed to turn `--option 2` into
 * a label), decide the answer, and post it. The hub rejects a request that
 * was answered or expired in the meantime (404 / 409).
 */
export async function answerRequest(options: PeerAnswerOptions): Promise<PeerAnswerResult> {
    const requestId = (options.requestId ?? '').trim()
    if (!requestId) {
        throw new BotClientError('bad_args', 'request id is required')
    }
    const auth = await (options.auth ? options.auth.get() : resolveBotAuth(options))
    const sessionId = await resolvePeerSessionId(auth, options.sessionIdPrefix)

    const sessionResponse = await auth.http.get(`${auth.apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
        headers: botAuthHeaders(auth.jwt),
        timeout: 15_000,
        validateStatus: () => true
    })
    const sessionError = botStatusError(`load session ${sessionId}`, sessionResponse, `no session ${sessionId}`)
    if (sessionError) throw sessionError
    const parsedSession = SessionWithRequestsSchema.safeParse(sessionResponse.data)
    const request = parsedSession.success ? parsedSession.data.session.agentState?.requests?.[requestId] : undefined
    if (!request) {
        throw new BotClientError(
            'not_found',
            `no pending request ${requestId} on session ${sessionId} (it may have been answered or expired)`
        )
    }
    const plan = buildPeerAnswerPlan(request, options.input)

    const response = await auth.http.post(
        `${auth.apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/${plan.approve ? 'approve' : 'deny'}`,
        plan.body,
        { headers: botAuthHeaders(auth.jwt), timeout: 30_000, validateStatus: () => true }
    )
    const answerError = botStatusError(
        'answer',
        response,
        `no pending request ${requestId} on session ${sessionId} (it may have been answered or expired)`
    )
    if (answerError) throw answerError
    return { sessionId, requestId, tool: request.tool, plan }
}

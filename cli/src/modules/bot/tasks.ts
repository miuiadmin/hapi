/**
 * Schedules for a bot, on the hub's existing `session_tasks`:
 *
 *   GET    /api/sessions/:id/tasks          list
 *   POST   /api/sessions/:id/tasks          create (`repeat` or `queue`)
 *   PATCH  /api/sessions/:id/tasks/:taskId  { paused }
 *   DELETE /api/sessions/:id/tasks/:taskId
 *
 * A `repeat` task sends the same prompt every `intervalMs`; a `queue` task
 * sends a list of prompts one at a time, each `intervalMs` after the agent
 * took the previous one. A one-shot (`at`) is a `repeat` task with `maxRuns: 1`
 * and `startAt`, not a scheduled message: it has a task id, so the bot can
 * see it in the list, pause it and delete it, and the hub drops the row once
 * its single prompt has been taken. The hub owns every schedule and resumes
 * the session when a prompt is due; the tool always reports the next run so
 * the agent can check it.
 */

import { z } from 'zod'
import {
    SESSION_TASK_MAX_INTERVAL_MS,
    SESSION_TASK_MAX_ITEMS,
    SESSION_TASK_MAX_RUNS,
    SESSION_TASK_MAX_START_OFFSET_MS,
    SESSION_TASK_MAX_TEXT_LENGTH,
    SESSION_TASK_MIN_INTERVAL_MS,
    SESSION_TASK_START_GRACE_MS,
    SessionTaskSchema,
    type CreateSessionTaskRequest,
    type SessionTask
} from '@hapi/protocol'
import { BotClientError, botAuthHeaders, botRequest, type BotClientOptions } from './botClient'
import { humanizeDuration, parseDurationMs, parsePointInTime } from './time'

export type BotTaskOptions = BotClientOptions & { sessionId: string }

const TaskResponseSchema = z.object({ task: SessionTaskSchema })
const TaskListResponseSchema = z.object({ tasks: z.array(SessionTaskSchema) })

const tasksPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/tasks`

function requireSessionId(sessionId: string | undefined): string {
    const id = (sessionId ?? '').trim()
    if (!id) {
        throw new BotClientError('bad_args', 'a session id is required (inside a session HAPI_SESSION_ID is set; otherwise pass --session <id>)')
    }
    return id
}

function requireTaskId(taskId: string | undefined): string {
    const id = (taskId ?? '').trim()
    if (!id) {
        throw new BotClientError('bad_args', 'task id is required')
    }
    return id
}

export async function listTasks(options: BotTaskOptions): Promise<SessionTask[]> {
    const sessionId = requireSessionId(options.sessionId)
    return botRequest(options, {
        action: 'list tasks',
        notFoundMessage: `no session ${sessionId}`,
        request: async ({ jwt, http }) => http.get(tasksPath(sessionId), {
            headers: botAuthHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }),
        parse: (data) => TaskListResponseSchema.parse(data).tasks
    })
}

export async function createTask(
    options: BotTaskOptions & { body: CreateSessionTaskRequest }
): Promise<SessionTask> {
    const sessionId = requireSessionId(options.sessionId)
    return botRequest(options, {
        action: 'create task',
        notFoundMessage: `no session ${sessionId}`,
        request: async ({ jwt, http }) => http.post(tasksPath(sessionId), options.body, {
            headers: botAuthHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }),
        parse: (data) => TaskResponseSchema.parse(data).task
    })
}

export async function updateTask(
    options: BotTaskOptions & { taskId: string; paused: boolean }
): Promise<SessionTask> {
    const sessionId = requireSessionId(options.sessionId)
    const taskId = requireTaskId(options.taskId)
    return botRequest(options, {
        action: `${options.paused ? 'pause' : 'resume'} task ${taskId}`,
        notFoundMessage: `no task ${taskId} on session ${sessionId}`,
        request: async ({ jwt, http }) => http.patch(
            `${tasksPath(sessionId)}/${encodeURIComponent(taskId)}`,
            { paused: options.paused },
            { headers: botAuthHeaders(jwt), timeout: 15_000, validateStatus: () => true }
        ),
        parse: (data) => TaskResponseSchema.parse(data).task
    })
}

export async function deleteTask(options: BotTaskOptions & { taskId: string }): Promise<void> {
    const sessionId = requireSessionId(options.sessionId)
    const taskId = requireTaskId(options.taskId)
    await botRequest(options, {
        action: `delete task ${taskId}`,
        notFoundMessage: `no task ${taskId} on session ${sessionId}`,
        request: async ({ jwt, http }) => http.delete(
            `${tasksPath(sessionId)}/${encodeURIComponent(taskId)}`,
            { headers: botAuthHeaders(jwt), timeout: 15_000, validateStatus: () => true }
        ),
        parse: () => undefined
    })
}

// ── Spec building ────────────────────────────────────────────────────────

export type BotTaskInput = {
    /** The prompt of a repeating task, or the text of a one-shot. */
    text?: string
    /** The prompts of a queue task. */
    prompts?: string[]
    /** Gap between runs: `90m`, `2h`, `1d`. */
    every?: string
    /** One-shot time: ISO 8601 or `in 30m`. */
    at?: string
    /** First run of a repeat / queue task: ISO 8601 or `in 30m`. Default now. */
    startAt?: string
    /** Stop a repeat task after this many sends. */
    maxRuns?: number
}

export type BotTaskSpec =
    | { kind: 'repeat'; text: string; intervalMs: number; startAt?: number; maxRuns?: number }
    | { kind: 'queue'; prompts: string[]; intervalMs: number; startAt?: number }

function assertTaskText(text: string, label: string): string {
    const trimmed = text.trim()
    if (!trimmed) {
        throw new BotClientError('bad_args', `${label} must not be blank`)
    }
    if (text.length > SESSION_TASK_MAX_TEXT_LENGTH) {
        throw new BotClientError('bad_args', `${label} must be at most ${SESSION_TASK_MAX_TEXT_LENGTH} characters`)
    }
    return text.trim()
}

function parseInterval(every: string): number {
    const ms = parseDurationMs(every)
    if (ms === null) {
        throw new BotClientError('bad_args', `cannot parse every="${every}" (use 90m, 2h, 1d …)`)
    }
    if (ms < SESSION_TASK_MIN_INTERVAL_MS) {
        throw new BotClientError('bad_args', `every=${every} is shorter than the hub minimum of ${humanizeDuration(SESSION_TASK_MIN_INTERVAL_MS)}`)
    }
    if (ms > SESSION_TASK_MAX_INTERVAL_MS) {
        throw new BotClientError('bad_args', `every=${every} is longer than the hub maximum of ${humanizeDuration(SESSION_TASK_MAX_INTERVAL_MS)}`)
    }
    return ms
}

/** The hub's first-run window: not more than 60s in the past, not more than 366 days ahead. */
function parseFirstRun(startAt: string | undefined, now: number, label = 'startAt'): number | undefined {
    if (startAt === undefined) return undefined
    const ms = parsePointInTime(startAt, now)
    if (ms === null) {
        throw new BotClientError('bad_args', `cannot parse ${label}="${startAt}" (ISO 8601 or "in 30m")`)
    }
    if (ms < now - SESSION_TASK_START_GRACE_MS) {
        throw new BotClientError('bad_args', `${label}="${startAt}" is in the past`)
    }
    if (ms > now + SESSION_TASK_MAX_START_OFFSET_MS) {
        throw new BotClientError('bad_args', `${label}="${startAt}" is more than a year ahead`)
    }
    return ms
}

/** Turn tool / shell input into exactly one of the schedules, or fail with why. */
export function buildTaskSpec(input: BotTaskInput, now: number = Date.now()): BotTaskSpec {
    const prompts = (input.prompts ?? []).map((prompt) => assertTaskText(prompt, 'prompts'))
    const hasEvery = input.every !== undefined
    const hasAt = input.at !== undefined

    if (hasEvery && hasAt) {
        throw new BotClientError('bad_args', 'use either every (repeating task) or at (one-shot), not both')
    }
    if (input.maxRuns !== undefined && (!hasEvery || prompts.length > 0)) {
        throw new BotClientError('bad_args', 'maxRuns only applies to a repeating task (every), not a queue or a one-shot')
    }
    if (prompts.length > 0 && input.text !== undefined) {
        throw new BotClientError('bad_args', 'use either prompts (a queue) or text, not both')
    }

    if (hasAt) {
        if (prompts.length > 0) {
            throw new BotClientError('bad_args', 'a one-shot takes text, not prompts')
        }
        if (input.startAt !== undefined) {
            throw new BotClientError('bad_args', 'a one-shot takes at, not startAt')
        }
        if (input.text === undefined) {
            throw new BotClientError('bad_args', 'text is required for a one-shot')
        }
        // A single run: the interval is meaningless but the hub requires one
        // of at least a minute; `maxRuns: 1` makes the hub drop the task once
        // its prompt has been taken.
        return {
            kind: 'repeat',
            text: assertTaskText(input.text, 'text'),
            intervalMs: SESSION_TASK_MIN_INTERVAL_MS,
            startAt: parseFirstRun(input.at, now, 'at')!,
            maxRuns: 1
        }
    }

    if (prompts.length > 0) {
        if (!hasEvery) {
            throw new BotClientError('bad_args', 'a queue task needs every (the gap between prompts)')
        }
        if (prompts.length > SESSION_TASK_MAX_ITEMS) {
            throw new BotClientError('bad_args', `a queue takes at most ${SESSION_TASK_MAX_ITEMS} prompts`)
        }
        const startAt = parseFirstRun(input.startAt, now)
        return {
            kind: 'queue',
            prompts,
            intervalMs: parseInterval(input.every!),
            ...(startAt !== undefined ? { startAt } : {})
        }
    }

    if (hasEvery) {
        if (input.text === undefined) {
            throw new BotClientError('bad_args', 'text is required for a repeating task')
        }
        const maxRuns = input.maxRuns
        if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > SESSION_TASK_MAX_RUNS)) {
            throw new BotClientError('bad_args', `maxRuns must be an integer from 1 to ${SESSION_TASK_MAX_RUNS}`)
        }
        const startAt = parseFirstRun(input.startAt, now)
        return {
            kind: 'repeat',
            text: assertTaskText(input.text, 'text'),
            intervalMs: parseInterval(input.every!),
            ...(startAt !== undefined ? { startAt } : {}),
            ...(maxRuns !== undefined ? { maxRuns } : {})
        }
    }

    throw new BotClientError('bad_args', 'give every (a repeating or queue task) or at (a one-shot)')
}

/** Create whatever `buildTaskSpec` produced and return the hub's task. */
export async function addTask(options: BotTaskOptions & { spec: BotTaskSpec }): Promise<SessionTask> {
    const spec = options.spec
    const body: CreateSessionTaskRequest = spec.kind === 'queue'
        ? { kind: 'queue', items: spec.prompts.map((text) => ({ text })), intervalMs: spec.intervalMs, ...(spec.startAt !== undefined ? { startAt: spec.startAt } : {}) }
        : { kind: 'repeat', text: spec.text, intervalMs: spec.intervalMs, ...(spec.startAt !== undefined ? { startAt: spec.startAt } : {}), ...(spec.maxRuns !== undefined ? { maxRuns: spec.maxRuns } : {}) }
    return createTask({ ...options, body })
}

/** Accept a task id or a unique prefix. */
export function resolveTaskId(tasks: SessionTask[], ref: string): string {
    const trimmed = (ref ?? '').trim()
    if (!trimmed) {
        throw new BotClientError('bad_args', 'task id is required')
    }
    const exact = tasks.filter((task) => task.id === trimmed)
    if (exact.length === 1) return exact[0]!.id
    const matches = tasks.filter((task) => task.id.startsWith(trimmed))
    if (matches.length === 0) {
        throw new BotClientError('not_found', `no task matching '${trimmed}'`)
    }
    if (matches.length > 1) {
        throw new BotClientError('bad_args', `task id prefix '${trimmed}' matches ${matches.length} tasks; use the full id`)
    }
    return matches[0]!.id
}

// ── Agent-readable text ──────────────────────────────────────────────────

/** A one-shot: one send in total. The hub deletes it once that prompt is taken. */
export function isOnceTask(task: Pick<SessionTask, 'kind' | 'totalRuns'>): boolean {
    return task.kind === 'repeat' && task.totalRuns === 1
}

export function formatTaskSchedule(task: SessionTask): string {
    if (isOnceTask(task)) return 'once'
    if (task.kind === 'queue') {
        const left = task.items.length - Math.min(task.runCount, task.items.length)
        return `queue of ${task.items.length} prompts every ${humanizeDuration(task.intervalMs)} (${left} left)`
    }
    return `repeat every ${humanizeDuration(task.intervalMs)}${task.totalRuns ? `, ${task.totalRuns} runs in total` : ', until deleted'}`
}

/** Always names the next run, so the agent can check the schedule it just made. */
export function formatNextRun(task: SessionTask, now: number = Date.now()): string {
    // A task that used up its runs (a one-shot that fired) is on its way out of the list; the hub clears it once
    // the last prompt is taken. Its stored "next run" is the schedule's interval, not a run that will happen.
    if (task.totalRuns !== null && task.runCount >= task.totalRuns) {
        return `finished: all ${task.totalRuns} run${task.totalRuns === 1 ? '' : 's'} done; it leaves the list once the last prompt is taken`
    }
    if (task.state === 'paused') return 'next run: (paused)'
    if (typeof task.nextRunAt === 'number') {
        const iso = new Date(task.nextRunAt).toISOString()
        const delta = task.nextRunAt - now
        return `next run: ${iso}${Math.abs(delta) >= 1000 ? ` (${delta > 0 ? 'in ' + humanizeDuration(delta) : 'overdue by ' + humanizeDuration(-delta)})` : ' (now)'}`
    }
    return task.pending
        ? 'next run: after the agent takes the previous prompt'
        : 'next run: (none scheduled)'
}

export function formatTaskLine(task: SessionTask, now: number = Date.now()): string {
    const head = `task ${task.id} [${task.state}] ${formatTaskSchedule(task)}`
    const runs = task.kind === 'repeat' && task.totalRuns
        ? `${task.runCount}/${task.totalRuns}`
        : String(task.runCount)
    const preview = task.kind === 'repeat'
        ? task.items[0]?.text ?? ''
        : task.items[Math.min(task.runCount, task.items.length - 1)]?.text ?? ''
    const snippet = preview.replace(/\s+/g, ' ').trim().slice(0, 80)
    return `${head}; ${formatNextRun(task, now)}; runs: ${runs}`
        + `${task.lastError ? `; last error: ${task.lastError}` : ''}`
        + (snippet ? `; "${snippet}${snippet.length === 80 ? '…' : ''}"` : '')
}

export function formatTaskCreated(task: SessionTask, now: number = Date.now()): string {
    return `created ${formatTaskLine(task, now)}; id: ${task.id}`
}

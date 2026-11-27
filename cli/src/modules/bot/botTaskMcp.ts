/**
 * MCP `bot_task`: schedules for the bot's own session, on the hub's session
 * tasks. Registered only in a bot's home chat. The hub resumes the session
 * when a prompt is due; the result always names the next run so the agent can
 * check the schedule it just made. A one-shot (`at`) is a task with a single
 * run — it is listed, paused and deleted like any other task. Shell twin:
 * `hapi task`.
 */

import { z } from 'zod'
import type { AxiosInstance } from 'axios'
import { SESSION_TASK_MAX_ITEMS, SESSION_TASK_MAX_RUNS, SESSION_TASK_MAX_TEXT_LENGTH } from '@hapi/protocol'
import { addTask, buildTaskSpec, deleteTask, formatTaskCreated, formatTaskLine, listTasks, resolveTaskId, updateTask } from './tasks'
import { BotClientError, botErrorMessage, createBotAuthSource } from './botClient'
import type { BotToolContext } from './botItemMcp'

export const BOT_TASK_TOOL_NAME = 'bot_task'

/** Written for selection: what to schedule, that the result names the next run, no polling. */
export const BOT_TASK_TOOL_DESCRIPTION = [
    'Schedules for this session, run by the hub (it resumes this session when a prompt is due). Bot home chat only.',
    'add with every: a repeating prompt (text) or a queue of prompts, each sent intervalMs after the previous one was taken;',
    'add with at: a one-shot that runs once at that time (ISO 8601 or "in 30m", up to a year ahead) — a normal task with an id, so list / pause / delete work on it.',
    'The result names the next run — read it to confirm the schedule.',
    'Use this instead of sleeping or polling. On a scheduled run that found nothing new, reply with nothing new; never present a plan as finished work.',
    'list / pause / resume / delete by task id.'
].join(' ')

export const botTaskInputSchema: z.ZodTypeAny = z.object({
    action: z.enum(['add', 'list', 'pause', 'resume', 'delete']).describe('add=list|pause|resume|delete'),
    taskId: z.string().trim().min(1).optional().describe('Task id or unique prefix (pause / resume / delete)'),
    text: z.string().max(SESSION_TASK_MAX_TEXT_LENGTH).optional().describe('The prompt of a repeating or one-shot task'),
    prompts: z.array(z.string().trim().min(1).max(SESSION_TASK_MAX_TEXT_LENGTH)).min(1).max(SESSION_TASK_MAX_ITEMS).optional()
        .describe('A queue of prompts, sent one at a time'),
    every: z.string().trim().min(1).optional().describe('Gap between runs: 90m, 2h, 1d, 1h30m (min 1m, max 30d)'),
    at: z.string().trim().min(1).optional().describe('One-shot: run once at this time — ISO 8601 or "in 30m" (not in the past, up to a year ahead)'),
    startAt: z.string().trim().min(1).optional().describe('First run of a repeating / queue task: ISO 8601 or "in 30m" (default now)'),
    maxRuns: z.number().int().min(1).max(SESSION_TASK_MAX_RUNS).optional().describe('Repeating task only (with every): stop after this many sends')
})

export type BotTaskToolArgs = {
    action: 'add' | 'list' | 'pause' | 'resume' | 'delete'
    taskId?: string
    text?: string
    prompts?: string[]
    every?: string
    at?: string
    startAt?: string
    maxRuns?: number
}

function fieldsUsed(args: BotTaskToolArgs, fields: Array<keyof BotTaskToolArgs>): boolean {
    return fields.some((field) => args[field] !== undefined)
}

export async function handleBotTaskTool(args: BotTaskToolArgs, ctx: BotToolContext): Promise<{ text: string; isError: boolean }> {
    const now = ctx.now ?? Date.now
    // One JWT exchange per tool call (pause / resume list, then update).
    const request = { sessionId: ctx.sessionId, http: ctx.http, apiUrl: ctx.apiUrl, accessToken: ctx.accessToken, auth: ctx.auth ?? createBotAuthSource(ctx) }
    try {
        switch (args.action) {
            case 'add': {
                if (args.taskId !== undefined) {
                    throw new BotClientError('bad_args', 'taskId is not accepted for action=add')
                }
                if (!fieldsUsed(args, ['text', 'prompts', 'every', 'at'])) {
                    throw new BotClientError('bad_args', 'action=add needs every (repeating / queue task) or at (one-shot), plus text or prompts')
                }
                const spec = buildTaskSpec({
                    text: args.text,
                    prompts: args.prompts,
                    every: args.every,
                    at: args.at,
                    startAt: args.startAt,
                    maxRuns: args.maxRuns
                }, now())
                const task = await addTask({ ...request, spec })
                return { text: formatTaskCreated(task, now()), isError: false }
            }
            case 'list': {
                if (fieldsUsed(args, ['taskId', 'text', 'prompts', 'every', 'at', 'startAt', 'maxRuns'])) {
                    throw new BotClientError('bad_args', 'action=list takes no other fields')
                }
                const tasks = await listTasks(request)
                if (tasks.length === 0) {
                    return { text: 'No tasks on this session.', isError: false }
                }
                return { text: [`${tasks.length} task(s):`, ...tasks.map((task) => `  ${formatTaskLine(task, now())}`)].join('\n'), isError: false }
            }
            case 'pause':
            case 'resume': {
                if (!args.taskId) {
                    throw new BotClientError('bad_args', `taskId is required for action=${args.action}`)
                }
                if (fieldsUsed(args, ['text', 'prompts', 'every', 'at', 'startAt', 'maxRuns'])) {
                    throw new BotClientError('bad_args', `action=${args.action} takes taskId only`)
                }
                const tasks = await listTasks(request)
                const taskId = resolveTaskId(tasks, args.taskId)
                const task = await updateTask({ ...request, taskId, paused: args.action === 'pause' })
                return { text: formatTaskLine(task, now()), isError: false }
            }
            case 'delete': {
                if (!args.taskId) {
                    throw new BotClientError('bad_args', 'taskId is required for action=delete')
                }
                if (fieldsUsed(args, ['text', 'prompts', 'every', 'at', 'startAt', 'maxRuns'])) {
                    throw new BotClientError('bad_args', 'action=delete takes taskId only')
                }
                const tasks = await listTasks(request)
                const taskId = resolveTaskId(tasks, args.taskId)
                await deleteTask({ ...request, taskId })
                return { text: `Deleted task ${taskId}`, isError: false }
            }
        }
    } catch (error) {
        return { text: `bot_task failed: ${botErrorMessage(error)}`, isError: true }
    }
}

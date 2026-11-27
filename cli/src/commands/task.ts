import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { assertTaskSessionAllowed } from '@/modules/bot/replyVia'
import {
    addTask,
    buildTaskSpec,
    deleteTask,
    formatTaskCreated,
    formatTaskLine,
    listTasks,
    resolveTaskId,
    updateTask
} from '@/modules/bot/tasks'
import {
    BotClientError,
    botErrorMessage,
    createBotAuthSource,
    exitCodeForBotClientError,
    type BotClientOptions
} from '@/modules/bot/botClient'
import type { CommandDefinition } from './types'

/**
 * `hapi task` — schedules for a session, run by the hub: `hapi task add
 * [--every 2h | --at "…"] --text "…"`, `list`, `pause`, `resume`, `delete`.
 * A one-shot (`--at`) is a task that runs once; it is listed, paused and
 * deleted like any other. The session is `HAPI_SESSION_ID` inside a
 * session, else `--session <id>`.
 */

export type ParsedTaskArgs = {
    help: boolean
    action?: 'add' | 'list' | 'pause' | 'resume' | 'delete'
    taskId?: string
    texts: string[]
    queue: boolean
    every?: string
    at?: string
    startAt?: string
    maxRuns?: number
    sessionId?: string
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi task')} - Schedules for a HAPI session, run by the hub

${chalk.bold('Usage:')}
  hapi task add --every 2h --text "…" [--start-at <time>] [--max-runs N]     repeating prompt
  hapi task add --at "…" --text "…"                                            run once at that time (up to a year ahead)
  hapi task add --queue --every 30m --text "…" --text "…"                      prompts sent one at a time
  hapi task list
  hapi task pause <taskId> | resume <taskId> | delete <taskId>

${chalk.bold('Arguments:')}
  --every <gap>     90m, 2h, 1d, 1h30m (hub: min 1m, max 30d)
  --at <time>       ISO 8601, "in 30m", or a bare date (2026-11-28 = local midnight); not in the past
  --start-at <time> first run of a repeating / queue task (default now)
  --session <id>    target session (default: HAPI_SESSION_ID). Inside a bot's session it must be this
                    session: a bot schedules only itself; to run something in another session, open or
                    message it with the peer tools (exit 5 otherwise)
  --                everything after it is positional (a text that starts with -)

${chalk.bold('Notes:')}
  The hub owns the schedule and resumes the session when a prompt is due; the
  output names the next run so you can check it. A one-shot (--at) shows as
  "once" in the list and disappears once its prompt was taken; pause or delete
  it by id like any other task. A queue sends the next prompt only after the
  agent took the previous one. Do not poll or sleep instead.
  On a scheduled run that found nothing new, stay quiet.
  Same hub token/namespace as this CLI. On a remote runner, set HAPI_API_URL and
  CLI_API_TOKEN (or \`hapi auth login\`).

${chalk.bold('Exit codes:')}
  0 ok · 2 bad arguments or peer tools disabled · 3 auth · 4 no such task / session · 5 refused (by the hub, or not yours to do) · 1 other
`)
}

function takeValue(args: string[], index: number, flag: string): { value: string; next: number } {
    const arg = args[index]!
    if (arg.startsWith(`${flag}=`)) {
        return { value: arg.slice(flag.length + 1), next: index + 1 }
    }
    const value = args[index + 1]
    if (value === undefined) {
        throw new BotClientError('bad_args', `${flag} requires a value`)
    }
    return { value, next: index + 2 }
}

export function parseTaskArgs(args: string[]): ParsedTaskArgs {
    const result: ParsedTaskArgs = { help: false, texts: [], queue: false }
    const positionals: string[] = []

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--') {
            // Everything after it is positional (a text that starts with -).
            positionals.push(...args.slice(i + 1))
            break
        }
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--queue') {
            result.queue = true
            continue
        }
        if (arg === '--text' || arg.startsWith('--text=')) {
            const { value, next } = takeValue(args, i, '--text')
            result.texts.push(value)
            i = next - 1
            continue
        }
        if (arg === '--every' || arg.startsWith('--every=')) {
            const { value, next } = takeValue(args, i, '--every')
            result.every = value
            i = next - 1
            continue
        }
        if (arg === '--at' || arg.startsWith('--at=')) {
            const { value, next } = takeValue(args, i, '--at')
            result.at = value
            i = next - 1
            continue
        }
        if (arg === '--start-at' || arg.startsWith('--start-at=')) {
            const { value, next } = takeValue(args, i, '--start-at')
            result.startAt = value
            i = next - 1
            continue
        }
        if (arg === '--max-runs' || arg.startsWith('--max-runs=')) {
            const { value, next } = takeValue(args, i, '--max-runs')
            const n = Number(value)
            if (!Number.isInteger(n) || n < 1) {
                throw new BotClientError('bad_args', '--max-runs must be a positive integer')
            }
            result.maxRuns = n
            i = next - 1
            continue
        }
        if (arg === '--session' || arg.startsWith('--session=')) {
            const { value, next } = takeValue(args, i, '--session')
            if (!value.trim()) throw new BotClientError('bad_args', '--session requires an id')
            result.sessionId = value.trim()
            i = next - 1
            continue
        }
        if (arg.startsWith('-')) {
            throw new BotClientError('bad_args', `unexpected flag: ${arg}`)
        }
        positionals.push(arg)
    }

    const [action, ref, ...extra] = positionals
    if (action !== undefined) {
        if (!['add', 'list', 'pause', 'resume', 'delete'].includes(action)) {
            throw new BotClientError('bad_args', `unknown action '${action}' (add|list|pause|resume|delete)`)
        }
        result.action = action as ParsedTaskArgs['action']
    }
    const positionalText = ref !== undefined || extra.length > 0 ? [ref, ...extra].filter(Boolean).join(' ') : ''
    if (result.action === 'add') {
        if (positionalText && result.texts.length > 0) {
            throw new BotClientError('bad_args', 'give the text as a positional or with --text, not both')
        }
        // `hapi task add <text>` without --text.
        if (positionalText) result.texts.push(positionalText)
    } else {
        if (ref !== undefined) result.taskId = ref
        if (extra.length > 0) {
            throw new BotClientError('bad_args', `unexpected arg: ${extra[0]} (hapi task ${result.action ?? '<action>'} takes one task id)`)
        }
    }

    if (result.action === 'add') {
        if (result.texts.length === 0) throw new BotClientError('bad_args', 'hapi task add needs the text: --text "…" (or as a positional)')
        if (!result.queue && result.texts.length > 1) {
            throw new BotClientError('bad_args', 'several --text need --queue (a repeating or one-shot task takes one text)')
        }
        if (result.queue && result.at !== undefined) {
            throw new BotClientError('bad_args', 'a one-shot (--at) takes one --text, not --queue')
        }
        if (result.every === undefined && result.at === undefined) {
            throw new BotClientError('bad_args', 'hapi task add needs --every (repeating / queue task) or --at (one-shot)')
        }
    }
    if (result.action !== 'add' && [result.every, result.at, result.startAt, result.maxRuns].some((value) => value !== undefined)) {
        throw new BotClientError('bad_args', '--every/--at/--start-at/--max-runs are only valid with hapi task add')
    }
    if (result.action !== 'add' && result.texts.length > 0) {
        throw new BotClientError('bad_args', '--text is only valid with hapi task add')
    }
    if (['pause', 'resume', 'delete'].includes(result.action ?? '') && !result.taskId) {
        throw new BotClientError('bad_args', `hapi task ${result.action} <taskId>`)
    }
    if (result.action === 'list' && result.taskId !== undefined) {
        throw new BotClientError('bad_args', 'hapi task list takes no task id')
    }
    return result
}

export const TASK_USAGE = 'hapi task add|list|pause|resume|delete'

/** `--help` prints the help and exits 0; a bare `hapi task` prints it and fails with the usage line. No hub credential needed. */
export function handleTaskHelpOrUsage(args: string[]): 'handled' | 'run' {
    const parsed = parseTaskArgs(args)
    if (parsed.help) {
        showHelp()
        return 'handled'
    }
    if (parsed.action === undefined) {
        showHelp()
        throw new BotClientError('bad_args', `missing action; usage: ${TASK_USAGE}`)
    }
    return 'run'
}

export async function handleTaskCommand(args: string[], deps: BotClientOptions = {}): Promise<void> {
    const parsed = parseTaskArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }
    if (parsed.action === undefined) {
        showHelp()
        throw new BotClientError('bad_args', `missing action; usage: ${TASK_USAGE}`)
    }
    // A bot schedules only itself; outside a bot session --session is free.
    assertTaskSessionAllowed(parsed.sessionId)
    const sessionId = parsed.sessionId ?? process.env[HAPI_SESSION_ID_ENV]?.trim() ?? ''
    // One JWT exchange for the whole command (list + pause, for instance).
    const request: BotClientOptions & { sessionId: string } = { ...deps, auth: deps.auth ?? createBotAuthSource(deps), sessionId }
    const now = Date.now()

    switch (parsed.action) {
        case 'add': {
            const spec = buildTaskSpec({
                ...(parsed.queue ? { prompts: parsed.texts } : { text: parsed.texts[0] }),
                every: parsed.every,
                at: parsed.at,
                startAt: parsed.startAt,
                maxRuns: parsed.maxRuns
            }, now)
            const task = await addTask({ ...request, spec })
            console.log(chalk.green(`hapi task: ${formatTaskCreated(task, now)}`))
            return
        }
        case 'list': {
            const tasks = await listTasks(request)
            if (tasks.length === 0) {
                console.log('No tasks on this session.')
                return
            }
            console.log([`${tasks.length} task(s):`, ...tasks.map((task) => `  ${formatTaskLine(task, now)}`)].join('\n'))
            return
        }
        case 'pause':
        case 'resume': {
            const tasks = await listTasks(request)
            const taskId = resolveTaskId(tasks, parsed.taskId!)
            const task = await updateTask({ ...request, taskId, paused: parsed.action === 'pause' })
            console.log(chalk.green(`hapi task: ${formatTaskLine(task, now)}`))
            return
        }
        case 'delete': {
            const tasks = await listTasks(request)
            const taskId = resolveTaskId(tasks, parsed.taskId!)
            await deleteTask({ ...request, taskId })
            console.log(chalk.green(`hapi task: Deleted task ${taskId}`))
            return
        }
    }
}

export const taskCommand: CommandDefinition = {
    name: 'task',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            if (handleTaskHelpOrUsage(commandArgs) === 'handled') return
            await initializeToken()
            await handleTaskCommand(commandArgs)
        } catch (error) {
            if (error instanceof BotClientError) {
                console.error(chalk.red('hapi task:'), error.message)
                process.exit(exitCodeForBotClientError(error))
            }
            console.error(chalk.red('hapi task:'), botErrorMessage(error))
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

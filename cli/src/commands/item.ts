import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import {
    BOT_ITEM_STATUSES,
    askItem,
    commentItem,
    createItem,
    formatAskText,
    formatBotItemDetail,
    formatBotItemList,
    formatBotItemLine,
    listItemEvents,
    listItems,
    normalizeAsk,
    normalizeItemRef,
    updateItem,
    type BotItemRef
} from '@/modules/bot/items'
import {
    BotClientError,
    botErrorMessage,
    createBotAuthSource,
    exitCodeForBotClientError,
    type BotClientOptions
} from '@/modules/bot/botClient'
import { requireWriteFromSessionId, resolveBotId } from '@/modules/bot/replyVia'
import { parsePointInTime } from '@/modules/bot/time'
import type { CommandDefinition } from './types'

/**
 * `hapi item` — the bot's ledger from a shell (any flavor's session).
 * `hapi item add|set|ask|comment|list|show|done|cancel`. The bot is
 * `HAPI_BOT_ID` inside a bot's home chat, else `--bot <id>`.
 */

export type ParsedItemArgs = {
    help: boolean
    action?: 'add' | 'set' | 'ask' | 'comment' | 'list' | 'show' | 'done' | 'cancel'
    itemRef?: BotItemRef
    title?: string
    detail?: string
    status?: (typeof BOT_ITEM_STATUSES)[number]
    /** A session id, or `null` from `--worker none` (detach). */
    workerSessionId?: string | null
    /** A time, or `null` from `--snooze-until none` (clear). */
    snoozeUntil?: string | null
    question?: string
    options: string[]
    recommended?: number
    text?: string
    all?: boolean
    botId?: string
}

const ITEM_ACTIONS = ['add', 'set', 'ask', 'comment', 'list', 'show', 'done', 'cancel'] as const

function showHelp(): void {
    console.log(`
${chalk.bold('hapi item')} - The bot's ledger of deliverables and decisions

${chalk.bold('Usage:')}
  hapi item add <title> [--detail <text>] [--status planned|working] [--worker <sessionId>]
  hapi item set <n> [--status planned|working|waiting|done|canceled] [--title <t>] [--detail <text>] [--worker <sessionId>] [--snooze-until <time>]
  hapi item ask <n> --question "…" [--option "…" …] [--recommended N] [--detail <background>]
  hapi item comment <n> <text>
  hapi item list [--all]
  hapi item show <n>
  hapi item done <n> [--detail <result>]
  hapi item cancel <n>

${chalk.bold('Arguments:')}
  <n>          item number (12 or #12) or item id
  <time>       ISO 8601, "in 30m", or a bare date (2026-11-28 = local midnight)
  --worker <sessionId>   attach the worker; --worker none detaches it
  --snooze-until <time>  hide the item until then; --snooze-until none clears it
  --                    everything after it is positional (a title that starts with -)

${chalk.bold('Notes:')}
  One item per deliverable and per decision. Attach the worker session once opened
  (--worker). "ask" puts the item to your owner (needs_you) with options and a
  recommendation; their comment arrives back in this session as a new message.
  The bot is taken from HAPI_BOT_ID (set inside a bot's home chat), else --bot <id>.
  Same hub token/namespace as this CLI. On a remote runner, set HAPI_API_URL and
  CLI_API_TOKEN (or \`hapi auth login\`).

${chalk.bold('Exit codes:')}
  0 ok · 2 bad arguments or peer tools disabled · 3 auth · 4 no such item / session · 5 refused by the hub · 1 other
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

export function parseItemArgs(args: string[]): ParsedItemArgs {
    const result: ParsedItemArgs = { help: false, options: [] }
    const positionals: string[] = []

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--') {
            // Everything after it is positional: a title that starts with `-`.
            positionals.push(...args.slice(i + 1))
            break
        }
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--all') {
            result.all = true
            continue
        }
        if (arg === '--bot' || arg.startsWith('--bot=')) {
            const { value, next } = takeValue(args, i, '--bot')
            if (!value.trim()) throw new BotClientError('bad_args', '--bot requires an id')
            result.botId = value
            i = next - 1
            continue
        }
        if (arg === '--title' || arg.startsWith('--title=')) {
            const { value, next } = takeValue(args, i, '--title')
            result.title = value
            i = next - 1
            continue
        }
        if (arg === '--detail' || arg.startsWith('--detail=')) {
            const { value, next } = takeValue(args, i, '--detail')
            result.detail = value
            i = next - 1
            continue
        }
        if (arg === '--status' || arg.startsWith('--status=')) {
            const { value, next } = takeValue(args, i, '--status')
            if (!(BOT_ITEM_STATUSES as readonly string[]).includes(value)) {
                throw new BotClientError('bad_args', `--status must be one of ${BOT_ITEM_STATUSES.join('|')}`)
            }
            result.status = value as ParsedItemArgs['status']
            i = next - 1
            continue
        }
        if (arg === '--worker' || arg === '--worker-session-id' || arg.startsWith('--worker=') || arg.startsWith('--worker-session-id=')) {
            const flag = arg.split('=')[0]!
            const { value, next } = takeValue(args, i, flag)
            if (!value.trim()) throw new BotClientError('bad_args', `${flag} takes a session id, or none to detach the worker`)
            result.workerSessionId = value.trim().toLowerCase() === 'none' ? null : value.trim()
            i = next - 1
            continue
        }
        if (arg === '--snooze-until' || arg.startsWith('--snooze-until=')) {
            const { value, next } = takeValue(args, i, '--snooze-until')
            if (!value.trim()) throw new BotClientError('bad_args', '--snooze-until takes a time (ISO 8601 or "in 30m"), or none to clear')
            result.snoozeUntil = value.trim().toLowerCase() === 'none' ? null : value
            i = next - 1
            continue
        }
        if (arg === '--text' || arg.startsWith('--text=')) {
            const { value, next } = takeValue(args, i, '--text')
            result.text = value
            i = next - 1
            continue
        }
        if (arg === '--question' || arg.startsWith('--question=')) {
            const { value, next } = takeValue(args, i, '--question')
            result.question = value
            i = next - 1
            continue
        }
        if (arg === '--option' || arg.startsWith('--option=')) {
            const { value, next } = takeValue(args, i, '--option')
            if (!value.trim()) throw new BotClientError('bad_args', '--option requires an option text')
            result.options.push(value)
            i = next - 1
            continue
        }
        if (arg === '--recommended' || arg.startsWith('--recommended=')) {
            const { value, next } = takeValue(args, i, '--recommended')
            // Number('') is 0: an empty value must not silently recommend the first option.
            if (!value.trim() || !/^\d+$/.test(value.trim())) throw new BotClientError('bad_args', '--recommended must be a zero-based option index')
            const n = Number(value.trim())
            if (!Number.isInteger(n) || n < 0) throw new BotClientError('bad_args', '--recommended must be a zero-based option index')
            result.recommended = n
            i = next - 1
            continue
        }
        if (arg.startsWith('-')) {
            throw new BotClientError('bad_args', `unexpected flag: ${arg}`)
        }
        positionals.push(arg)
    }

    const [action, ...rest] = positionals
    if (action !== undefined) {
        if (!(ITEM_ACTIONS as readonly string[]).includes(action)) {
            throw new BotClientError('bad_args', `unknown action '${action}' (${ITEM_ACTIONS.join('|')})`)
        }
        result.action = action as ParsedItemArgs['action']
    }
    const toRef = (raw: string): BotItemRef => normalizeItemRef(raw)
    const titleFromPositional = result.action === 'add' ? rest.join(' ') : ''

    switch (result.action) {
        case 'add':
            if (result.title !== undefined && titleFromPositional) {
                throw new BotClientError('bad_args', 'give the title as a positional or with --title, not both')
            }
            result.title = result.title ?? titleFromPositional
            if (!result.title?.trim()) throw new BotClientError('bad_args', 'hapi item add <title>')
            if (result.status !== undefined && !['planned', 'working'].includes(result.status)) {
                throw new BotClientError('bad_args', 'a new item starts as planned or working (--status)')
            }
            if (result.workerSessionId === null) {
                throw new BotClientError('bad_args', '--worker none detaches a worker; a new item has none (omit --worker)')
            }
            break
        case 'comment':
            result.itemRef = rest.length > 0 ? toRef(rest[0]!) : undefined
            result.text = result.text ?? rest.slice(1).join(' ')
            if (result.itemRef === undefined || !result.text?.trim()) {
                throw new BotClientError('bad_args', 'hapi item comment <n> <text>')
            }
            break
        case 'list':
            if (rest.length > 0) throw new BotClientError('bad_args', 'hapi item list takes no item')
            break
        case undefined:
            break
        default:
            if (rest.length === 0) throw new BotClientError('bad_args', `hapi item ${result.action} <n>`)
            if (rest.length > 1) throw new BotClientError('bad_args', `unexpected arg: ${rest[1]}`)
            result.itemRef = toRef(rest[0]!)
    }

    if (result.action === 'ask' && !result.question?.trim()) {
        throw new BotClientError('bad_args', 'hapi item ask needs --question "…"')
    }
    if (result.action === 'set' && [result.title, result.detail, result.status, result.workerSessionId, result.snoozeUntil].every((value) => value === undefined)) {
        throw new BotClientError('bad_args', 'hapi item set needs at least one of --status, --title, --detail, --worker, --snooze-until')
    }
    if (result.action === 'set' && result.status === 'needs_you') {
        throw new BotClientError('bad_args', 'needs_you is set by "hapi item ask"; use waiting for work held by someone else')
    }
    if (result.action !== 'ask' && (result.question !== undefined || result.options.length > 0 || result.recommended !== undefined)) {
        throw new BotClientError('bad_args', '--question/--option/--recommended are only valid with hapi item ask')
    }
    if (result.action !== 'set' && result.snoozeUntil !== undefined) {
        throw new BotClientError('bad_args', '--snooze-until is only valid with hapi item set')
    }
    if (result.action === 'list' && [result.title, result.detail, result.status, result.workerSessionId].some((value) => value !== undefined)) {
        throw new BotClientError('bad_args', 'hapi item list takes no item fields')
    }
    return result
}

export const ITEM_USAGE = 'hapi item add|set|ask|comment|list|show|done|cancel'

/**
 * Help and usage are answered before any hub credential is needed: `--help`
 * prints the help and exits 0; a bare `hapi item` prints the help and fails
 * with the usage line.
 */
export function handleItemHelpOrUsage(args: string[]): 'handled' | 'run' {
    const parsed = parseItemArgs(args)
    if (parsed.help) {
        showHelp()
        return 'handled'
    }
    if (parsed.action === undefined) {
        showHelp()
        throw new BotClientError('bad_args', `missing action; usage: ${ITEM_USAGE}`)
    }
    return 'run'
}

export async function handleItemCommand(args: string[], deps: BotClientOptions = {}): Promise<void> {
    const parsed = parseItemArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }
    if (parsed.action === undefined) {
        showHelp()
        throw new BotClientError('bad_args', `missing action; usage: ${ITEM_USAGE}`)
    }

    const botId = resolveBotId(parsed.botId)
    if (!botId) {
        throw new BotClientError('bad_args', 'not a bot session: run inside a bot\'s home chat (HAPI_BOT_ID) or pass --bot <id>')
    }
    // Inside a bot session this is mandatory for writes: the hub takes a write
    // without it as the owner's. Reads (list / show) are open to anyone.
    const fromSessionId = parsed.action === 'list' || parsed.action === 'show'
        ? process.env.HAPI_SESSION_ID?.trim() || undefined
        : requireWriteFromSessionId()
    // One JWT exchange for the whole command, however many hub calls it makes.
    const request: BotClientOptions & { botId: string; fromSessionId?: string } = { ...deps, auth: deps.auth ?? createBotAuthSource(deps), botId, fromSessionId }
    const now = Date.now()

    switch (parsed.action) {
        case 'list': {
            const items = await listItems(request)
            console.log(formatBotItemList(items, { all: parsed.all === true, now }))
            return
        }
        case 'add': {
            const item = await createItem({
                ...request,
                body: {
                    title: parsed.title!,
                    ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}),
                    ...(parsed.status !== undefined ? { status: parsed.status as 'planned' | 'working' } : {}),
                    ...(parsed.workerSessionId ? { workerSessionId: parsed.workerSessionId } : {})
                }
            })
            console.log(chalk.green(`hapi item: Created ${formatBotItemLine(item, now)}`))
            return
        }
        case 'set': {
            if (parsed.status === 'needs_you') {
                throw new BotClientError('bad_args', 'needs_you is set by "hapi item ask"; use waiting for work held by someone else')
            }
            const snoozeMs = typeof parsed.snoozeUntil === 'string' ? parsePointInTime(parsed.snoozeUntil, now) : undefined
            if (typeof parsed.snoozeUntil === 'string' && snoozeMs === null) {
                throw new BotClientError('bad_args', `cannot parse --snooze-until "${parsed.snoozeUntil}" (ISO 8601, a date for local midnight, or "in 30m")`)
            }
            const item = await updateItem({
                ...request,
                itemId: parsed.itemRef!,
                body: {
                    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
                    ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}),
                    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
                    ...(parsed.workerSessionId !== undefined ? { workerSessionId: parsed.workerSessionId } : {}),
                    // `none` clears: an explicit null, not an omitted field.
                    ...(snoozeMs !== undefined ? { snoozeUntil: snoozeMs } : parsed.snoozeUntil === null ? { snoozeUntil: null } : {})
                }
            })
            console.log(chalk.green(`hapi item: Updated ${formatBotItemLine(item, now)}`))
            return
        }
        case 'ask': {
            const body = normalizeAsk({
                question: parsed.question!,
                options: parsed.options,
                recommended: parsed.recommended ?? null
            })
            if (parsed.detail !== undefined) {
                await updateItem({ ...request, itemId: parsed.itemRef!, body: { detail: parsed.detail } })
            }
            const item = await askItem({ ...request, itemId: parsed.itemRef!, body })
            console.log(chalk.green(`hapi item: ${formatBotItemLine(item, now)}`))
            console.log(`  ${formatAskText(item.ask).split('\n').join('\n  ')}`)
            console.log('  The owner is notified; their comment comes back into this session as a new message and the item returns to working. End your turn now.')
            return
        }
        case 'comment': {
            const result = await commentItem({ ...request, itemId: parsed.itemRef!, body: { text: parsed.text! } })
            console.log(chalk.green(`hapi item: Commented on item ${parsed.itemRef}${result.item ? ` ${formatBotItemLine(result.item, now)}` : ''}`))
            return
        }
        case 'show': {
            const items = await listItems(request)
            const wanted = String(parsed.itemRef)
            const item = items.find((candidate) => candidate.id === wanted || String(candidate.number) === wanted)
            if (!item) {
                throw new BotClientError('not_found', `no item ${parsed.itemRef}`)
            }
            const events = await listItemEvents({ ...request, itemId: item.id })
            console.log(formatBotItemDetail(item, events, now))
            return
        }
        case 'done':
        case 'cancel': {
            const item = await updateItem({
                ...request,
                itemId: parsed.itemRef!,
                body: {
                    status: parsed.action === 'done' ? 'done' : 'canceled',
                    ...(parsed.action === 'done' && parsed.detail !== undefined ? { detail: parsed.detail } : {})
                }
            })
            console.log(chalk.green(`hapi item: ${formatBotItemLine(item, now)}`))
            return
        }
    }
}

export const itemCommand: CommandDefinition = {
    name: 'item',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            if (handleItemHelpOrUsage(commandArgs) === 'handled') return
            await initializeToken()
            await handleItemCommand(commandArgs)
        } catch (error) {
            if (error instanceof BotClientError) {
                console.error(chalk.red('hapi item:'), error.message)
                process.exit(exitCodeForBotClientError(error))
            }
            console.error(chalk.red('hapi item:'), botErrorMessage(error))
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

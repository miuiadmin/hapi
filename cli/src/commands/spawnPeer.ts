import { readFile } from 'node:fs/promises'
import chalk from 'chalk'
import { SESSION_NAME_MAX_LENGTH } from '@hapi/protocol'
import { CREATABLE_AGENT_FLAVORS, type AgentFlavor, type PermissionMode } from '@hapi/protocol/modes'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import { initializeToken } from '@/ui/tokenInit'
import {
    SpawnPeerError,
    exitCodeForSpawnPeerError,
    spawnPeer
} from '@/modules/spawnPeer/spawnPeer'
import {
    PEER_RECEIPT_FLAG_HELP,
    botNameFromEnv,
    requireWriteFromSessionId,
    resolveBotId,
    type PeerReplyVia
} from '@/modules/bot/replyVia'
import { updateItem } from '@/modules/bot/items'
import { BotClientError, botErrorMessage, createBotAuthSource, type BotAuthSource } from '@/modules/bot/botClient'
import { assertReceiptFeasible, settleReceipt } from './pingPeer'
import type { CommandDefinition } from './types'

type ParsedSpawnPeerArgs = {
    help: boolean
    directory?: string
    name?: string
    message?: string
    messageFile?: string
    agent?: AgentFlavor
    model?: string
    effort?: string
    sessionType?: 'simple' | 'worktree'
    permissionMode?: PermissionMode
    machine?: string
    waitActiveSecs?: number
    /** `--receipt hub|caller`; absent keeps the default (hub in a bot session, else none). */
    receipt?: PeerReplyVia
    /** `--item <n>`: attach the new session to this ledger item as its worker (needs a bot). */
    item?: string | number
    /** `--bot <id>`: the bot acting, when HAPI_BOT_ID is not set. */
    bot?: string
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi spawn-peer')} - Spawn a HAPI session and deliver a required first message

${chalk.bold('Usage:')}
  hapi spawn-peer --dir PATH --name TITLE --message-file -
  hapi spawn-peer --dir PATH --name TITLE --message-file <path>
  hapi spawn-peer --dir PATH --name TITLE <message-text>

${chalk.bold('Notes:')}
  Machine spawn (POST /api/machines/:id/spawn) creates an empty composer.
  Do not put the remit in the spawn JSON - the hub 400s message/prompt/text.
  This command spawns, optionally renames, delivers via the ping-peer path,
  then exits non-zero if the new session still has no user message.
  Same hub token/namespace as this CLI. Prefer MCP spawn_peer in-session.
  When HAPI_SESSION_ID is set, the remit is auto-stamped with a durable
  Parent [title](/sessions/<uuid>) chip (rename-proof identity).
  Inside a bot's home chat (HAPI_BOT_ID) the worker contract is appended to the
  remit (report results; stop before irreversible actions) and --receipt
  defaults to hub.
  ${PEER_RECEIPT_FLAG_HELP}

${chalk.bold('Options:')}
  --dir PATH              Working directory on the target machine (required; relative paths resolve here, not in the runner)
  --name TITLE            Session display name (required, 1-255 chars)
  --message-file PATH|-   Remit text (or - for stdin)
  --machine ID|hostname   Target runner (UUID or hostname from GET /api/machines; default: this host)
  --agent NAME            Agent flavor (default: hub peerSpawnDefaults, else claude)
  --model ID              Model override for the resolved agent flavor
  --effort LEVEL          Effort override (flavor-dependent; e.g. claude high)
  --session-type TYPE     simple | worktree (default: simple; worktree creates a new tree from PATH,
                          which must be a git repository)
  --permission-mode MODE  Optional; omit = hub/stock default (yolo). Pass to tighten or when named; not cloned from parent
  --wait SECONDS          Active/verify timeout (default 60, or HAPI_WAIT_ACTIVE_SECS)
  --receipt hub|caller    Where the worker's reply is awaited (see below); default hub with --bot / HAPI_BOT_ID
  --item N                Bot only: attach the new session to ledger item N as its worker
  --bot ID                The bot acting, when HAPI_BOT_ID is not set (worker contract, --item, hub receipt default)

  Cross-machine: --dir must exist on the TARGET host. Local existence is not required when
  --machine resolves to a different runner than this CLI's settings.machineId.

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
  HAPI_WAIT_ACTIVE_SECS (default 60; overridable with --wait)
  HAPI_SESSION_ID / HAPI_SESSION_NAME / HAPI_AGENT_SESSION_ID (Parent stamp when set)
  HAPI_BOT_ID / HAPI_BOT_NAME (bot home chat: worker contract, --item, hub receipt default)
`)
}

export function parseSpawnPeerArgs(args: string[]): ParsedSpawnPeerArgs {
    const result: ParsedSpawnPeerArgs = {
        help: false
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--dir') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--dir requires a path')
            }
            result.directory = value
            continue
        }
        if (arg.startsWith('--dir=')) {
            const value = arg.slice('--dir='.length)
            if (!value) {
                throw new SpawnPeerError('bad_args', '--dir requires a path')
            }
            result.directory = value
            continue
        }
        if (arg === '--name') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--name requires a title')
            }
            result.name = value
            continue
        }
        if (arg.startsWith('--name=')) {
            const value = arg.slice('--name='.length)
            if (!value) {
                throw new SpawnPeerError('bad_args', '--name requires a title')
            }
            result.name = value
            continue
        }
        if (arg === '--message-file') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--message-file requires a path (or - for stdin)')
            }
            result.messageFile = value
            continue
        }
        if (arg.startsWith('--message-file=')) {
            const value = arg.slice('--message-file='.length)
            if (!value) {
                throw new SpawnPeerError('bad_args', '--message-file requires a path (or - for stdin)')
            }
            result.messageFile = value
            continue
        }
        if (arg === '--agent') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--agent requires a flavor')
            }
            result.agent = parseAgent(value)
            continue
        }
        if (arg.startsWith('--agent=')) {
            result.agent = parseAgent(arg.slice('--agent='.length))
            continue
        }
        if (arg === '--model') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--model requires a model id')
            }
            result.model = value
            continue
        }
        if (arg.startsWith('--model=')) {
            const value = arg.slice('--model='.length)
            if (!value) {
                throw new SpawnPeerError('bad_args', '--model requires a model id')
            }
            result.model = value
            continue
        }
        if (arg === '--effort') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--effort requires a level')
            }
            result.effort = value
            continue
        }
        if (arg.startsWith('--effort=')) {
            const value = arg.slice('--effort='.length)
            if (!value) {
                throw new SpawnPeerError('bad_args', '--effort requires a level')
            }
            result.effort = value
            continue
        }
        if (arg === '--session-type') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--session-type requires simple or worktree')
            }
            result.sessionType = parseSessionType(value)
            continue
        }
        if (arg.startsWith('--session-type=')) {
            result.sessionType = parseSessionType(arg.slice('--session-type='.length))
            continue
        }
        if (arg === '--permission-mode') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--permission-mode requires a mode')
            }
            result.permissionMode = parsePermissionMode(value)
            continue
        }
        if (arg.startsWith('--permission-mode=')) {
            result.permissionMode = parsePermissionMode(arg.slice('--permission-mode='.length))
            continue
        }
        if (arg === '--machine') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--machine requires a UUID or hostname')
            }
            result.machine = value
            continue
        }
        if (arg.startsWith('--machine=')) {
            const value = arg.slice('--machine='.length)
            if (!value) {
                throw new SpawnPeerError('bad_args', '--machine requires a UUID or hostname')
            }
            result.machine = value
            continue
        }
        if (arg === '--wait') {
            const value = args[++i]
            if (!value) {
                throw new SpawnPeerError('bad_args', '--wait requires seconds')
            }
            result.waitActiveSecs = Number(value)
            continue
        }
        if (arg.startsWith('--wait=')) {
            result.waitActiveSecs = Number(arg.slice('--wait='.length))
            continue
        }
        if (arg === '--receipt' || arg.startsWith('--receipt=')) {
            const value = (arg === '--receipt' ? args[++i] : arg.slice('--receipt='.length)) ?? ''
            if (value !== 'hub' && value !== 'caller') {
                throw new SpawnPeerError('bad_args', '--receipt requires hub or caller')
            }
            if (result.receipt !== undefined) {
                throw new SpawnPeerError('bad_args', '--receipt may only be specified once')
            }
            result.receipt = value
            continue
        }
        if (arg === '--item' || arg.startsWith('--item=')) {
            const value = (arg === '--item' ? args[++i] : arg.slice('--item='.length)) ?? ''
            if (!value.trim()) {
                throw new SpawnPeerError('bad_args', '--item requires an item number or id')
            }
            result.item = /^\d+$/.test(value.trim()) ? Number(value.trim()) : value.trim()
            continue
        }
        if (arg === '--bot' || arg.startsWith('--bot=')) {
            const value = (arg === '--bot' ? args[++i] : arg.slice('--bot='.length)) ?? ''
            if (!value.trim()) {
                throw new SpawnPeerError('bad_args', '--bot requires an id')
            }
            result.bot = value.trim()
            continue
        }
        if (arg.startsWith('-')) {
            throw new SpawnPeerError('bad_args', `unexpected flag: ${arg}`)
        }
        if (result.message === undefined) {
            result.message = arg
            continue
        }
        throw new SpawnPeerError('bad_args', `unexpected arg: ${arg}`)
    }

    if (result.item !== undefined && !result.bot && !(process.env.HAPI_BOT_ID ?? '').trim()) {
        throw new SpawnPeerError('bad_args', '--item needs a bot: run inside a bot home chat (HAPI_BOT_ID) or pass --bot <id>')
    }

    if (result.waitActiveSecs !== undefined && (!Number.isFinite(result.waitActiveSecs) || result.waitActiveSecs <= 0)) {
        throw new SpawnPeerError('bad_args', '--wait must be a positive number of seconds')
    }

    return result
}

function parseAgent(value: string): AgentFlavor {
    if (!(CREATABLE_AGENT_FLAVORS as readonly string[]).includes(value)) {
        throw new SpawnPeerError(
            'bad_args',
            `unsupported --agent '${value}' (expected ${CREATABLE_AGENT_FLAVORS.join(', ')})`
        )
    }
    return value as AgentFlavor
}

function parseSessionType(value: string): 'simple' | 'worktree' {
    if (value !== 'simple' && value !== 'worktree') {
        throw new SpawnPeerError('bad_args', '--session-type must be simple or worktree')
    }
    return value
}

function parsePermissionMode(value: string): PermissionMode {
    const parsed = PermissionModeSchema.safeParse(value)
    if (!parsed.success) {
        throw new SpawnPeerError('bad_args', `unsupported --permission-mode '${value}'`)
    }
    return parsed.data
}

async function readMessage(parsed: ParsedSpawnPeerArgs): Promise<string> {
    if (parsed.messageFile !== undefined) {
        if (parsed.message !== undefined) {
            throw new SpawnPeerError('bad_args', 'provide message as an argument or --message-file, not both')
        }
        if (parsed.messageFile === '-') {
            const chunks: Buffer[] = []
            for await (const chunk of process.stdin) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            }
            return Buffer.concat(chunks).toString('utf8')
        }
        return await readFile(parsed.messageFile, 'utf8')
    }
    return parsed.message ?? ''
}

function envWaitActiveSecs(): number | undefined {
    const raw = process.env.HAPI_WAIT_ACTIVE_SECS
    if (!raw) {
        return undefined
    }
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
        throw new SpawnPeerError('bad_args', 'HAPI_WAIT_ACTIVE_SECS must be a positive number')
    }
    return value
}

export async function handleSpawnPeerCommand(args: string[]): Promise<void> {
    const parsed = parseSpawnPeerArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }

    if (!parsed.directory) {
        showHelp()
        throw new SpawnPeerError('bad_args', 'missing --dir; usage: hapi spawn-peer --dir PATH --name TITLE --message-file -')
    }
    const name = parsed.name?.trim() ?? ''
    if (!name || name.length > SESSION_NAME_MAX_LENGTH) {
        showHelp()
        throw new SpawnPeerError(
            'bad_args',
            `--name must be 1-${SESSION_NAME_MAX_LENGTH} characters`
        )
    }

    await initializeToken()

    const message = await readMessage(parsed)
    if (!message.trim()) {
        throw new SpawnPeerError(
            'bad_args',
            'missing message; provide as arg, --message-file PATH, or --message-file -'
        )
    }

    try {
        assertReceiptFeasible(parsed.receipt)
    } catch (error) {
        throw new SpawnPeerError('bad_args', error instanceof Error ? error.message : String(error))
    }
    const botId = resolveBotId(parsed.bot)
    const result = await spawnPeer({
        directory: parsed.directory,
        message,
        name,
        agent: parsed.agent,
        model: parsed.model,
        effort: parsed.effort,
        sessionType: parsed.sessionType,
        permissionMode: parsed.permissionMode,
        machine: parsed.machine,
        waitActiveSecs: parsed.waitActiveSecs ?? envWaitActiveSecs(),
        // Explicit --bot names the bot even without the env marker; otherwise
        // spawnPeer resolves the contract from HAPI_BOT_ID itself.
        ...(parsed.bot ? { workerContract: { botId: botId!, botName: botNameFromEnv() } } : {}),
        onProgress: (line) => console.log(`hapi spawn-peer: ${line}`)
    })

    // One JWT for the attach and the receipt registration.
    const auth = createBotAuthSource({})
    let itemNote = ''
    if (parsed.item !== undefined && botId) {
        itemNote = await attachWorkerToItem(botId, parsed.item, result.sessionId, auth)
    }
    // `--bot X` is the bot acting, so the receipt default follows it like the env marker does.
    const replyNote = await settleReceipt({ explicit: parsed.receipt, task: result, command: 'hapi spawn-peer', botId: botId ?? undefined, auth })
    console.log(chalk.green(`hapi spawn-peer: OK ${result.sessionId}  name="${result.name}"${itemNote}${replyNote}`))
}

/** `--item`: the new session becomes the item's worker. A failed attach never undoes the spawn. */
async function attachWorkerToItem(botId: string, item: string | number, workerSessionId: string, auth?: BotAuthSource): Promise<string> {
    try {
        const attached = await updateItem({
            auth,
            botId,
            itemId: item,
            // Mandatory inside a bot session: the hub takes a write without it as the owner's.
            fromSessionId: requireWriteFromSessionId(),
            body: { workerSessionId }
        })
        return `  attached to item #${attached.number} [${attached.status}] ${attached.title}`
    } catch (error) {
        const message = botErrorMessage(error)
        console.error(chalk.yellow(`hapi spawn-peer: could not attach to item ${item} (${message}); attach it with: hapi item set ${item} --worker ${workerSessionId}`))
        return ''
    }
}

export const spawnPeerCommand: CommandDefinition = {
    name: 'spawn-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleSpawnPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof SpawnPeerError) {
                console.error(chalk.red('hapi spawn-peer:'), error.message)
                process.exit(exitCodeForSpawnPeerError(error))
            }
            if (error instanceof BotClientError) {
                console.error(chalk.red('hapi spawn-peer:'), error.message)
                process.exit(1)
            }
            console.error(
                chalk.red('hapi spawn-peer:'),
                error instanceof Error ? error.message : 'Unknown error'
            )
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

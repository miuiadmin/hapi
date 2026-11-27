import { readFile } from 'node:fs/promises'
import chalk from 'chalk'
import { PeerDeliveryModeSchema, type PeerDeliveryMode } from '@/modules/pingPeer/deliveryMode'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { initializeToken } from '@/ui/tokenInit'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    formatPeerSessionsList,
    forwardPeerReply,
    listPeerSessions,
    peerListFetchLimit,
    pingPeer,
    supportsPeerReply
} from '@/modules/pingPeer/pingPeer'
import {
    PEER_RECEIPT_FLAG_HELP,
    botIdFromEnv,
    parseReplyVia,
    resolveReplyVia,
    settlePeerReply,
    type PeerReplyVia
} from '@/modules/bot/replyVia'
import { createBotAuthSource, type BotAuthSource } from '@/modules/bot/botClient'
import { registerReceipt } from '@/modules/bot/receipts'
import type { CommandDefinition } from './types'

type ParsedPingPeerArgs = {
    help: boolean
    list: boolean
    all: boolean
    wake: boolean
    sessionIdPrefix?: string
    message?: string
    messageFile?: string
    waitActiveSecs?: number
    deliveryMode?: PeerDeliveryMode
    /** `--receipt hub|caller`; absent keeps the default (hub in a bot session, else none). */
    receipt?: PeerReplyVia
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi ping-peer')} - Send a message to another HAPI session

${chalk.bold('Usage:')}
  hapi ping-peer <session-id-prefix> <message-text>
  hapi ping-peer <session-id-prefix> <message-text> --delivery-mode auto|queue|steer
  hapi ping-peer <session-id-prefix> <message-text> --wake   # resume if inactive
  hapi ping-peer <session-id-prefix> --message-file <path>
  hapi ping-peer <session-id-prefix> --message-file -   # read message from stdin
  hapi ping-peer <session-id-prefix> <message-text> --receipt hub|caller
  hapi ping-peer --list [--all]   # active sessions; --all includes inactive

${chalk.bold('Notes:')}
  Do not reinvent JWT + curl for peer handoffs. Prefer this command or MCP ping_peer / list_peers.
  Resolves by id prefix (8 chars OK). Same hub token/namespace as this CLI.
  Message only peers tied to your task; never broadcast to the --list output.
  Inactive targets are refused (exit 5) unless --wake, which resumes them via
  POST /api/sessions/:id/resume first. Wake only when the peer must act, not for FYI.
  --list rows mark [waiting] (a pending permission or question) and [background]
  (background tasks) after busy/idle/inactive; inspect_peer lists the pending requests.
  ${PEER_RECEIPT_FLAG_HELP}
  Delivery defaults to auto: steer an active turn when its target supports steering
  and is ready; otherwise queue. If steering cannot be confirmed after acceptance,
  auto keeps the same accepted message without resending; acceptance is not consumption.
  Use auto for routine collaboration when queueing is an acceptable fallback.
  Use queue for non-urgent updates that can wait. Use steer for important findings
  the peer needs to know now to adjust its current work, not after its current turn.
  State why the finding matters now and what the peer should adjust.
  Explicit steer requires an active turn in remote Claude, Pi, Codex, OpenCode,
  Antigravity (agy acp), or Cursor ACP; it neither resumes inactive targets nor
  sends to idle targets.
  Steer uses the existing queued-message action. If it fails after send, inspect the
  target before retrying: the accepted message may still be queued or consumed.
  When a user cites [title](/sessions/<id>) or Copy-reference
  See session "…" (/sessions/<id>) for context, pass that <id> here.
  On a remote runner, --list needs HAPI_API_URL set to the runner hub, plus
  CLI_API_TOKEN or \`hapi auth login\` for the token. Inside a session prefer MCP list_peers.

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
  HAPI_WAIT_ACTIVE_SECS (default 60; overridable with --wait)
  HAPI_SESSION_ID (where a receipt posts the reply), HAPI_BOT_ID (bot home chat)
`)
}

export function parsePingPeerArgs(args: string[]): ParsedPingPeerArgs {
    const result: ParsedPingPeerArgs = {
        help: false,
        list: false,
        all: false,
        wake: false
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--list') {
            result.list = true
            continue
        }
        if (arg === '--all') {
            result.all = true
            continue
        }
        if (arg === '--wake') {
            result.wake = true
            continue
        }
        if (arg === '--receipt' || arg.startsWith('--receipt=')) {
            const value = arg === '--receipt' ? args[++i] : arg.slice('--receipt='.length)
            let parsed: PeerReplyVia | undefined
            try {
                parsed = parseReplyVia(value)
            } catch (error) {
                throw new PingPeerError('bad_args', (error as Error).message)
            }
            if (!parsed) {
                throw new PingPeerError('bad_args', '--receipt requires hub or caller')
            }
            if (result.receipt !== undefined) {
                throw new PingPeerError('bad_args', '--receipt may only be specified once')
            }
            result.receipt = parsed
            continue
        }
        if (arg === '--delivery-mode' || arg.startsWith('--delivery-mode=')) {
            const value = arg === '--delivery-mode' ? args[++i] : arg.slice('--delivery-mode='.length)
            const parsed = PeerDeliveryModeSchema.safeParse(value)
            if (!parsed.success) {
                throw new PingPeerError('bad_args', '--delivery-mode must be auto, queue or steer')
            }
            if (result.deliveryMode !== undefined) {
                throw new PingPeerError('bad_args', '--delivery-mode may only be specified once')
            }
            result.deliveryMode = parsed.data
            continue
        }
        if (arg === '--message-file') {
            const value = args[++i]
            if (!value) {
                throw new PingPeerError('bad_args', '--message-file requires a path (or - for stdin)')
            }
            result.messageFile = value
            continue
        }
        if (arg.startsWith('--message-file=')) {
            const value = arg.slice('--message-file='.length)
            if (!value) {
                throw new PingPeerError('bad_args', '--message-file requires a path (or - for stdin)')
            }
            result.messageFile = value
            continue
        }
        if (arg === '--wait') {
            const value = args[++i]
            if (!value) {
                throw new PingPeerError('bad_args', '--wait requires seconds')
            }
            result.waitActiveSecs = Number(value)
            continue
        }
        if (arg.startsWith('--wait=')) {
            result.waitActiveSecs = Number(arg.slice('--wait='.length))
            continue
        }
        if (arg.startsWith('-')) {
            throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        }
        if (!result.sessionIdPrefix) {
            result.sessionIdPrefix = arg
            continue
        }
        if (result.message === undefined) {
            result.message = arg
            continue
        }
        throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
    }

    if (result.waitActiveSecs !== undefined && (!Number.isFinite(result.waitActiveSecs) || result.waitActiveSecs <= 0)) {
        throw new PingPeerError('bad_args', '--wait must be a positive number of seconds')
    }

    return result
}

async function readMessage(parsed: ParsedPingPeerArgs): Promise<string> {
    if (parsed.messageFile !== undefined) {
        if (parsed.message !== undefined) {
            throw new PingPeerError('bad_args', 'provide message as an argument or --message-file, not both')
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
        throw new PingPeerError('bad_args', 'HAPI_WAIT_ACTIVE_SECS must be a positive number')
    }
    return value
}

async function handleList(includeInactive: boolean): Promise<void> {
    const maxRows = 30
    const callerSessionId = process.env[HAPI_SESSION_ID_ENV]?.trim() || undefined
    const sessions = await listPeerSessions({
        limit: peerListFetchLimit(maxRows, { excludeCaller: Boolean(callerSessionId) }),
        includeInactive
    })
    const peerCount = sessions.filter((session) => session.id !== callerSessionId).length
    console.log(formatPeerSessionsList(sessions, {
        maxRows,
        hasMore: peerCount > maxRows,
        excludeSessionId: callerSessionId,
        includeInactive
    }))
}

export async function handlePingPeerCommand(args: string[]): Promise<void> {
    const parsed = parsePingPeerArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }

    await initializeToken()

    if (parsed.list) {
        await handleList(parsed.all)
        return
    }

    if (!parsed.sessionIdPrefix) {
        showHelp()
        throw new PingPeerError('bad_args', 'missing session id; usage: hapi ping-peer <session-id> <message>')
    }

    const message = await readMessage(parsed)
    if (!message) {
        throw new PingPeerError(
            'bad_args',
            'missing message; provide as arg, --message-file PATH, or --message-file -'
        )
    }
    assertReceiptFeasible(parsed.receipt)

    const result = await pingPeer({
        sessionIdPrefix: parsed.sessionIdPrefix,
        message,
        deliveryMode: parsed.deliveryMode,
        wake: parsed.wake,
        waitActiveSecs: parsed.waitActiveSecs ?? envWaitActiveSecs(),
        onProgress: (line) => console.log(`hapi ping-peer: ${line}`)
    })

    const receipt = result.delivery === 'accepted'
        ? `accepted for ${result.sessionId} localId=${result.localId} — delivery shows in the recipient chat when its runtime consumes it${result.steerNote ? ` (${result.steerNote})` : ''}`
        : `${result.delivery} to ${result.sessionId} localId=${result.localId}`
    const replyNote = await settleReceipt({
        explicit: parsed.receipt,
        task: result,
        command: 'hapi ping-peer'
    })
    console.log(chalk.green(`hapi ping-peer: OK - ${receipt}${replyNote}`))
}

/**
 * Refuse an explicit `--receipt` before anything is sent when no calling
 * session is known: the reply would have nowhere to go.
 */
export function assertReceiptFeasible(explicit: PeerReplyVia | undefined): void {
    if (explicit && !(process.env[HAPI_SESSION_ID_ENV]?.trim())) {
        throw new PingPeerError(
            'bad_args',
            `--receipt ${explicit} needs the calling session (HAPI_SESSION_ID) to post the reply into; run inside a session`
        )
    }
}

/**
 * Settle where the peer's reply goes (shell path). `--receipt hub` posts it
 * through the hub; `--receipt caller` makes this process wait for the peer's
 * turn (blocking, up to 6h). A bot session (HAPI_BOT_ID) defaults to hub. If
 * the hub cannot register the receipt the command explains instead of
 * blocking — a shell caller cannot keep a watcher alive.
 */
export async function settleReceipt(options: {
    explicit: PeerReplyVia | undefined
    task: { sessionId: string; localId?: string; flavor?: string | null }
    command: string
    /** The bot acting, when the command knows it better than the env (`spawn-peer --bot`). */
    botId?: string
    /** Shared auth so the receipt registration reuses the command's JWT. */
    auth?: BotAuthSource
}): Promise<string> {
    const callerSessionId = process.env[HAPI_SESSION_ID_ENV]?.trim()
    const via = resolveReplyVia({ replyVia: options.explicit, botId: options.botId ?? botIdFromEnv() })
    if (!via) return ''
    const settled = await settlePeerReply({
        via,
        task: options.task,
        callerSessionId,
        onHubFailure: 'report',
        flavorSupported: supportsPeerReply(options.task.flavor),
        forward: async ({ peerSessionId, taskLocalId, callerSessionId: target }) => {
            console.log(`${options.command}: waiting for the peer's turn to end (up to 6h); its reply will be posted into ${target}`)
            await forwardPeerReply({ peerSessionId, taskLocalId, callerSessionId: target })
        },
        registerReceipt: (childSessionId, receipt) => registerReceipt(childSessionId, { ...receipt, auth: options.auth })
    })
    return settled.note
}

export const pingPeerCommand: CommandDefinition = {
    name: 'ping-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handlePingPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError) {
                console.error(chalk.red('hapi ping-peer:'), error.message)
                process.exit(exitCodeForPingPeerError(error))
            }
            console.error(
                chalk.red('hapi ping-peer:'),
                error instanceof Error ? error.message : 'Unknown error'
            )
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

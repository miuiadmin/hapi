import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { answerRequest } from '@/modules/bot/peerAnswer'
import { createBotAuthSource, BotClientError, botErrorMessage, exitCodeForBotClientError, type BotClientOptions } from '@/modules/bot/botClient'
import type { CommandDefinition } from './types'

/**
 * `hapi peer-answer <session> <requestId>` — answer another session's pending
 * request on its behalf: a worker's tool-permission prompt (`--approve` /
 * `--deny`, explicitly) or its structured question (`--option` / `--text` for
 * one question, `--answer <n>=…` for each of several, `--deny` to cancel).
 */

export type ParsedPeerAnswerArgs = {
    help: boolean
    sessionIdPrefix?: string
    requestId?: string
    approve: boolean
    deny: boolean
    options: string[]
    text?: string
    question?: number
    answers: string[]
}

export const PEER_ANSWER_USAGE =
    'usage: hapi peer-answer <sessionIdPrefix> <requestId> (--approve | --deny) | for a question: [--question <n>] [--option <text|n>]… [--text "…"] | [--answer <n>=<text|n>]… | --deny'

function showHelp(): void {
    console.log(`
${chalk.bold('hapi peer-answer')} - Answer another session's pending request

${chalk.bold('Usage:')}
  hapi peer-answer <sessionIdPrefix> <requestId> --approve | --deny          a permission prompt (explicit, nothing else)
  hapi peer-answer <sessionIdPrefix> <requestId> --deny                       cancel a question
  hapi peer-answer <sessionIdPrefix> <requestId> --option <text|n> [--option …] [--text "…"]   one question
  hapi peer-answer <sessionIdPrefix> <requestId> --answer <n>=<text|n> [--answer …]            several questions, one per question

${chalk.bold('Options:')}
  --approve            allow a tool permission, once
  --deny               reject a tool permission / cancel a question
  --option <text|n>    pick an option by its exact text or its 1-based number; repeat for multi-select.
                       It must match exactly one option and is never sent as free text.
  --text "…"           a free-text answer ("Other"); on request_user_input it is sent as the user note
  --question <n>       which question --option / --text answer when there are several (1-based)
  --answer <n>=<text|n>  one answer per question, n from 1; a value that is no option is sent as free text
  --                   everything after it is a positional (for a request id that starts with -)

${chalk.bold('Notes:')}
  Every question must get an answer; a partial set is refused and nothing is sent.
  Find the request with \`hapi inspect-peer <session>\` (pending requests: id, tool) or look for
  rows marked [waiting] in \`hapi ping-peer --list\`. Resolves the session by id prefix.
  Same hub token/namespace as this CLI. Never approve deleting, force-pushing, merging or
  spending on your owner's behalf: deny and put it to them instead.

${chalk.bold('Exit codes:')}
  0 answered · 2 bad arguments or peer tools disabled · 3 auth · 4 no such session / request · 5 refused by the hub · 1 other
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

function parseQuestionNumber(value: string, flag: string): number {
    if (!/^\d+$/.test(value.trim()) || Number(value.trim()) < 1) {
        throw new BotClientError('bad_args', `${flag} takes a question number from 1 (got "${value}")`)
    }
    return Number(value.trim())
}

export function parsePeerAnswerArgs(args: string[]): ParsedPeerAnswerArgs {
    const result: ParsedPeerAnswerArgs = { help: false, options: [], answers: [], approve: false, deny: false }
    const positionals: string[] = []

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--') {
            positionals.push(...args.slice(i + 1))
            break
        }
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--approve') {
            result.approve = true
            continue
        }
        if (arg === '--deny') {
            result.deny = true
            continue
        }
        if (arg === '--option' || arg.startsWith('--option=')) {
            const { value, next } = takeValue(args, i, '--option')
            if (!value.trim()) throw new BotClientError('bad_args', '--option requires an option text or number')
            result.options.push(value)
            i = next - 1
            continue
        }
        if (arg === '--text' || arg.startsWith('--text=')) {
            const { value, next } = takeValue(args, i, '--text')
            if (!value.trim()) throw new BotClientError('bad_args', '--text requires a text')
            result.text = value
            i = next - 1
            continue
        }
        if (arg === '--question' || arg.startsWith('--question=')) {
            const { value, next } = takeValue(args, i, '--question')
            result.question = parseQuestionNumber(value, '--question')
            i = next - 1
            continue
        }
        if (arg === '--answer' || arg.startsWith('--answer=')) {
            const { value, next } = takeValue(args, i, '--answer')
            if (!value.trim()) throw new BotClientError('bad_args', '--answer requires <n>=<option or text>')
            result.answers.push(value)
            i = next - 1
            continue
        }
        if (arg.startsWith('-')) {
            throw new BotClientError('bad_args', `unexpected flag: ${arg}`)
        }
        positionals.push(arg)
    }

    const [session, requestId, ...extra] = positionals
    result.sessionIdPrefix = session
    result.requestId = requestId
    if (extra.length > 0) {
        throw new BotClientError('bad_args', `unexpected arg: ${extra[0]}`)
    }
    if (result.help) return result
    if (!session || !requestId) {
        throw new BotClientError('bad_args', PEER_ANSWER_USAGE)
    }
    if (result.approve && result.deny) {
        throw new BotClientError('bad_args', 'choose --approve or --deny, not both')
    }
    const answers = result.options.length > 0 || result.text !== undefined || result.answers.length > 0
    if (result.approve && answers) {
        throw new BotClientError('bad_args', '--approve is for permission requests; a question is answered with --option / --text / --answer or canceled with --deny')
    }
    if (!result.approve && !result.deny && !answers) {
        throw new BotClientError('bad_args', 'pass --approve or --deny for a permission request; --option / --text / --answer (or --deny) for a question')
    }
    return result
}

/**
 * `--help` prints the help and exits 0; a missing session / request id is a
 * usage slip: print the help, then fail with the usage line. No hub credential needed.
 */
export function handlePeerAnswerHelpOrUsage(args: string[]): 'handled' | 'run' {
    let parsed: ParsedPeerAnswerArgs
    try {
        parsed = parsePeerAnswerArgs(args)
    } catch (error) {
        if (error instanceof BotClientError && error.message === PEER_ANSWER_USAGE) showHelp()
        throw error
    }
    if (parsed.help) {
        showHelp()
        return 'handled'
    }
    return 'run'
}

export async function handlePeerAnswerCommand(args: string[], deps: BotClientOptions = {}): Promise<void> {
    const parsed = parsePeerAnswerArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }
    const result = await answerRequest({
        ...deps,
        auth: deps.auth ?? createBotAuthSource(deps),
        sessionIdPrefix: parsed.sessionIdPrefix!,
        requestId: parsed.requestId!,
        input: {
            approve: parsed.approve,
            deny: parsed.deny,
            options: parsed.options,
            text: parsed.text,
            question: parsed.question,
            answers: parsed.answers
        }
    })
    console.log(chalk.green(`hapi peer-answer: ${result.plan.summary}  (${result.tool} on ${result.sessionId}, request ${result.requestId})`))
}

export const peerAnswerCommand: CommandDefinition = {
    name: 'peer-answer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            if (handlePeerAnswerHelpOrUsage(commandArgs) === 'handled') return
            await initializeToken()
            await handlePeerAnswerCommand(commandArgs)
        } catch (error) {
            if (error instanceof BotClientError) {
                console.error(chalk.red('hapi peer-answer:'), error.message)
                process.exit(exitCodeForBotClientError(error))
            }
            console.error(chalk.red('hapi peer-answer:'), botErrorMessage(error))
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}

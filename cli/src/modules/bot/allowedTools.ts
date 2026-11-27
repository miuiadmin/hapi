/**
 * What a bot's home chat may do without a permission prompt.
 *
 * A bot's job is to operate other sessions and to work through hapi's own
 * command line, so in `default` / `acceptEdits` mode every `hapi item …` or
 * `spawn_peer` would otherwise stall on a prompt nobody answers (its first run
 * stalled on `which hapi; hapi --help`). Two lists, applied once where Claude's
 * launch options are assembled (`runClaude`) so both the local `--allowedTools`
 * flag and the remote SDK `allowedTools` carry them, and in the Codex MCP
 * bridge config. Ordinary sessions are unchanged.
 *
 * The shell list admits only command families in which every flag is harmless:
 * none can read a file, run a command, or deliver anything into a session
 * other than the bot's own home chat and ledger (answering a worker's pending
 * request is the one exception). Hence no `hapi job` (runs arbitrary
 * commands), no `git` ("read-only" subcommands can still read and write
 * files), and no `hapi ping-peer` / `hapi spawn-peer` (`--message-file` reads
 * any file); the structured MCP `ping_peer` / `spawn_peer` are pre-approved
 * instead and the shell forms still work, they just prompt.
 *
 * Wildcard form (`Bash(hapi item:*)`) follows Claude Code's prefix rule and has
 * been exercised on a real runner.
 */

export const BOT_HAPI_CLI_ALLOWED_TOOLS: readonly string[] = [
    'Bash(hapi --help)',
    'Bash(hapi -v)',
    'Bash(hapi --version)',
    'Bash(hapi item:*)',
    'Bash(hapi task:*)',
    'Bash(hapi inspect-peer:*)',
    'Bash(hapi peer-answer:*)'
]

/**
 * The hapi MCP peer tools a bot calls without a prompt (`mcp__hapi__<name>`).
 * `list_peers` is auto-approved for every session already; these three target
 * another session and prompt everyone else.
 */
export const BOT_HAPI_PEER_TOOL_NAMES: readonly string[] = ['spawn_peer', 'ping_peer', 'inspect_peer']

/**
 * `mcp__hapi__*` entries for the peer tools. With `registeredToolNames` (the
 * session's actual MCP catalog) only tools that exist are named, so a
 * session with peer tools disabled advertises nothing stale.
 */
export function botPeerMcpAllowedTools(registeredToolNames?: readonly string[]): string[] {
    const registered = registeredToolNames ? new Set(registeredToolNames) : null
    return BOT_HAPI_PEER_TOOL_NAMES
        .filter((name) => !registered || registered.has(name))
        .map((name) => `mcp__hapi__${name}`)
}

/**
 * The session's allowed tools: `base` plus — for a bot's home chat only — the
 * peer MCP tools and the hapi shell rules. Returns a new array; never
 * mutates `base`.
 */
export function withBotCliAllowedTools(
    base: readonly string[],
    isBot: boolean,
    options: { registeredToolNames?: readonly string[] } = {}
): string[] {
    if (!isBot) return [...base]
    return Array.from(new Set([...base, ...botPeerMcpAllowedTools(options.registeredToolNames), ...BOT_HAPI_CLI_ALLOWED_TOOLS]))
}

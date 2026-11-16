import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Berry plugin row that hosts MCP client servers (enabled.yaml). */
const CORE_MCP_PLUGIN_ID = 'core:mcp'
/** Server key the hapi bridge is seeded under inside config.servers. */
const HAPI_MCP_SERVER_KEY = 'hapi'
/**
 * Per-server tool timeout (seconds). Berry's default (60s) is shorter than
 * an interactive ask-user card can take to answer — the MCP
 * ask_user_question call would time out while the user is still reading
 * the questions. 600s gives the card the same slack the other flavors'
 * bridges effectively allow.
 */
const HAPI_MCP_TOOL_TIMEOUT_SEC = 600

export type BerryMcpSeedServer = {
    command: string
    args: string[]
}

type EnabledYamlPlugin = Record<string, unknown> & {
    id?: unknown
    config?: unknown
}

type EnabledYaml = Record<string, unknown> & {
    plugins?: unknown
}

/** The entry written under config.servers.hapi (fresh copy, own args). */
function hapiServerEntry(server: BerryMcpSeedServer): Record<string, unknown> {
    return {
        command: server.command,
        args: [...server.args],
        tool_timeout_sec: HAPI_MCP_TOOL_TIMEOUT_SEC
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

/**
 * Seed the hapi MCP bridge into berry's plugin face.
 *
 * Berry's ACP face rejects non-empty `mcpServers` on session/new|load
 * (-32602, deliberate v1 boundary), so MCP clients load through the berry
 * plugin face instead: the `core:mcp` row of `enabled.yaml` inside the
 * (per-row isolated) dataDir. Berry reads the file at process start, so
 * this must run BEFORE the ACP child is spawned — and re-runs are cheap:
 * the merge is fully idempotent (same content → no write, formatting
 * untouched), which also keeps it safe against berry's own rewrites of
 * the file (`berry mcp add`): other servers, other plugin rows, and any
 * unknown root keys all survive the upsert.
 */
export function seedBerryHapiMcpBridge(dataDir: string, server: BerryMcpSeedServer): void {
    if (!isAbsolute(server.command)) {
        // berry's config schema requires an absolute command path; a
        // relative one would be silently resolved against berry's cwd.
        throw new Error(`berry MCP seed requires an absolute hapi command (got '${server.command}')`)
    }
    mkdirSync(dataDir, { recursive: true })
    const enabledPath = join(dataDir, 'enabled.yaml')

    let existing: EnabledYaml | null = null
    if (existsSync(enabledPath)) {
        const parsed: unknown = parseYaml(readFileSync(enabledPath, 'utf8'))
        const record = asRecord(parsed)
        if (!record) {
            throw new Error(`berry MCP seed cannot parse ${enabledPath}: not a plugin map`)
        }
        existing = record
    }

    const next: EnabledYaml = { ...existing }
    const plugins = Array.isArray(next.plugins) ? [...(next.plugins as unknown[])] : []
    const rowIndex = plugins.findIndex((row) => asRecord(row)?.id === CORE_MCP_PLUGIN_ID)
    const entry = hapiServerEntry(server)
    if (rowIndex === -1) {
        plugins.push({ id: CORE_MCP_PLUGIN_ID, config: { servers: { [HAPI_MCP_SERVER_KEY]: entry } } })
    } else {
        const row = { ...(asRecord(plugins[rowIndex]) as EnabledYamlPlugin) }
        const config = { ...(asRecord(row.config) ?? {}) }
        const servers = { ...(asRecord(config.servers) ?? {}) }
        servers[HAPI_MCP_SERVER_KEY] = entry
        config.servers = servers
        row.config = config
        plugins[rowIndex] = row
    }
    next.plugins = plugins

    // Same content → no write: keeps berry's own formatting and avoids a
    // pointless rewrite on every launch (the bridge URL changes between
    // launches, so a rewrite only happens when it actually must).
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return
    writeFileSync(enabledPath, stringifyYaml(next))
}

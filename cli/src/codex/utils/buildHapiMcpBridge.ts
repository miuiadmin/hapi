/**
 * Unified MCP bridge setup for Codex local and remote modes.
 *
 * This module provides a single source of truth for starting the hapi MCP
 * bridge server and generating the MCP server configuration that Codex needs.
 */

import { startHappyServer, type HappyAskUserOutcome } from '@/claude/utils/startHappyServer';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import type { ApiSessionClient } from '@/api/apiSession';
import { exportHapiBotEnv, exportHapiSessionEnv } from '@/agent/hapiSessionEnv';
import { BOT_ITEM_TOOL_NAME } from '@/modules/bot/botItemMcp';
import { BOT_TASK_TOOL_NAME } from '@/modules/bot/botTaskMcp';
import { BOT_HAPI_PEER_TOOL_NAMES } from '@/modules/bot/allowedTools';
import { isPeerToolsDisabled } from '@/modules/common/peerTools';
import type { CodexMcpServerConfig } from './codexMcpServers';

/**
 * MCP server entry configuration.
 */
export type McpToolApprovalMode = 'auto' | 'prompt' | 'approve';

export interface McpServerToolConfig {
    approval_mode?: McpToolApprovalMode;
}

export interface McpServerEntry extends CodexMcpServerConfig {
    command: string;
    args: string[];
    tools?: Record<string, McpServerToolConfig>;
}

/**
 * Map of MCP server names to their configurations.
 */
export type McpServersConfig = Record<string, McpServerEntry>;

/**
 * Result of starting the hapi MCP bridge.
 */
export interface HapiMcpBridge {
    /** The running server instance */
    server: {
        url: string;
        stop: () => void;
    };
    /** MCP server config to pass to Codex (works for both CLI and SDK) */
    mcpServers: McpServersConfig;
}

export interface HapiMcpBridgeOptions {
    exportSessionEnv?: boolean;
    emitTitleSummary?: boolean;
    enableChangeTitle?: boolean;
    enableLinkPr?: boolean;
    onChangeTitle?: (title: string) => void;
    /** Session project cwd for relative spawn_peer directories (Codex --cd aware). */
    workingDirectory?: string;
    skillLookup?: {
        workingDirectory: string;
        flavor: string;
    };
    /** Register the MCP ask_user_question tool (DSH: its ACP profile has no
     * native ask-user tool). See StartHappyServerOptions.askUserTool. */
    askUserTool?: {
        escalate: (input: unknown) => Promise<HappyAskUserOutcome>;
    };
}

/**
 * Start the hapi MCP bridge server and return the configuration
 * needed to connect Codex to it.
 *
 * This is the single source of truth for MCP bridge setup,
 * used by both local and remote launchers.
 *
 * Lazy Codex sessions stay pending until first materialization. We materialize
 * here (before startHappyServer / agent spawn) so:
 * - the hub row exists for REST self-targeting via HAPI_SESSION_ID
 * - hapiMcpUrl from startHappyServer is persisted to the hub, not only local pending state
 */
export async function buildHapiMcpBridge(
    client: ApiSessionClient,
    options: HapiMcpBridgeOptions = {}
): Promise<HapiMcpBridge> {
    if (client.isPending()) {
        const materialized = await client.materialize();
        if (!materialized) {
            throw new Error(`Failed to materialize HAPI session ${client.sessionId} before MCP bridge start`);
        }
    }
    // Belt-and-suspenders: onMaterialized already exports; keep env set for non-lazy too.
    if (options.exportSessionEnv !== false) {
        exportHapiSessionEnv(client.sessionId);
        exportHapiBotEnv(client.botId ? { id: client.botId, name: client.getMetadata()?.name } : null);
    }

    const happyServer = await startHappyServer(client, {
        emitTitleSummary: options.emitTitleSummary,
        enableChangeTitle: options.enableChangeTitle,
        skillLookup: options.skillLookup,
        askUserTool: options.askUserTool,        enableLinkPr: options.enableLinkPr,
        onChangeTitle: options.onChangeTitle,
        workingDirectory: options.workingDirectory ?? options.skillLookup?.workingDirectory
    });
    // Stamp the hub row id so orphanReap can find MCP helpers after the agent
    // root dies without a full tree kill (#2003 / #1911 follow-up).
    const bridgeCommand = getHappyCliCommand([
        'mcp',
        '--url',
        happyServer.url,
        '--tools',
        happyServer.toolNames.join(','),
        '--hapi-session-id',
        client.sessionId,
    ]);
    const tools: Record<string, McpServerToolConfig> = {
        display_image: {
            approval_mode: 'prompt'
        },
        display_video: {
            approval_mode: 'prompt'
        },
        display_media: {
            approval_mode: 'prompt'
        }
    };
    if (options.enableChangeTitle !== false) {
        tools.change_title = {
            approval_mode: 'approve'
        };
    }
    // Prompt — not approve: link_pr mutates session metadata. Native
    // pre-approval would bypass BasePermissionHandler's read-only guard.
    if (happyServer.toolNames.includes('link_pr')) {
        tools.link_pr = {
            approval_mode: 'prompt'
        };
    }

    // Discovery shortlist only - same trust as skill_lookup / change_title.
    // Skipped when this session's peer tools are disabled (create-time
    // snapshot first: later bootstraps in the same process must not flip an
    // already-built bridge).
    if (!(client.peerToolsDisabled ?? isPeerToolsDisabled())) {
        tools.list_peers = {
            approval_mode: 'approve'
        };
    }
    // Own-session progress meter (tiann/hapi#1404) — hub REST, not peer inject.
    tools.session_job = {
        approval_mode: 'approve'
    };
    // A bot's ledger and schedules (registered only for a bot home chat) —
    // hub REST on the bot's own records, same trust as session_job.
    for (const name of [BOT_ITEM_TOOL_NAME, BOT_TASK_TOOL_NAME] as const) {
        if (happyServer.toolNames.includes(name)) {
            tools[name] = {
                approval_mode: 'approve'
            };
        }
    }
    // A bot's home chat operates other sessions, so for it the peer tools are
    // as trusted as list_peers. Same list and same registered-only rule as
    // the Claude launch options (`withBotCliAllowedTools`).
    if (client.botId) {
        for (const name of BOT_HAPI_PEER_TOOL_NAMES) {
            if ((happyServer.toolNames as readonly string[]).includes(name)) {
                tools[name] = {
                    approval_mode: 'approve'
                };
            }
        }
    }
    // For everyone else ping_peer / inspect_peer / spawn_peer are registered
    // on the HTTP MCP server / stdio bridge, but are not auto-approved: they
    // target another session (resume + inject, read peer histories, or create
    // + inject).
    if (options.skillLookup) {
        tools.skill_lookup = {
            approval_mode: 'approve'
        };
    }

    return {
        server: {
            url: happyServer.url,
            stop: happyServer.stop
        },
        mcpServers: {
            hapi: {
                command: bridgeCommand.command,
                args: bridgeCommand.args,
                tools
            }
        }
    };
}

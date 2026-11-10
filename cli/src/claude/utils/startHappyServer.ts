/**
 * HAPI MCP server
 * Provides HAPI CLI specific tools including chat session title management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import {
    detectDisplayMediaMimeType,
    detectImageMimeType,
    detectVideoMimeType,
    readBoundedRegularFile,
    registerGeneratedImage,
} from "@/modules/common/generatedImages";
import type { InlineMediaSource } from "@/modules/common/inlineMediaSource";
import { DISPLAY_IMAGE_PROMPT_CURSOR, DISPLAY_MEDIA_PROMPT_CURSOR, DISPLAY_VIDEO_PROMPT_CURSOR } from "@/modules/common/displayImagePrompt";
import { resolveSkill } from "@/modules/common/skills";
import { isAutoTitlePerTurnEnabled } from "@/modules/common/titleInstruction";
import { isPeerToolsDisabled } from "@/modules/common/peerTools";
import {
    INSPECT_PEER_TOOL_DESCRIPTION,
    PING_PEER_TOOL_DESCRIPTION,
    SESSION_ID_PREFIX_PARAM_DESCRIPTION,
} from '@hapi/protocol/sessionCitation'
import { PingPeerError, formatInspectPeerReport, formatPeerSessionsList, inspectPeer, listPeerSessions, peerListFetchLimit, pingPeer } from "@/modules/pingPeer/pingPeer";
import { applySessionDisplayRename, normalizeSessionDisplayTitle } from "@/agent/sessionDisplayRename";

type AskUserQuestionOption = {
    label: string;
    description?: string;
};

type AskUserQuestionInput = {
    questions: Array<{
        id?: string;
        question: string;
        header?: string;
        options?: AskUserQuestionOption[];
        multi_select?: boolean;
    }>;
};

/**
 * Outcome the MCP `ask_user_question` tool handler resolves with; mirrors
 * `AcpAskUserOutcome` without importing from the permission module (the
 * claude-side MCP server stays flavor-agnostic — callers translate).
 */
export type HappyAskUserOutcome =
    | { status: 'answered'; answers: Array<{ id: string; selected: string[]; custom?: string }> }
    | { status: 'denied' | 'canceled'; reason?: string };

type StartHappyServerOptions = {
    /**
     * When true (default), change_title writes metadata.name (web rename
     * semantics). Set false for Codex collab so child agents do not rename
     * the parent HAPI session; the parent launcher applies the title later.
     */
    emitTitleSummary?: boolean;
    enableChangeTitle?: boolean;
    skillLookup?: {
        workingDirectory: string;
        flavor: string;
    };
    /**
     * Register the MCP `ask_user_question` tool for agents whose own flavor
     * has no native ask-user tool over the wire (DSH's automation-only ACP
     * profile omits it). The escalate callback surfaces the questions to the
     * HAPI client as an interactive AskUserQuestion permission card and
     * resolves with the user's answer batch. The result text follows DSH's
     * native tool contract ({"answers":[{id,selected,custom?}]}; empty
     * selected without custom = skipped) so model behavior is identical to
     * flavors that ship the tool natively.
     */
    askUserTool?: {
        escalate: (input: AskUserQuestionInput) => Promise<HappyAskUserOutcome>;
    };
};

/** Registered on the MCP server, but never pre-approved via Claude --allowedTools. */
const CLAUDE_MANUAL_APPROVAL_HAPI_TOOLS = new Set([
    'display_media',
    'display_video',
    'ping_peer',
    'inspect_peer'
]);

/**
 * Map HAPI MCP tool names to Claude `--allowedTools` entries.
 * Keeps `display_media` / `display_video` (arbitrary local-path readers), `ping_peer`, and
 * `inspect_peer` off the auto-allow list so they still prompt.
 * `list_peers` stays allowed (discovery shortlist only).
 */
export function toClaudeAllowedHapiMcpTools(toolNames: string[]): string[] {
    return toolNames
        .filter((toolName) => !CLAUDE_MANUAL_APPROVAL_HAPI_TOOLS.has(toolName))
        .map((toolName) => `mcp__hapi__${toolName}`);
}

/**
 * Race an ask_user escalation against the MCP request's cancellation signal
 * (dsh sends notifications/cancelled when its 60s per-call timeout fires).
 * On abort the tool resolves with skip semantics immediately instead of
 * hanging until turn end; the underlying escalation promise is left to be
 * superseded by the model's retry or canceled at 'Prompt finished'.
 */
export function raceAskUserEscalation<T extends { status: string }>(
    escalate: Promise<T>,
    signal: AbortSignal | undefined
): Promise<T | { status: 'canceled'; reason: string }> {
    if (!signal) return escalate;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: T | { status: 'canceled'; reason: string }) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => {
            finish({ status: 'canceled', reason: 'the question was cancelled (agent timeout or retry)' });
        };
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        escalate.then(finish, (error) => {
            finish({ status: 'canceled', reason: error instanceof Error ? error.message : String(error) } as { status: 'canceled'; reason: string });
        });
    });
}

function createHapiMcpServer(
    client: ApiSessionClient,
    emitTitleSummary: boolean,
    enableChangeTitle: boolean,
    skillLookup: StartHappyServerOptions['skillLookup'],
    askUserTool: StartHappyServerOptions['askUserTool']
): McpServer {
    const handler = async (title: string) => {
        logger.debug('[hapiMCP] Changing title to:', title);
        try {
            if (!normalizeSessionDisplayTitle(title)) return { success: false, error: 'Title must not be empty' };
            if (!await client.refreshMetadata()) {
                return { success: false, error: 'Could not read the current title lock from the Hub.' };
            }
            if (client.getMetadata()?.titleLocked) {
                return { success: false, error: 'Session title is locked by the user. Only the user can unlock it.' };
            }
            if (!emitTitleSummary) {
                // Codex collab: acknowledge the tool call without writing.
                // Parent-thread mcp_tool_call_end applies the rename later.
                return { success: true };
            }
            if (!applySessionDisplayRename(client, title)) {
                return { success: false, error: 'Title must not be empty' };
            }
            if (!await client.flushMetadata()) {
                return { success: false, error: 'Title update could not be confirmed by the Hub.' };
            }
            // The user may lock the title while this write is in flight.
            // The ACK carries the Hub's preserved title and lock.
            if (client.getMetadata()?.titleLocked) {
                return { success: false, error: 'Session title is locked by the user. Only the user can unlock it.' };
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    const mcp = new McpServer({
        name: "HAPI MCP",
        version: "1.0.0",
    });

    const changeTitleInputSchema: z.ZodTypeAny = z.object({
        title: z.string().describe('The new title for the chat session'),
    });

    const displayImageInputSchema: z.ZodTypeAny = z.object({
        path: z.string().describe('Absolute filesystem path of the local image to display to the human user. This file is sent for user display, not provided to the model for image inspection'),
        title: z.string().optional().describe('Optional display title or filename shown to the human user'),
    });

    const skillLookupInputSchema: z.ZodTypeAny = z.object({
        name: z.string().trim().min(1).max(128).describe('Exact skill name shown by HAPI skill autocomplete'),
    });

    const displayVideoInputSchema: z.ZodTypeAny = z.object({
        path: z.string().describe('Local filesystem path of the video to display inline (mp4 or webm)'),
        title: z.string().optional().describe('Optional display title or filename for the video'),
    });

    const displayMediaInputSchema: z.ZodTypeAny = z.object({
        path: z.string().describe('Local filesystem path of the media or file to send to the user'),
        title: z.string().trim().min(1).max(255).optional().describe('Optional display title or filename'),
    });

    const pingPeerInputSchema: z.ZodTypeAny = z.object({
        sessionIdPrefix: z.string().trim().min(1).describe(SESSION_ID_PREFIX_PARAM_DESCRIPTION),
        message: z.string().min(1).describe('Message text to deliver to the target session'),
    });

    const maxInlineMediaBytes = 25 * 1024 * 1024;

    // HAPI_DISABLE_PEER_TOOLS=1 (or the hub toggle): peer tools are neither
    // registered nor advertised, so wrapped agents cannot browse or message
    // other sessions. Prefer this session's create-time snapshot over the
    // module-wide preference: one runner process hosts many sessions, and a
    // later bootstrap must not flip an already-running session (new-session-only).
    const peerToolsDisabled = client.peerToolsDisabled ?? isPeerToolsDisabled();

    const inspectPeerInputSchema: z.ZodTypeAny = z.object({
        sessionIdPrefix: z.string().trim().min(1).describe(SESSION_ID_PREFIX_PARAM_DESCRIPTION),
        messageLimit: z.number().int().min(1).max(100).optional().describe(
            'Recent message page size (default 30, max 100). Text snippets only.'
        ),
    });

    const listPeersInputSchema: z.ZodTypeAny = z.object({
        limit: z.number().int().min(1).max(100).optional().describe(
            'Max sessions to return (default 30, max 100). Newest updatedAt first.'
        ),
    });

    async function displayInlineMedia(
        args: { path: string; title?: string },
        mediaKind: 'image' | 'video' | 'media',
        toolName: 'display_image' | 'display_video' | 'display_media'
    ) {
        const bytes = await readBoundedRegularFile(args.path, maxInlineMediaBytes);
        const mimeType = mediaKind === 'video'
            ? detectVideoMimeType(bytes)
            : mediaKind === 'image'
                ? detectImageMimeType(bytes)
                : detectDisplayMediaMimeType(bytes);
        if (!mimeType) {
            throw new Error(mediaKind === 'video' ? 'Unsupported video content' : 'Unsupported image content');
        }

        const media = registerGeneratedImage({
            id: randomUUID(),
            path: args.path,
            fileName: args.title,
            mimeType,
            bytes
        });

        const source: InlineMediaSource = {
            ingress: 'mcp',
            toolName,
        };

        client.sendAgentMessage({
            type: 'generated-image',
            imageId: media.id,
            fileName: media.fileName,
            mimeType: media.mimeType,
            id: randomUUID(),
            source,
        });

        return media;
    }
    if (enableChangeTitle) {
        mcp.registerTool<any, any>('change_title', {
            description: isAutoTitlePerTurnEnabled()
                ? 'Change the title of the current HAPI chat session. Per-turn mode is enabled: call this at the end of every user turn with a concise task title (eight words or fewer, in the conversation\'s language) reflecting the current focus, rewriting the title even when the focus has shifted only slightly.'
                : 'Change the title of the current HAPI chat session. Call once when the user\'s primary objective is clear; use a concise task title.',
            title: 'Change Chat Title',
            inputSchema: changeTitleInputSchema,
        }, async (args: { title: string }) => {
            const response = await handler(args.title);
            logger.debug('[hapiMCP] Response:', response);
            const displayTitle = normalizeSessionDisplayTitle(args.title) ?? args.title;

            if (response.success) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Successfully changed chat title to: "${displayTitle}"`,
                        },
                    ],
                    isError: false,
                };
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        });
    }

    mcp.registerTool<any, any>('display_image', {
        description: `Display a local image file to the human user inline in the current HAPI chat session. ${DISPLAY_IMAGE_PROMPT_CURSOR}`,
        title: 'Display Image',
        inputSchema: displayImageInputSchema,
    }, async (args: { path: string; title?: string }) => {
        logger.debug('[hapiMCP] Display image:', args.path);

        try {
            const image = await displayInlineMedia(args, 'image', 'display_image');

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Displayed image: ${image.fileName}`,
                    },
                ],
                isError: false,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to display image:', message);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to display image: ${message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool<any, any>('display_video', {
        description: `Display a local mp4 or webm file inline in the current HAPI chat session. ${DISPLAY_VIDEO_PROMPT_CURSOR}`,
        title: 'Display Video',
        inputSchema: displayVideoInputSchema,
    }, async (args: { path: string; title?: string }) => {
        logger.debug('[hapiMCP] Display video:', args.path);

        try {
            const video = await displayInlineMedia(args, 'video', 'display_video');

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Displayed video: ${video.fileName}`,
                    },
                ],
                isError: false,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to display video:', message);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to display video: ${message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool<any, any>('display_media', {
        description: `Send a local image, video, audio, or other file to the current HAPI chat session. Recognized media is shown inline; other files use a download card. ${DISPLAY_MEDIA_PROMPT_CURSOR}`,
        title: 'Display Media',
        inputSchema: displayMediaInputSchema,
    }, async (args: { path: string; title?: string }) => {
        logger.debug('[hapiMCP] Display media:', args.path);

        try {
            const media = await displayInlineMedia(args, 'media', 'display_media');
            return {
                content: [{ type: 'text' as const, text: `Displayed media: ${media.fileName}` }],
                isError: false,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to display media:', message);
            return {
                content: [{ type: 'text' as const, text: `Failed to display media: ${message}` }],
                isError: true,
            };
        }
    });

    if (!peerToolsDisabled) {
        mcp.registerTool<any, any>('ping_peer', {
            description: PING_PEER_TOOL_DESCRIPTION,
            title: 'Ping Peer Session',
            inputSchema: pingPeerInputSchema,
        }, async (args: { sessionIdPrefix: string; message: string }) => {
            logger.debug('[hapiMCP] ping_peer:', args.sessionIdPrefix);
            try {
                const result = await pingPeer({
                    sessionIdPrefix: args.sessionIdPrefix,
                    message: args.message,
                    peerToolsDisabled,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Accepted for ${result.sessionId}${result.resumed ? ' (resumed)' : ''} (${result.name}) localId=${result.localId} — delivery shows in the recipient chat when its runtime consumes it`,
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof PingPeerError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : String(error);
                logger.debug('[hapiMCP] ping_peer failed:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to ping peer: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });

        mcp.registerTool<any, any>('inspect_peer', {
            description: INSPECT_PEER_TOOL_DESCRIPTION,
            title: 'Inspect Peer Session',
            inputSchema: inspectPeerInputSchema,
        }, async (args: { sessionIdPrefix: string; messageLimit?: number }) => {
            logger.debug('[hapiMCP] inspect_peer:', args.sessionIdPrefix);
            try {
                const result = await inspectPeer({
                    sessionIdPrefix: args.sessionIdPrefix,
                    messageLimit: args.messageLimit,
                    peerToolsDisabled,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: formatInspectPeerReport(result),
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof PingPeerError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : String(error);
                logger.debug('[hapiMCP] inspect_peer failed:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to inspect peer: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });

        mcp.registerTool<any, any>('list_peers', {
            description: 'List peer HAPI sessions on the same hub/namespace (id prefix, active, flavor, name). Uses this session\'s hub credentials - works from runner-spawned agents without being on the hub host. Prefer this over shelling `hapi ping-peer --list`. Then call inspect_peer / ping_peer with a listed id.',
            title: 'List Peer Sessions',
            inputSchema: listPeersInputSchema,
        }, async (args: { limit?: number }) => {
            logger.debug('[hapiMCP] list_peers');
            try {
                const limit = args.limit ?? 30;
                const sessions = await listPeerSessions({
                    limit: peerListFetchLimit(limit, { excludeCaller: true }),
                    peerToolsDisabled,
                });
                const peers = sessions.filter((session) => session.id !== client.sessionId);
                const hasMore = peers.length > limit;
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: formatPeerSessionsList(peers, {
                                maxRows: limit,
                                hasMore,
                            }),
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof PingPeerError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : String(error);
                logger.debug('[hapiMCP] list_peers failed:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to list peers: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });
    }


    if (skillLookup) {
        mcp.registerTool<any, any>('skill_lookup', {
            description: 'Load a HAPI skill by exact name. When a user message starts with $name, call this tool with that name before acting.',
            title: 'Look Up Skill',
            inputSchema: skillLookupInputSchema,
        }, async (args: { name: string }) => {
            logger.debug('[hapiMCP] Looking up skill:', args.name);
            try {
                const skill = await resolveSkill(args.name, skillLookup.workingDirectory, {
                    flavor: skillLookup.flavor
                });
                if (!skill) {
                    throw new Error(`Skill not found: ${args.name}`);
                }

                const header = [
                    `Skill: ${skill.name}`,
                    ...(skill.description ? [`Description: ${skill.description}`] : [])
                ].join('\n');
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `${header}\n\n${skill.body}`,
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.debug('[hapiMCP] Failed to look up skill:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to look up skill: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });
    }

    if (askUserTool) {
        const askUserInputSchema: z.ZodTypeAny = z.object({
            questions: z.array(z.object({
                id: z.string().min(1).max(64).describe('Stable id for this question; echoed in the answer'),
                question: z.string().min(1).describe('The specific question to ask the user'),
                header: z.string().min(1).max(64).optional().describe('Optional short heading, such as "Confirm" or "Choose Mode"'),
                options: z.array(z.object({
                    label: z.string().min(1).describe('Short user-facing option label'),
                    description: z.string().optional().describe('One sentence explaining the tradeoff or impact'),
                })).optional().describe('Optional choices; put the recommended one first and append "(Recommended)"'),
                multi_select: z.boolean().optional().describe('Whether more than one option may be selected; defaults to false'),
            })).min(1).max(8).describe('Questions to ask the user before continuing'),
        });

        mcp.registerTool<any, any>('ask_user_question', {
            description: 'Ask brief, direct, self-contained questions about missing information, preferences, or decisions when you need a human answer before proceeding. Use user-facing terms; assume no knowledge of background work or internal names. The user answers through the HAPI chat UI (interactive option cards) and may take a while; if this call is cancelled (e.g. a 60s agent-side timeout) the questions may be re-asked. The result is an answer batch with one item per question id; an item with empty selected and no custom means the user skipped that question: continue without it, do not ask it again, and do not treat the skip as permission.',
            title: 'Ask User Question',
            inputSchema: askUserInputSchema,
        }, async (args: AskUserQuestionInput, extra: { signal?: AbortSignal }) => {
            logger.debug('[hapiMCP] ask_user_question:', JSON.stringify(args.questions?.length ?? 0), 'question(s)');
            try {
                // DSH enforces a 60s per-call MCP timeout it cannot raise
                // (verified: the ACP mcpServers wire schema strips any
                // timeout override). When the timeout fires the client sends
                // notifications/cancelled and extra.signal aborts. Without
                // this race the escalation — and its interactive card — hang
                // until the turn ends while the model retries with a SECOND
                // card, stacking dialogs the user already started filling.
                // On cancel, return skip semantics immediately so the retry
                // cycle stays clean; the pending card is superseded by the
                // retry's escalation (AcpPermissionHandler.askUser) or
                // canceled at turn end.
                const outcome = await raceAskUserEscalation(askUserTool.escalate(args), extra?.signal);
                if (outcome.status === 'answered') {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify({ answers: outcome.answers }),
                            },
                        ],
                        isError: false,
                    };
                }
                // Denied / canceled map onto DSH's skip semantics, not an
                // error: the model is instructed to continue without
                // re-asking and never to treat the skip as permission.
                const detail = outcome.reason ? ` (${outcome.reason})` : '';
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `User did not answer${detail}. Treat every question as skipped: continue useful work without asking again, and do not treat the skip as permission.`,
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.debug('[hapiMCP] ask_user_question failed:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to surface the questions: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });
    }

    return mcp;
}

function readMcpSessionId(req: IncomingMessage): string | undefined {
    const raw = req.headers['mcp-session-id'];
    if (typeof raw === 'string') {
        return raw;
    }
    if (Array.isArray(raw)) {
        return raw[0];
    }
    return undefined;
}

export async function startHappyServer(client: ApiSessionClient, options: StartHappyServerOptions = {}) {
    const emitTitleSummary = options.emitTitleSummary ?? true;
    const enableChangeTitle = options.enableChangeTitle ?? true;
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const mcps = new Map<string, McpServer>();

    const createMcpTransport = () => {
        const mcp = createHapiMcpServer(client, emitTitleSummary, enableChangeTitle, options.skillLookup, options.askUserTool);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                transports.set(sessionId, transport);
                mcps.set(sessionId, mcp);
            },
            onsessionclosed: (sessionId) => {
                transports.delete(sessionId);
                const server = mcps.get(sessionId);
                mcps.delete(sessionId);
                void server?.close();
            },
        });
        void mcp.connect(transport);
        return transport;
    };

    const server = createServer(async (req, res) => {
        try {
            const sessionId = readMcpSessionId(req);
            const transport = sessionId
                ? transports.get(sessionId)
                : createMcpTransport();

            if (!transport) {
                if (!res.headersSent) {
                    res.writeHead(404).end();
                }
                return;
            }

            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    const mcpUrl = baseUrl.toString();
    client.updateMetadata((metadata) => ({
        ...metadata,
        hapiMcpUrl: mcpUrl,
    }));

    const peerToolsDisabled = client.peerToolsDisabled ?? isPeerToolsDisabled();
    const toolNames = [
        ...(enableChangeTitle ? ['change_title'] : []),
        'display_image',
        'display_video',
        'display_media',
        ...(peerToolsDisabled ? [] : (['list_peers', 'ping_peer', 'inspect_peer'] as const)),
    ];
    if (options.skillLookup) {
        toolNames.push('skill_lookup');
    }
    if (options.askUserTool) {
        toolNames.push('ask_user_question');
    }

    return {
        url: mcpUrl,
        toolNames,
        stop: () => {
            logger.debug('[hapiMCP] Stopping server');
            for (const mcp of mcps.values()) {
                mcp.close();
            }
            transports.clear();
            mcps.clear();
            server.close();
        }
    };
}

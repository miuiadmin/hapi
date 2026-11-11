export const ACP_SESSION_UPDATE_TYPES = {
    agentMessageChunk: 'agent_message_chunk',
    agentThoughtChunk: 'agent_thought_chunk',
    toolCall: 'tool_call',
    toolCallUpdate: 'tool_call_update',
    plan: 'plan',
    usageUpdate: 'usage_update',
    sessionInfoUpdate: 'session_info_update',
    /** dsh 0.2.x pushes a refreshed configOptions catalog mid-session
     * (e.g. after llm/adapters-updated); captured like an RPC echo. */
    configOptionUpdate: 'config_option_update',
    /** ACP CurrentModeUpdate: the agent's current mode id. Hermes emits it
     * on resume/set_mode echoes and on FOREIGN edit-policy changes made
     * from another client surface (gateway pumps it from session.info). */
    currentModeUpdate: 'current_mode_update'
} as const;

/** OpenCode v2 client capability (`_meta` key) that enables child session updates. */
export const OPENCODE_CHILD_SESSION_UPDATES = 'opencode/child-session-updates';
/** OpenCode v2 extension notification carrying a child (subagent) session's update. */
export const OPENCODE_CHILD_UPDATE_METHOD = 'opencode/session/child_update';

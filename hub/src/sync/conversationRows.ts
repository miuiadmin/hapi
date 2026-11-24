import type { DecryptedMessage } from '@hapi/protocol'

/**
 * Which rows of a message page carry conversation rather than tool activity.
 *
 * The web collapses a tail of pure tool calls into one card and shows nothing
 * else, so a cold open whose newest rows are all tool activity needs the page
 * extended backwards before the first paint. Deciding that server-side saves the
 * client a serial round trip — but only if this predicate never calls a row
 * conversation when the web would fold it into the tool card (the client keeps
 * its own guard and falls back to the extra request, so the opposite mistake
 * merely costs the old behaviour).
 *
 * Deliberately narrow: only shapes this predicate is certain about count as
 * tool activity. Anything else (codex runs, events, unknown flavours' rows) is
 * treated as conversation.
 */
export function isConversationRow(message: Pick<DecryptedMessage, 'content'>): boolean {
    const content = message.content
    if (!content || typeof content !== 'object' || Array.isArray(content)) return true
    const outer = content as { role?: unknown; content?: unknown }
    if (outer.role === 'user') return true
    if (outer.role !== 'agent') return true
    const inner = outer.content
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return true
    if ((inner as { type?: unknown }).type !== 'output') return true

    const data = (inner as { data?: unknown }).data
    const messageBlocks = (data as { message?: { content?: unknown } } | null)?.message?.content
    if (!Array.isArray(messageBlocks) || messageBlocks.length === 0) {
        // Claude Code's own bookkeeping rows (init, compaction summaries): they
        // render as neither conversation nor a tool card.
        return false
    }
    return !messageBlocks.every((block) => (
        block
        && typeof block === 'object'
        && ((block as { type?: unknown }).type === 'tool_use' || (block as { type?: unknown }).type === 'tool_result')
    ))
}

export function countConversationRows(messages: ReadonlyArray<Pick<DecryptedMessage, 'content'>>): number {
    let count = 0
    for (const message of messages) {
        if (isConversationRow(message)) count += 1
    }
    return count
}

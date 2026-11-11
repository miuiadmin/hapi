package app.hapi.protocol.chat

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Normalized tool classification (port of the web `toolGroups.ts` name
 * tables): identifiers are matched lowercased with separators stripped, so
 * DSH's raw lowercase snake tool names (`bash`, `apply_patch`, `todo_write`)
 * classify into the same buckets as the exact-case spellings.
 */
class ToolGroupClassificationTest {
    private fun tool(name: String, nativeKind: String? = null) = ToolCallBlock(
        id = name,
        localId = null,
        createdAt = 0,
        invokedAt = null,
        durationMs = null,
        usage = null,
        model = null,
        roundSummary = null,
        tool = ChatToolCall(
            id = name,
            name = name,
            state = "completed",
            input = null,
            createdAt = 0,
            description = null,
            nativeKind = nativeKind,
        ),
        children = emptyList(),
        meta = null,
    )

    @Test fun `dsh tool names classify through normalization`() {
        assertEquals(ToolGroupActionKind.COMMAND, getToolGroupActionKind(tool("bash")))
        assertEquals(ToolGroupActionKind.READ, getToolGroupActionKind(tool("read")))
        assertEquals(ToolGroupActionKind.SEARCH, getToolGroupActionKind(tool("grep")))
        assertEquals(ToolGroupActionKind.SEARCH, getToolGroupActionKind(tool("glob")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("edit")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("write")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("apply_patch")))
        assertEquals(ToolGroupActionKind.WEB, getToolGroupActionKind(tool("web_fetch")))
        assertEquals(ToolGroupActionKind.WEB, getToolGroupActionKind(tool("web_search")))
        // Berry's `find` carries kind 'other', so only the name fallback
        // bucket can classify it (the native-kind set already knows `find`).
        assertEquals(ToolGroupActionKind.SEARCH, getToolGroupActionKind(tool("find")))
        assertEquals(ToolGroupActionKind.SEARCH, getToolGroupActionKind(tool("find", nativeKind = "other")))
        assertEquals(ToolGroupActionKind.SEARCH, getToolGroupActionKind(tool("Find", nativeKind = "other")))
        // Not in any web table — stays OTHER (web parity).
        assertEquals(ToolGroupActionKind.OTHER, getToolGroupActionKind(tool("read_image")))
    }

    @Test fun `hermes tool names classify through normalization`() {
        // Hermes builtins carry kind 'other' with bare lowercase names (the
        // "<name>: <preview>" title is stripped at derivation); the name
        // fallback buckets classify them like the dsh set above.
        assertEquals(ToolGroupActionKind.COMMAND, getToolGroupActionKind(tool("terminal", nativeKind = "other")))
        assertEquals(ToolGroupActionKind.READ, getToolGroupActionKind(tool("read_file", nativeKind = "other")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("write_file", nativeKind = "other")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("patch", nativeKind = "other")))
        assertEquals(ToolGroupActionKind.SEARCH, getToolGroupActionKind(tool("search_files", nativeKind = "other")))
        assertEquals(ToolGroupActionKind.WEB, getToolGroupActionKind(tool("web_search", nativeKind = "other")))
        assertEquals(ToolGroupActionKind.WEB, getToolGroupActionKind(tool("web_extract", nativeKind = "other")))
    }

    @Test fun `exact case names keep their buckets`() {
        assertEquals(ToolGroupActionKind.READ, getToolGroupActionKind(tool("Read")))
        assertEquals(ToolGroupActionKind.READ, getToolGroupActionKind(tool("NotebookRead")))
        assertEquals(ToolGroupActionKind.SEARCH, getToolGroupActionKind(tool("Grep")))
        assertEquals(ToolGroupActionKind.SEARCH, getToolGroupActionKind(tool("Glob")))
        assertEquals(ToolGroupActionKind.SEARCH, getToolGroupActionKind(tool("LS")))
        assertEquals(ToolGroupActionKind.COMMAND, getToolGroupActionKind(tool("Bash")))
        assertEquals(ToolGroupActionKind.COMMAND, getToolGroupActionKind(tool("CodexBash")))
        assertEquals(ToolGroupActionKind.COMMAND, getToolGroupActionKind(tool("shell_command")))
        assertEquals(ToolGroupActionKind.COMMAND, getToolGroupActionKind(tool("run_shell_command")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("Edit")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("MultiEdit")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("Write")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("NotebookEdit")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("CodexPatch")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("CodexDiff")))
        assertEquals(ToolGroupActionKind.WEB, getToolGroupActionKind(tool("WebFetch")))
        assertEquals(ToolGroupActionKind.WEB, getToolGroupActionKind(tool("WebSearch")))
    }

    @Test fun `native kind takes precedence over the name`() {
        assertEquals(ToolGroupActionKind.READ, getToolGroupActionKind(tool("bash", nativeKind = "read")))
        assertEquals(ToolGroupActionKind.COMMAND, getToolGroupActionKind(tool("Read", nativeKind = "shell")))
        assertEquals(ToolGroupActionKind.WEB, getToolGroupActionKind(tool("unknown-tool", nativeKind = "webfetch")))
        assertEquals(ToolGroupActionKind.COMMAND, getToolGroupActionKind(tool("unknown-tool", nativeKind = "execute")))
        assertEquals(ToolGroupActionKind.MUTATION, getToolGroupActionKind(tool("unknown-tool", nativeKind = "replace")))
        // DSH tool calls always carry kind `other` — not in any native set,
        // so classification falls through to the name tables.
        assertEquals(ToolGroupActionKind.COMMAND, getToolGroupActionKind(tool("bash", nativeKind = "other")))
        assertEquals(ToolGroupActionKind.READ, getToolGroupActionKind(tool("read", nativeKind = "other")))
    }

    @Test fun `plan and milestone tools stay out of groups`() {
        assertFalse(isEligibleForToolGrouping(tool("todo_write")))
        assertFalse(isEligibleForToolGrouping(tool("TodoWrite")))
        assertFalse(isEligibleForToolGrouping(tool("todo_list")))
        assertFalse(isEligibleForToolGrouping(tool("update_plan")))
        assertFalse(isEligibleForToolGrouping(tool("updatePlan")))
        assertFalse(isEligibleForToolGrouping(tool("ExitPlanMode")))
        assertFalse(isEligibleForToolGrouping(tool("CodexReasoning")))
        assertFalse(isEligibleForToolGrouping(tool("Task")))
        assertFalse(isEligibleForToolGrouping(tool("spawn_agent")))
        assertFalse(isEligibleForToolGrouping(tool("AgyTaskLog")))
        // Newly ported milestone rows (web has them; the exact-case table did not).
        assertFalse(isEligibleForToolGrouping(tool("agy_async_task")))
        assertFalse(isEligibleForToolGrouping(tool("agy_error")))
    }

    @Test fun `ask user question names include dsh mcp bridge alias`() {
        assertTrue(isAskUserQuestionToolName("mcp__hapi__ask_user_question"))
        assertFalse(isAskUserQuestionToolName("mcp__hapi__ask_user_questio"))
        assertFalse(isAskUserQuestionToolName("other__ask_user_question"))
        // Interactive question cards never fold into tool groups (web
        // toolGroups.test.ts `excludes interactive, subagent, and plan cards`).
        assertFalse(isEligibleForToolGrouping(tool("AskUserQuestion")))
        assertFalse(isEligibleForToolGrouping(tool("mcp__hapi__ask_user_question")))
    }

    @Test fun `ordinary tools remain eligible`() {
        assertTrue(isEligibleForToolGrouping(tool("bash")))
        assertTrue(isEligibleForToolGrouping(tool("read")))
        assertTrue(isEligibleForToolGrouping(tool("find")))
        assertTrue(isEligibleForToolGrouping(tool("apply_patch")))
        assertTrue(isEligibleForToolGrouping(tool("WebFetch")))
    }
}

package app.hapi.companion.feature.chat.blocks

import app.hapi.companion.feature.chat.PermissionAction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * [PermissionActionOptions] flavor matrix — the UI projection of the
 * permission gates, pinned against web `PermissionFooter.tsx`
 * (`isCodexSession`/`isDshSession`/`isClaudeSession` + tool-name gates).
 */
class PermissionActionOptionsTest {
    private fun options(flavor: String?, tool: String) = PermissionActionOptions.from(flavor, tool)

    @Test fun `flavor and tool gates keep their existing semantics`() {
        val rows = listOf(
            Row("claude", "Bash", PermissionAction.Deny, true, false),
            Row("claude", "Edit", PermissionAction.Deny, false, true),
            Row("claude", "ExitPlanMode", PermissionAction.Deny, false, false),
            Row("codex", "exec_command", PermissionAction.Abort, true, false),
            Row("codex", "Edit", PermissionAction.Abort, true, false),
            Row("cursor", "CursorBash", PermissionAction.Abort, true, false),
            Row("gemini", "GeminiBash", PermissionAction.Abort, true, false),
            Row("hermes", "Bash", PermissionAction.Deny, true, false),
            Row(null, "CodexPermission", PermissionAction.Abort, true, false),
        )
        for (row in rows) {
            val options = options(row.flavor, row.tool)
            assertEquals(row.deny, options.denyAction, "${row.flavor}, ${row.tool}")
            assertEquals(row.session, options.canAllowForSession, "${row.flavor}, ${row.tool}")
            assertEquals(row.edits, options.canAllowAllEdits, "${row.flavor}, ${row.tool}")
            assertEquals(row.session || row.edits, options.hasOverflow, "${row.flavor}, ${row.tool}")
        }
    }

    @Test fun `dsh offers only one-shot allow and reject`() {
        // Web `isDshSession`: DSH request_permission carries exactly
        // allow-once/reject-once, so neither durable approval is offered —
        // not even for a tool whose name would otherwise unlock them.
        for (tool in listOf("Bash", "Edit", "Write", "TodoWrite", "exit_plan_mode")) {
            val options = options("dsh", tool)
            assertEquals(PermissionAction.Deny, options.denyAction, tool)
            assertFalse(options.canAllowForSession, tool)
            assertFalse(options.canAllowAllEdits, tool)
            assertFalse(options.hasOverflow, tool)
        }
    }

    @Test fun `edit tools offer all-edits only for claude`() {
        for (tool in listOf("Edit", "MultiEdit", "Write", "NotebookEdit")) {
            assertTrue(options("claude", tool).canAllowAllEdits, tool)
            assertFalse(options("codex", tool).canAllowAllEdits, tool)
            assertFalse(options("hermes", tool).canAllowAllEdits, tool)
            assertFalse(options(null, tool).canAllowAllEdits, tool)
        }
    }

    private data class Row(
        val flavor: String?,
        val tool: String,
        val deny: PermissionAction,
        val session: Boolean,
        val edits: Boolean,
    )
}

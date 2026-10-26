package app.hapi.companion.feature.share

import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SummaryText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * JVM tests for the share-picker session shaping (slice A) — ported rules of
 * `web/src/lib/sharePickerSessions.ts`: newest-first ordering, active-only
 * preview capped at the limit, query matching over the whole corpus, and the
 * hidden-active count hint.
 */
class SharePickerSessionsTest {
    private fun summary(
        id: String,
        active: Boolean = false,
        updatedAt: Long = 0,
        name: String? = null,
        summaryText: String? = null,
        machineId: String? = null,
    ): SessionSummary = SessionSummary(
        id = id,
        active = active,
        updatedAt = updatedAt,
        metadata = SessionSummaryMetadata(
            name = name,
            path = "/repo/$id",
            machineId = machineId,
            summary = summaryText?.let { SummaryText(it) },
        ),
    )

    @Test
    fun `empty query shows only active sessions newest first`() {
        val sessions = listOf(
            summary("old-active", active = true, updatedAt = 10),
            summary("inactive", active = false, updatedAt = 99),
            summary("new-active", active = true, updatedAt = 50),
        )
        val visible = SharePickerSessions.filterSessions(sessions, query = "")
        assertEquals(listOf("new-active", "old-active"), visible.map { it.id })
    }

    @Test
    fun `empty query caps the active preview at the limit`() {
        val sessions = (1..10).map { n -> summary("s$n", active = true, updatedAt = n.toLong()) }
        val visible = SharePickerSessions.filterSessions(sessions, query = "")
        assertEquals(SharePickerSessions.DEFAULT_PREVIEW_LIMIT, visible.size)
        // Newest first: the cap keeps the freshest, drops the oldest.
        assertEquals("s10", visible.first().id)
        assertEquals("s3", visible.last().id)
    }

    @Test
    fun `query searches inactive sessions too`() {
        val sessions = listOf(
            summary("alpha", active = false, updatedAt = 1, name = "Fix login bug"),
            summary("beta", active = true, updatedAt = 2, name = "Refactor parser"),
        )
        val visible = SharePickerSessions.filterSessions(sessions, query = "login")
        assertEquals(listOf("alpha"), visible.map { it.id })
    }

    @Test
    fun `query matches the machine label like the session list search`() {
        val sessions = listOf(
            summary("on-mac", name = "unrelated", machineId = "m-1"),
            summary("on-box", name = "unrelated", machineId = "m-2"),
        )
        val visible = SharePickerSessions.filterSessions(
            sessions,
            query = "MacBook",
            machineLabelOf = { machineId -> if (machineId == "m-1") "MacBook Pro" else "linux box" },
        )
        assertEquals(listOf("on-mac"), visible.map { it.id })
    }

    @Test
    fun `hidden active count is preview deficit only on the empty query`() {
        val sessions = (1..10).map { n -> summary("s$n", active = true, updatedAt = n.toLong()) }
        assertEquals(2, SharePickerSessions.countHiddenActiveSessions(sessions, query = ""))
        assertEquals(0, SharePickerSessions.countHiddenActiveSessions(sessions.take(3), query = ""))
        assertEquals(0, SharePickerSessions.countHiddenActiveSessions(sessions, query = "s"))
    }

    @Test
    fun `snapshot prep keeps the sidebar corpus rules`() {
        // Duplicate agent ids collapse; the empty fresh stub hides.
        val stub = summary("stub", active = false, updatedAt = 0)
        val sessions = listOf(
            summary("live", active = true, updatedAt = 5),
            stub,
        )
        val snapshot = sharePickerSnapshot(sessions)
        assertTrue(snapshot.none { it.id == "stub" })
        assertEquals(listOf("live"), snapshot.map { it.id })
    }
}

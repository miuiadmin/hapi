package app.hapi.companion.feature.share

import app.hapi.companion.feature.sessions.SessionListFilters
import app.hapi.companion.feature.sessions.SessionListSearch
import app.hapi.protocol.wire.SessionSummary

/**
 * Pure session list shaping for the share picker, ported from the web
 * `sharePickerSessions.ts`:
 * - empty query -> active sessions, most recently updated first, capped at
 *   [previewLimit] (web DEFAULT_SESSION_PREVIEW_LIMIT = 8);
 * - typed query -> every match (active or not), newest first.
 *
 * Divergence from web: the web share route additionally offers a
 * user-selectable date-range control that feeds sharePickerSessions via
 * customStart/customEnd; Android omits that control (no automatic window —
 * web's default empty-query path is filter(active).slice(0, limit), same as
 * here).
 */
object SharePickerSessions {
    const val DEFAULT_PREVIEW_LIMIT = 8

    /**
     * @param machineLabelOf resolves a session's machine to its display label
     *   (same field the sidebar search uses), so query matching sees exactly
     *   what the session list search sees.
     */
    fun filterSessions(
        sessions: List<SessionSummary>,
        query: String,
        previewLimit: Int = DEFAULT_PREVIEW_LIMIT,
        machineLabelOf: (machineId: String?) -> String = { _ -> "" },
    ): List<SessionSummary> {
        val sorted = sessions.sortedByDescending { it.updatedAt }
        return if (query.isBlank()) {
            sorted.filter { it.active }.take(previewLimit)
        } else {
            sorted.filter { SessionListSearch.sessionMatchesQuery(it, query, machineLabelOf(it.metadata?.machineId)) }
        }
    }

    /** Active sessions hidden by the preview cap ("N more" hint under the list). */
    fun countHiddenActiveSessions(
        sessions: List<SessionSummary>,
        query: String,
        previewLimit: Int = DEFAULT_PREVIEW_LIMIT,
    ): Int {
        if (!query.isBlank()) return 0
        return (sessions.count { it.active } - previewLimit).coerceAtLeast(0)
    }
}

/**
 * One-shot snapshot for the picker: `prepareSidebarSessions` dedupes and orders
 * the raw store list exactly like the sidebar (web parity for the source list
 * before [SharePickerSessions.filterSessions] applies picker-specific rules).
 */
fun sharePickerSnapshot(sessions: List<SessionSummary>): List<SessionSummary> =
    SessionListFilters.prepareSidebarSessions(sessions, selectedSessionId = null)

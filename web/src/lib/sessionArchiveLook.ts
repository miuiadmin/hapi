import { SESSION_LIFECYCLE_ARCHIVED } from '@hapi/protocol'
import type { Session, SessionSummary } from '@/types/api'

/**
 * The look of a session whose archive is still being confirmed: what the hub
 * will report once the agent has stopped — inactive, no pending work, sorted
 * with the archived rows. Work flags are cleared too, since the row used them
 * to offer the "busy" confirmation and to show a working spinner.
 */
export function archivedSessionLook(session: SessionSummary): SessionSummary {
    return {
        ...session,
        active: false,
        thinking: false,
        derivedToolWork: false,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        metadata: session.metadata
            ? { ...session.metadata, lifecycleState: SESSION_LIFECYCLE_ARCHIVED }
            : session.metadata,
    }
}

/** Show every session with a pending archive as archived; the rest unchanged. */
export function showPendingArchives(sessions: SessionSummary[], archivingIds: ReadonlySet<string>): SessionSummary[] {
    if (archivingIds.size === 0) return sessions
    return sessions.map((session) => (archivingIds.has(session.id) ? archivedSessionLook(session) : session))
}

/** The same look for the session detail the conversation view reads. */
export function archivedSessionDetailLook(session: Session): Session {
    return {
        ...session,
        active: false,
        thinking: false,
        metadata: session.metadata
            ? { ...session.metadata, lifecycleState: SESSION_LIFECYCLE_ARCHIVED }
            : session.metadata,
    }
}

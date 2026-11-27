import { useSyncExternalStore } from 'react'

/**
 * A session action that failed after its caller stopped waiting for it.
 *
 * Archiving looks done at once and a reopen shows progress, so neither caller
 * sits on an error any more: the failure is reported here and one dialog host
 * (SessionActionErrorDialog) shows it. The host lives at the app root because
 * the row that started the action may be gone by the time the request fails
 * (archived out of the Active filter, moved out of the pinned section).
 */
export type SessionActionFailure =
    | { kind: 'archive'; sessionId: string; message: string | null }
    | { kind: 'reopen'; sessionId: string; message: string | null }

let queue: SessionActionFailure[] = []
const listeners = new Set<() => void>()

function publish(): void {
    for (const listener of listeners) listener()
}

/** Queue the failure dialog. Failures are shown one after the other, oldest first. */
export function reportSessionActionFailure(failure: SessionActionFailure): void {
    queue = [...queue, failure]
    publish()
}

/**
 * Drop `failure` from the queue (the dialog's Close). Defaults to the one
 * shown, so a Close never skips a failure that was queued behind it.
 */
export function dismissSessionActionFailure(failure: SessionActionFailure | null = queue[0] ?? null): void {
    if (!failure || !queue.includes(failure)) return
    queue = queue.filter((entry) => entry !== failure)
    publish()
}

/** Forget every queued failure (tests, hub switch). */
export function clearSessionActionFailures(): void {
    if (queue.length === 0) return
    queue = []
    publish()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

/** The failure to show now, or null. */
export function useSessionActionFailure(): SessionActionFailure | null {
    return useSyncExternalStore(subscribe, () => queue[0] ?? null, () => queue[0] ?? null)
}

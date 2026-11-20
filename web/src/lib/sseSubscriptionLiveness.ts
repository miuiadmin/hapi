/**
 * Per-subscription teardown registry shared between useSSE and
 * useVisibilityReporter.
 *
 * useSSE closes its EventSource (and with it the hub-side subscription) on
 * every reconnect cycle — including the visibility-recovery reconnect the
 * instant a suspended tab wakes up. `subscriptionId` only reaches the
 * visibility reporter through a React state update, which lands after the
 * visibilitychange listeners of both hooks have already run in the same
 * dispatch. Without this registry the reporter fires a doomed
 * POST /visibility against a subscription useSSE just closed — once per
 * wake, per connection — racing the hub's reap of the dead socket.
 *
 * Marks are advisory only: a false positive skips at most one visibility
 * POST for an already-replaced subscription, and the next subscription id
 * starts unmarked.
 */
const tornDownSubscriptions = new Set<string>()

/** Bound the registry for long-lived tabs: every reconnect adds one id, and
 * only the newest handful can still matter to an in-flight report. */
const MAX_TRACKED_SUBSCRIPTIONS = 32

export function markSubscriptionTornDown(subscriptionId: string | null | undefined): void {
    if (!subscriptionId) {
        return
    }
    tornDownSubscriptions.add(subscriptionId)
    while (tornDownSubscriptions.size > MAX_TRACKED_SUBSCRIPTIONS) {
        const oldest = tornDownSubscriptions.values().next().value
        if (oldest === undefined) {
            break
        }
        tornDownSubscriptions.delete(oldest)
    }
}

/** Clears the teardown mark for a freshly handshaken subscription id. */
export function reviveSubscription(subscriptionId: string): void {
    tornDownSubscriptions.delete(subscriptionId)
}

export function isSubscriptionTornDown(subscriptionId: string): boolean {
    return tornDownSubscriptions.has(subscriptionId)
}

/** Test helper: drop all marks between test cases. */
export function resetSubscriptionLivenessForTests(): void {
    tornDownSubscriptions.clear()
}

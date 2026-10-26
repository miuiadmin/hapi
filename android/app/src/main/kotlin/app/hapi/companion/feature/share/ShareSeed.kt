package app.hapi.companion.feature.share

/**
 * A share payload bound to the session it must land in — the Android shape of
 * the web's sessionStorage `pendingShareTransfer` (there: `{sessionId, transferId}`;
 * here the payload itself rides in the AppGraph slot, no transfer store).
 *
 * Lifecycle mirrors web `sharePendingState.ts`:
 *  - armed when the user picks a target (or a new session is created);
 *  - consumed by [ShareSeedConsumer] once that session's screen is up and
 *    running (web waits for `sessionActive`);
 *  - retargeted when the session is superseded mid-flight;
 *  - dropped when its holder is destroyed (web drops on tab close).
 */
data class ArmedShareSeed(
    val sessionId: String,
    val share: ShareHandoff,
)

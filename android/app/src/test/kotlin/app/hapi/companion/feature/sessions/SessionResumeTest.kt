package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionMetadata
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of `web/src/lib/sessionResume.test.ts` — the full state matrix for
 * flavor × agent-id × cursor `onDisk`, and the reopen-gate precedence
 * (only a definitive `onDisk:false` disables; probe errors soft-allow,
 * tiann/hapi#1084).
 */
class SessionResumeTest {

    /** Web `makeSession` mirror: default fixture is an inactive cursor session. */
    private fun metadata(
        flavor: String? = "cursor",
        path: String = "/tmp/project",
        host: String = "localhost",
        claudeSessionId: String? = null,
        codexSessionId: String? = null,
        geminiSessionId: String? = null,
        opencodeSessionId: String? = null,
        grokSessionId: String? = null,
        agySessionId: String? = null,
        cursorSessionId: String? = null,
        kimiSessionId: String? = null,
        copilotSessionId: String? = null,
        dshSessionId: String? = null,
        hermesSessionId: String? = null,
        berrySessionId: String? = null,
        zcodeSessionId: String? = null,
        piSessionId: String? = null,
    ): SessionMetadata = SessionMetadata(
        path = path,
        host = host,
        flavor = flavor,
        claudeSessionId = claudeSessionId,
        codexSessionId = codexSessionId,
        geminiSessionId = geminiSessionId,
        opencodeSessionId = opencodeSessionId,
        grokSessionId = grokSessionId,
        agySessionId = agySessionId,
        cursorSessionId = cursorSessionId,
        kimiSessionId = kimiSessionId,
        copilotSessionId = copilotSessionId,
        dshSessionId = dshSessionId,
        hermesSessionId = hermesSessionId,
        berrySessionId = berrySessionId,
        zcodeSessionId = zcodeSessionId,
        piSessionId = piSessionId,
    )

    private fun canResume(
        active: Boolean = false,
        metadata: SessionMetadata? = metadata(),
        userMessageCount: Int = 0,
        cursorChatOnDisk: Boolean? = null,
    ): Boolean = inactiveSessionCanResume(
        active = active,
        metadata = metadata,
        userMessageCount = userMessageCount,
        cursorChatOnDisk = cursorChatOnDisk,
    )

    // ----------------------------- resolveAgentSessionIdFromMetadata ------

    @Test
    fun `resolveAgentSessionIdFromMetadata picks the id matching the session flavor`() {
        assertEquals(
            "cu-1",
            resolveAgentSessionIdFromMetadata(metadata(flavor = "cursor", cursorSessionId = "cu-1")),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata ignores stale cross-flavor ids`() {
        // CursorSessionId present but the session is claude: the hub only
        // honors the current flavor's id.
        assertNull(
            resolveAgentSessionIdFromMetadata(
                metadata(flavor = "claude", cursorSessionId = "cu-1"),
            ),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata defaults to claude when flavor is missing`() {
        assertEquals(
            "cl-1",
            resolveAgentSessionIdFromMetadata(metadata(flavor = null, claudeSessionId = "cl-1")),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata returns null for null metadata`() {
        assertNull(resolveAgentSessionIdFromMetadata(null))
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata still returns cursorSessionId regardless of protocol`() {
        // Protocol switching (stream-json → acp) is metadata the web reads
        // elsewhere; the resume handle is the same id either way.
        assertEquals(
            "cu-9",
            resolveAgentSessionIdFromMetadata(metadata(flavor = "cursor", cursorSessionId = "cu-9")),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata does not infer a DSH resume id from stale cross-flavor metadata`() {
        assertNull(
            resolveAgentSessionIdFromMetadata(
                metadata(flavor = "dsh", claudeSessionId = "cl-1", cursorSessionId = "cu-1"),
            ),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata returns dshSessionId for dsh flavor`() {
        assertEquals(
            "acp-session-1",
            resolveAgentSessionIdFromMetadata(metadata(flavor = "dsh", dshSessionId = "acp-session-1")),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata returns hermesSessionId for hermes flavor`() {
        assertEquals(
            "hermes-daemon-session-1",
            resolveAgentSessionIdFromMetadata(
                metadata(flavor = "hermes", hermesSessionId = "hermes-daemon-session-1"),
            ),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata does not infer a Hermes resume id from stale cross-flavor metadata`() {
        assertNull(
            resolveAgentSessionIdFromMetadata(
                metadata(flavor = "hermes", claudeSessionId = "stale-claude-id"),
            ),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata returns berrySessionId for berry flavor`() {
        assertEquals(
            "berry-1",
            resolveAgentSessionIdFromMetadata(metadata(flavor = "berry", berrySessionId = "berry-1")),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata returns zcodeSessionId for zcode flavor`() {
        assertEquals(
            "zcode-lazy-session-1",
            resolveAgentSessionIdFromMetadata(
                metadata(flavor = "zcode", zcodeSessionId = "zcode-lazy-session-1"),
            ),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata does not infer a ZCode resume id from stale cross-flavor metadata`() {
        assertNull(
            resolveAgentSessionIdFromMetadata(
                metadata(flavor = "zcode", claudeSessionId = "stale-claude-id"),
            ),
        )
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata returns piSessionId when flavor is pi and prefers it over other ids`() {
        assertEquals(
            "pi-1",
            resolveAgentSessionIdFromMetadata(
                metadata(flavor = "pi", piSessionId = "pi-1", claudeSessionId = "cl-1"),
            ),
        )
        assertNull(resolveAgentSessionIdFromMetadata(metadata(flavor = "pi")))
    }

    // -------------------------------- regression for all other flavor ids --

    @Test
    fun `resolveAgentSessionIdFromMetadata resolves every flavor-specific id`() {
        val cases = listOf(
            Triple("codex", "cx-1", metadata(flavor = "codex", codexSessionId = "cx-1")),
            Triple("gemini", "gm-1", metadata(flavor = "gemini", geminiSessionId = "gm-1")),
            Triple("opencode", "oc-1", metadata(flavor = "opencode", opencodeSessionId = "oc-1")),
            Triple("grok", "gr-1", metadata(flavor = "grok", grokSessionId = "gr-1")),
            Triple("agy", "ag-1", metadata(flavor = "agy", agySessionId = "ag-1")),
            Triple("cursor", "cu-1", metadata(flavor = "cursor", cursorSessionId = "cu-1")),
            Triple("kimi", "ki-1", metadata(flavor = "kimi", kimiSessionId = "ki-1")),
            Triple("copilot", "cp-1", metadata(flavor = "copilot", copilotSessionId = "cp-1")),
            Triple("dsh", "dsh-1", metadata(flavor = "dsh", dshSessionId = "dsh-1")),
            Triple("hermes", "hm-1", metadata(flavor = "hermes", hermesSessionId = "hm-1")),
            Triple("berry", "be-1", metadata(flavor = "berry", berrySessionId = "be-1")),
            Triple("zcode", "zc-1", metadata(flavor = "zcode", zcodeSessionId = "zc-1")),
            Triple("claude", "cl-1", metadata(flavor = "claude", claudeSessionId = "cl-1")),
        )
        for ((label, expected, meta) in cases) {
            assertEquals(expected, resolveAgentSessionIdFromMetadata(meta), label)
        }
    }

    @Test
    fun `resolveAgentSessionIdFromMetadata falls back to the claude branch for unknown flavors`() {
        assertEquals(
            "cl-1",
            resolveAgentSessionIdFromMetadata(metadata(flavor = "mystery", claudeSessionId = "cl-1")),
        )
    }

    // ------------------------------------ inactiveSessionCanResume matrix --

    @Test
    fun `canResume is true for active sessions`() {
        assertTrue(canResume(active = true))
    }

    @Test
    fun `canResume allows fresh spawn when no agent id and no messages`() {
        assertTrue(canResume())
    }

    @Test
    fun `canResume allows resume when agent id exists`() {
        assertTrue(canResume(metadata = metadata(flavor = "claude", claudeSessionId = "cl-1")))
        assertTrue(canResume(metadata = metadata(flavor = "agy", agySessionId = "ag-1")))
        assertTrue(
            canResume(
                metadata = metadata(flavor = "pi", piSessionId = "pi-1"),
                userMessageCount = 5,
            ),
        )
    }

    @Test
    fun `canResume allows dsh resume when dshSessionId exists`() {
        assertTrue(
            canResume(
                metadata = metadata(flavor = "dsh", dshSessionId = "acp-session-1"),
                userMessageCount = 5,
            ),
        )
    }

    @Test
    fun `canResume rejects dsh with messages but no dshSessionId`() {
        assertFalse(canResume(metadata = metadata(flavor = "dsh"), userMessageCount = 3))
    }

    @Test
    fun `canResume allows hermes resume when hermesSessionId exists`() {
        assertTrue(
            canResume(
                metadata = metadata(flavor = "hermes", hermesSessionId = "hermes-daemon-session-1"),
                userMessageCount = 5,
            ),
        )
    }

    @Test
    fun `canResume rejects hermes with messages but no hermesSessionId`() {
        assertFalse(canResume(metadata = metadata(flavor = "hermes"), userMessageCount = 3))
    }

    @Test
    fun `canResume allows berry resume when berrySessionId exists`() {
        assertTrue(
            canResume(
                metadata = metadata(flavor = "berry", berrySessionId = "berry-1"),
                userMessageCount = 5,
            ),
        )
    }

    @Test
    fun `canResume rejects berry with messages but no berrySessionId`() {
        assertFalse(canResume(metadata = metadata(flavor = "berry"), userMessageCount = 3))
    }

    @Test
    fun `canResume allows zcode resume when zcodeSessionId exists`() {
        assertTrue(
            canResume(
                metadata = metadata(flavor = "zcode", zcodeSessionId = "zcode-lazy-session-1"),
                userMessageCount = 5,
            ),
        )
    }

    @Test
    fun `canResume rejects zcode with messages but no zcodeSessionId`() {
        assertFalse(canResume(metadata = metadata(flavor = "zcode"), userMessageCount = 3))
    }

    @Test
    fun `canResume allows cursor resume when chat-store probe is unverified`() {
        // Probe failed / unknown must NOT be treated as missing data (#1084).
        assertTrue(
            canResume(
                metadata = metadata(flavor = "cursor", cursorSessionId = "cu-1"),
                cursorChatOnDisk = null,
            ),
        )
    }

    @Test
    fun `canResume rejects cursor resume when the recorded chat store is missing`() {
        assertFalse(
            canResume(
                metadata = metadata(flavor = "cursor", cursorSessionId = "cu-1"),
                cursorChatOnDisk = false,
            ),
        )
        assertTrue(
            canResume(
                metadata = metadata(flavor = "cursor", cursorSessionId = "cu-1"),
                cursorChatOnDisk = true,
            ),
        )
    }

    @Test
    fun `canResume does not apply cursor chat store status to other agent flavors`() {
        assertTrue(
            canResume(
                metadata = metadata(flavor = "codex", codexSessionId = "cx-1"),
                userMessageCount = 5,
                cursorChatOnDisk = false,
            ),
        )
    }

    @Test
    fun `canResume rejects inactive sessions with messages but no agent id`() {
        assertFalse(canResume(userMessageCount = 3))
    }

    @Test
    fun `canResume treats a stale cross-flavor agent id as no resume handle`() {
        // Fresh spawn path: 0 messages → allowed; any messages → rejected
        // (web 'stale cross-flavor id' case: cursor session, stale codex id).
        val stale = metadata(flavor = "cursor", codexSessionId = "stale-codex-1")
        assertTrue(canResume(metadata = stale, userMessageCount = 0))
        assertFalse(canResume(metadata = stale, userMessageCount = 3))
    }

    @Test
    fun `canResume rejects when metadata path is missing`() {
        assertFalse(canResume(metadata = metadata(path = "")))
        assertFalse(canResume(metadata = null))
    }

    @Test
    fun `canResume allows claude and codex resume by message recovery when no flavor id stored`() {
        assertTrue(
            canResume(
                metadata = metadata(flavor = "claude"),
                userMessageCount = 4,
            ),
        )
        assertTrue(
            canResume(
                metadata = metadata(flavor = "codex"),
                userMessageCount = 4,
            ),
        )
        // Flavor missing defaults to claude → recovery still applies.
        assertTrue(canResume(metadata = metadata(flavor = null), userMessageCount = 4))
    }

    @Test
    fun `canResume rejects non-recovering flavors with messages but no flavor-specific id`() {
        assertFalse(
            canResume(
                metadata = metadata(flavor = "pi"),
                userMessageCount = 2,
            ),
        )
        assertFalse(
            canResume(
                metadata = metadata(flavor = "pi", claudeSessionId = "cl-stale"),
                userMessageCount = 2,
            ),
        )
    }

    @Test
    fun `canResume allows active pi session unconditionally`() {
        assertTrue(
            canResume(
                active = true,
                metadata = metadata(flavor = "pi"),
                userMessageCount = 7,
            ),
        )
    }

    // -------------------------------------- resolveCursorReopenGate ------

    @Test
    fun `gate is open when not applicable`() {
        assertEquals(
            CursorReopenGate(disabledReason = null, probeUnverified = false),
            resolveCursorReopenGate(applicable = false, onDisk = null, probeFailed = false, isLoading = true),
        )
    }

    @Test
    fun `gate only disables for definitive onDisk false`() {
        assertEquals(
            CursorReopenGate(disabledReason = CursorReopenGateReason.Missing, probeUnverified = false),
            resolveCursorReopenGate(applicable = true, onDisk = false, probeFailed = false, isLoading = false),
        )
        // Probe error → soft-allow with unverified hint (#1084).
        assertEquals(
            CursorReopenGate(disabledReason = null, probeUnverified = true),
            resolveCursorReopenGate(applicable = true, onDisk = null, probeFailed = true, isLoading = false),
        )
        assertEquals(
            CursorReopenGate(disabledReason = null, probeUnverified = false),
            resolveCursorReopenGate(applicable = true, onDisk = true, probeFailed = false, isLoading = false),
        )
        assertEquals(
            CursorReopenGate(disabledReason = CursorReopenGateReason.Checking, probeUnverified = false),
            resolveCursorReopenGate(applicable = true, onDisk = null, probeFailed = false, isLoading = true),
        )
    }

    @Test
    fun `gate fall-through without data is checking — row-menu first-frame semantics`() {
        // Applicable, no verdict, no error, not loading (a probe that never
        // started): reopen stays disabled until something settles, matching
        // the web's initial render before the query registers.
        assertEquals(
            CursorReopenGate(disabledReason = CursorReopenGateReason.Checking, probeUnverified = false),
            resolveCursorReopenGate(applicable = true, onDisk = null, probeFailed = false, isLoading = false),
        )
    }

    @Test
    fun `gate precedence — onDisk false wins over loading`() {
        assertEquals(
            CursorReopenGate(disabledReason = CursorReopenGateReason.Missing, probeUnverified = false),
            resolveCursorReopenGate(applicable = true, onDisk = false, probeFailed = true, isLoading = true),
        )
    }

    // ---------------------------------------- probe applicability -------

    @Test
    fun `probe applies only to inactive cursor sessions with an id and a path`() {
        assertTrue(
            isCursorChatStoreProbeApplicable(
                active = false,
                flavor = "cursor",
                cursorSessionId = "cu-1",
                path = "/tmp/project",
            ),
        )
        assertFalse(
            isCursorChatStoreProbeApplicable(
                active = true,
                flavor = "cursor",
                cursorSessionId = "cu-1",
                path = "/tmp/project",
            ),
        )
        assertFalse(
            isCursorChatStoreProbeApplicable(
                active = false,
                flavor = "claude",
                cursorSessionId = "cu-1",
                path = "/tmp/project",
            ),
        )
        assertFalse(
            isCursorChatStoreProbeApplicable(
                active = false,
                flavor = "cursor",
                cursorSessionId = null,
                path = "/tmp/project",
            ),
        )
        assertFalse(
            isCursorChatStoreProbeApplicable(
                active = false,
                flavor = "cursor",
                cursorSessionId = "cu-1",
                path = "",
            ),
        )
    }
}

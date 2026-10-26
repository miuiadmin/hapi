package app.hapi.companion.feature.share

/**
 * Pure model of a system share (ACTION_SEND / ACTION_SEND_MULTIPLE) after the
 * platform Intent has been flattened. Kept free of every `android.*` type so
 * parsing and seeding rules can be JVM-unit-tested: URIs ride as strings and
 * are [android.net.Uri.parse]d only at ingest time, inside the chat screen.
 *
 * Web parity: the PWA share_target accepts one text field plus any number of
 * files (its accept list ends in a wildcard entry); the seed text joins
 * title + body, and each file goes through the regular attachment pipeline.
 */
data class ShareHandoff(
    val subject: String? = null,
    val text: String? = null,
    val streamUris: List<String> = emptyList(),
) {
    /** True when at least one usable payload slot survived parsing. */
    val hasPayload: Boolean
        get() = seedText().isNotEmpty() || streamUris.isNotEmpty()

    /**
     * Text handed to the composer, mirroring the web seed shape
     * (`[title, text, url]` on web — Android shares carry no separate URL
     * extra, so only subject and text join here).
     */
    fun seedText(): String = listOfNotNull(subject, text)
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .joinToString("\n")
}

/**
 * Parses the extras of a share intent into a [ShareHandoff]. Pure; the Android
 * side ([SystemShareReader]) only unwraps the Intent into the primitives here.
 *
 * Tolerance rules (deliberate):
 * - A `FLAG_GRANT_READ_URI_PERMISSION`-less intent is still parsed; unreadable
 *   URIs fail later, per file, inside the existing attachment pipeline
 *   (SecurityException already maps to `Unreadable` there).
 * - Blank/null stream entries are dropped; exact duplicates removed; order kept.
 * - Returns null when nothing usable remains (caller treats it as "not ours").
 */
object ShareIntents {
    const val ACTION_SEND = "android.intent.action.SEND"
    const val ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE"

    fun isShareAction(action: String?): Boolean =
        action == ACTION_SEND || action == ACTION_SEND_MULTIPLE

    fun parse(
        action: String?,
        subject: CharSequence? = null,
        text: CharSequence? = null,
        streams: List<String?> = emptyList(),
    ): ShareHandoff? {
        if (!isShareAction(action)) return null
        val handoff = ShareHandoff(
            subject = subject?.toString()?.trim()?.takeIf { it.isNotEmpty() },
            text = text?.toString()?.trim()?.takeIf { it.isNotEmpty() },
            streamUris = streams.mapNotNull { it?.trim()?.takeIf { s -> s.isNotEmpty() } }.distinct(),
        )
        return handoff.takeIf { it.hasPayload }
    }
}

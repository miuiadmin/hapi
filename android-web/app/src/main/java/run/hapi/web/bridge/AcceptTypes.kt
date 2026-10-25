package run.hapi.web.bridge

/**
 * Pure normalizer for the HTML `<input accept>` attribute as WebView hands it
 * to [android.webkit.WebChromeClient.FileChooserParams.getAcceptTypes].
 *
 * The result feeds `Intent.EXTRA_MIME_TYPES` of the ACTION_GET_CONTENT picker
 * (which keeps a catch-all base type), so every entry must be a MIME type —
 * file extensions and bare words are mapped or dropped, never passed through.
 *
 * Kept free of android.* classes so it is unit-testable on the JVM.
 */
object AcceptTypes {

    /** Known extension → MIME mappings (inverse of the common download map). */
    private val EXT_MIME: Map<String, String> = mapOf(
        "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png",
        "gif" to "image/gif", "webp" to "image/webp", "heif" to "image/heif",
        "heic" to "image/heic", "svg" to "image/svg+xml", "bmp" to "image/bmp",
        "mp4" to "video/mp4", "webm" to "video/webm", "mov" to "video/quicktime",
        "mp3" to "audio/mpeg", "m4a" to "audio/mp4", "aac" to "audio/aac",
        "ogg" to "audio/ogg", "oga" to "audio/ogg", "wav" to "audio/x-wav",
        "pdf" to "application/pdf", "json" to "application/json",
        "txt" to "text/plain", "csv" to "text/csv", "md" to "text/markdown",
        "htm" to "text/html", "html" to "text/html", "zip" to "application/zip",
        "gz" to "application/gzip",
    )

    private val BARE_TYPES = setOf("audio", "video", "image", "text", "application")

    /**
     * Normalizes raw accept tokens (WebView often passes empty strings, or one
     * comma-joined string, or per-token arrays) into a de-duplicated, ordered
     * MIME list. Empty result = no filter (catch-all picker).
     */
    fun toMimeTypes(acceptTypes: Array<String>?): List<String> {
        if (acceptTypes == null) return emptyList()
        val out = LinkedHashSet<String>()
        for (raw in acceptTypes) {
            if (raw.isNullOrEmpty()) continue
            for (token in raw.split(',')) {
                val t = token.trim().lowercase()
                if (t.isEmpty()) continue
                when {
                    t.startsWith(".") -> EXT_MIME[t.removePrefix(".")]?.let(out::add)
                    t.contains('/') -> out.add(t)
                    t in BARE_TYPES -> out.add("$t/*")
                    else -> Unit // unknown token (e.g. "file_extension"): drop, never widen
                }
            }
        }
        return out.toList()
    }
}

package run.hapi.web.bridge

/**
 * Pure filename derivation for the shell's [android.webkit.DownloadListener]:
 * given the URL, Content-Disposition header and MIME type, produce a safe
 * file name for the system DownloadManager (which does its own path handling —
 * we must never hand it path fragments or control characters).
 *
 * Mirrors the classic `URLUtil.guessFileName` behavior (reimplemented so it is
 * unit-testable on the JVM; `URLUtil` is not in the unit-test android.jar).
 */
object DownloadNaming {

    private const val FALLBACK_NAME = "downloadfile"
    private const val FALLBACK_EXT = "bin"

    /** RFC 6266 `filename*=UTF-8''…` (charset token kept for tolerance). */
    private val FILENAME_STAR = Regex("""filename\*\s*=\s*(?:[^';]*)''([^;]*)""", RegexOption.IGNORE_CASE)

    /** Classic `filename=…` (quoted or bare), de-prioritized vs filename*. */
    private val FILENAME_PLAIN = Regex("""filename\s*=\s*"?([^";]*)""", RegexOption.IGNORE_CASE)

    /** MIME → extension used only to repair extension-less names. */
    private val MIME_EXT: Map<String, String> = mapOf(
        "image/jpeg" to "jpg", "image/png" to "png", "image/gif" to "gif",
        "image/webp" to "webp", "image/heif" to "heif", "image/heic" to "heic",
        "image/bmp" to "bmp", "image/svg+xml" to "svg",
        "video/mp4" to "mp4", "video/webm" to "webm", "video/quicktime" to "mov",
        "audio/mpeg" to "mp3", "audio/mp4" to "m4a", "audio/aac" to "aac",
        "audio/ogg" to "ogg", "audio/x-wav" to "wav", "audio/wav" to "wav",
        "application/pdf" to "pdf", "application/json" to "json",
        "application/zip" to "zip", "application/gzip" to "gz",
        "text/plain" to "txt", "text/csv" to "csv", "text/markdown" to "md",
        "text/html" to "html",
    )

    /**
     * Derivation order: Content-Disposition (filename* > filename) > URL last
     * path segment > fallback. Extension repaired from MIME type when missing.
     */
    fun guessFileName(url: String?, contentDisposition: String?, mimeType: String?): String {
        val mime = mimeType?.trim()?.takeIf { it.isNotEmpty() }
        var name = fromDisposition(contentDisposition)
        if (name == null) name = fromUrl(url)
        if (name == null) name = FALLBACK_NAME
        if (!hasExtension(name)) {
            val ext = mime?.let { MIME_EXT[it.trim().lowercase()] } ?: FALLBACK_EXT
            name = "$name.$ext"
        }
        return name
    }

    private fun fromDisposition(disposition: String?): String? {
        if (disposition.isNullOrEmpty()) return null
        FILENAME_STAR.find(disposition)?.let { m ->
            percentDecode(m.groupValues[1])?.let { return sanitize(it) }
        }
        FILENAME_PLAIN.find(disposition)?.let { m ->
            return sanitize(m.groupValues[1]).takeIf { it.isNotEmpty() } ?: FALLBACK_NAME
        }
        return null
    }

    /** Last URL path segment, query stripped, percent-decoded. */
    private fun fromUrl(url: String?): String? {
        if (url == null) return null
        val noQuery = url.substringBefore('#').substringBefore('?')
        val segment = noQuery.substringAfterLast('/').substringAfterLast('\\')
        if (segment.isEmpty()) return null
        val decoded = percentDecode(segment) ?: return null
        return sanitize(decoded).takeIf { it.isNotEmpty() }
    }

    /**
     * Strips quotes/whitespace/control characters and any path fragments —
     * the DownloadManager destination must be a bare relative name.
     */
    private fun sanitize(raw: String): String =
        raw
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .trim()
            .trim('"', '\'')
            .filterNot { it.code < 0x20 }

    private fun hasExtension(name: String): Boolean {
        val last = name.substringAfterLast('/')
        val dot = last.lastIndexOf('.')
        // Leading dot only (".hidden") is not an extension.
        return dot > 0 && dot < last.length - 1
    }

    /** RFC 5987 percent-decoding; returns null on malformed escapes. */
    internal fun percentDecode(input: String): String? {
        if (!input.contains('%')) return input
        val bytes = ArrayList<Byte>(input.length)
        var i = 0
        while (i < input.length) {
            val c = input[i]
            if (c == '%') {
                if (i + 3 > input.length) return null // need two hex digits
                val value = input.substring(i + 1, i + 3).toIntOrNull(16) ?: return null
                bytes.add(value.toByte())
                i += 3
            } else {
                bytes.add(c.code.toByte())
                i += 1
            }
        }
        return String(bytes.toByteArray())
    }
}

package run.hapi.web.static

/**
 * Extension → MIME mapping for locally served dist resources. Pure map on
 * purpose (no android.webkit.MimeTypeMap) so the router is JVM-testable and
 * the behavior is byte-identical in tests and on device.
 */
object Mime {

    private val BY_EXTENSION: Map<String, String> = mapOf(
        "html" to "text/html",
        "htm" to "text/html",
        "js" to "text/javascript",
        "mjs" to "text/javascript",
        "css" to "text/css",
        "svg" to "image/svg+xml",
        "png" to "image/png",
        "ico" to "image/x-icon",
        "webmanifest" to "application/manifest+json",
        "json" to "application/json",
        "wasm" to "application/wasm",
        "woff2" to "font/woff2",
        "woff" to "font/woff",
        "ttf" to "font/ttf",
        "otf" to "font/otf",
        "map" to "application/json",
        "txt" to "text/plain",
    )

    private val TEXTUAL = setOf("text/html", "text/javascript", "text/css", "text/plain")

    fun mimeFor(rel: String): String {
        val ext = rel.substringAfterLast('.', "").lowercase()
        return BY_EXTENSION[ext] ?: "application/octet-stream"
    }

    /**
     * Charset encoding parameter for WebResourceResponse — only textual
     * types; everything else gets null (binary streams must not be decoded).
     */
    fun encodingFor(rel: String): String? {
        val mime = mimeFor(rel)
        return if (mime in TEXTUAL || mime == "application/json" ||
            mime == "application/manifest+json"
        ) {
            "utf-8"
        } else {
            null
        }
    }
}

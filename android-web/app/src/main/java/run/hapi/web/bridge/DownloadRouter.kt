package run.hapi.web.bridge

/**
 * Pure routing decision for URLs the WebView hands to its
 * [android.webkit.DownloadListener] (it only fires for URLs the WebView
 * itself cannot render — attachments, blobs-to-download, etc.). The shell
 * must never swallow them.
 *
 *  - `http(s)` → system DownloadManager (with cookies attached by the caller)
 *  - anything else (`blob:`, `data:`, custom schemes — the DownloadManager
 *    cannot fetch those) → hand to the system via ACTION_VIEW as a last resort.
 *
 * Kept free of android.* classes so it is unit-testable on the JVM.
 */
object DownloadRouter {

    sealed interface Route {
        /** Enqueue via DownloadManager under this derived name. */
        data class Enqueue(val fileName: String, val mimeType: String?) : Route

        /** Let the system try (ACTION_VIEW); may still end in nothing. */
        data class OpenExternally(val url: String) : Route
    }

    fun decide(url: String?, contentDisposition: String?, mimeType: String?): Route {
        val safeUrl = url?.trim().orEmpty()
        if (safeUrl.isEmpty()) return Route.OpenExternally(safeUrl)
        val scheme = safeUrl.substringBefore(':', missingDelimiterValue = "").lowercase()
        val mime = mimeType?.trim()?.takeIf { it.isNotEmpty() }
        return when (scheme) {
            "http", "https" ->
                Route.Enqueue(DownloadNaming.guessFileName(safeUrl, contentDisposition, mime), mime)
            else -> Route.OpenExternally(safeUrl)
        }
    }
}

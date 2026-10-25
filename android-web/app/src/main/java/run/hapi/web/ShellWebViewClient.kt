package run.hapi.web

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Base WebViewClient for the shell — placeholder, to be extended by the
 * static-serving layer (Implement B).
 *
 * Fixed architecture (do not change):
 *  - The WebView always loads the REAL hub origin. App shell, API, SSE and
 *    socket.io requests go straight to the network, same-origin — identical to
 *    the PWA, so CORS, auth (per-origin localStorage) and the service worker
 *    behave exactly as in a browser. The page is NEVER loaded from a local
 *    origin (appassets/file) — that would break both.
 *  - [shouldInterceptRequest] is the single seam for static serving: OTA dir >
 *    bundled `assets/webdist` > network. Until B lands, every request returns
 *    null (plain network passthrough). B either sets [staticResolver] or
 *    overrides the method in a subclass.
 *  - External http(s) links (any origin other than the hub) and known
 *    scheme-links (mailto/tel/intent/geo) are handed to the system browser so
 *    the shell never navigates away from the hub.
 */
open class ShellWebViewClient(
    private val context: Context,
    private val hubUrl: String,
) : WebViewClient() {

    /**
     * Static-serving seam (Implement B): return a canned response, or null to
     * let the request fall through to the network.
     */
    @Volatile
    var staticResolver: ((WebResourceRequest) -> WebResourceResponse?)? = null

    /** Set by MainActivity before each boot load — see [onPageFinished]. */
    @Volatile
    private var pendingHistoryClear = false

    fun armHistoryClear() {
        pendingHistoryClear = true
    }

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? = staticResolver?.invoke(request)

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri: Uri = request.url ?: return false
        return when (uri.scheme?.lowercase()) {
            "http", "https" -> {
                if (HubUrls.sameOrigin(uri.toString(), hubUrl)) {
                    false // same-origin navigation stays inside the WebView
                } else {
                    openExternally(uri)
                    true
                }
            }
            "mailto", "tel", "intent", "geo" -> {
                openExternally(uri)
                true
            }
            else -> false // about:, blob:, data:, ws-adjacent schemes: WebView's business
        }
    }

    override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        // Second half of the token-in-history guard: the boot URL enters the
        // back/forward list only when the page commits, so clear once more.
        if (pendingHistoryClear) {
            pendingHistoryClear = false
            view.clearHistory()
        }
    }

    private fun openExternally(uri: Uri) {
        try {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: ActivityNotFoundException) {
            // No handler on this device — drop the navigation silently.
        }
    }
}

package run.hapi.web.static

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import run.hapi.web.HubUrls

/**
 * Android glue for the three-layer static serving. [maybeIntercept] is hung
 * off `ShellWebViewClient.staticResolver` (called on WebView's IO threads —
 * everything here is thread-safe and local-disk only; no network, no main
 * thread).
 */
class StaticResourceInterceptor(
    private val hubUrl: String,
    private val otaLayer: OtaFileStore,
    private val bundledLayer: BundledAssetSource,
) {
    private val router = StaticRouter(otaLayer, bundledLayer)

    fun maybeIntercept(request: WebResourceRequest): WebResourceResponse? {
        if (!request.method.equals("GET", ignoreCase = true)) return null
        val url: Uri = request.url ?: return null
        val scheme = url.scheme?.lowercase() ?: return null
        if (scheme != "https" && scheme != "http") return null
        // Only ever serve same-origin statics; cross-origin subresources go
        // straight to the network (the dist is self-contained, so this only
        // fences odd outbound requests).
        if (!HubUrls.sameOrigin(url.toString(), hubUrl)) return null

        val hit = router.resolveLocal(url.path ?: return null) ?: return null
        val stream =
            when (hit.layer) {
                StaticRouter.Layer.OTA -> otaLayer.open(hit.rel)
                StaticRouter.Layer.BUNDLED -> bundledLayer.open(hit.rel)
            } ?: return null // lost a race with pruning — network it is
        return WebResourceResponse(Mime.mimeFor(hit.rel), Mime.encodingFor(hit.rel), stream)
    }
}

/**
 * Facade the activity talks to: builds the layer stack for one hub, exposes
 * the WebViewClient resolver lambda, and runs OTA rounds.
 */
class WebStaticServing(context: Context, private val hubUrl: String) {

    private val otaStore = OtaFileStore(context)
    private val interceptor =
        StaticResourceInterceptor(hubUrl, otaStore, BundledAssetSource(context))
    private val updater = HotUpdateManager(hubUrl, OkHttpFetcher(), otaStore)

    /** Set as `ShellWebViewClient.staticResolver`. */
    val resolver: (WebResourceRequest) -> WebResourceResponse? =
        interceptor::maybeIntercept

    /**
     * One OTA round, fire-and-forget on [scope] (app start + pairing done).
     * Silent failure by design; a committed round refreshes the layer
     * snapshot so the next page load picks it up.
     */
    fun launchHotUpdate(scope: CoroutineScope) {
        scope.launch {
            updater.runOnce()
            otaStore.refresh()
        }
    }
}

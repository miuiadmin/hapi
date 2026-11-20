package run.hapi.web.static

import run.hapi.web.HubUrls

/**
 * Berry shell marker injection (详细日志模式 P0, 研究报告 §9 开放问题 8 已拍板):
 * the web telemetry SDK classifies the device as `berry` when
 * `window.__HAPI_WEB_SHELL__ === true`. Two complementary channels:
 *
 *  1. [StaticResourceInterceptor] injects [MARKER_SCRIPT] into the served
 *     index.html right after `<head>` — the earliest executing script in the
 *     document, ahead of the app bundle;
 *  2. [run.hapi.web.ShellWebViewClient] re-asserts [MARKER_JS] via
 *     evaluateJavascript on every document load — channel 1 only hooks the
 *     network layer, so once the PWA service worker precaches index.html the
 *     interception never runs again and the marker (and the `berry`
 *     classification) would silently vanish.
 *
 * Zero `android.*` imports so it is fully covered by JVM unit tests.
 */
object ShellMarkerInjection {

    /** Raw JS (no <script> wrapper) for evaluateJavascript re-assertion. */
    const val MARKER_JS = "window.__HAPI_WEB_SHELL__=true;"
    const val MARKER_SCRIPT = "<script>$MARKER_JS</script>"
    private val MARKER_PROBE = "__HAPI_WEB_SHELL__"

    /** Idempotent: html already carrying the marker is returned unchanged. */
    fun injectIntoIndexHtml(html: String): String {
        if (html.contains(MARKER_PROBE)) return html
        val headOpen = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html) ?: return "$MARKER_SCRIPT$html"
        return html.substring(0, headOpen.range.last + 1) + MARKER_SCRIPT + html.substring(headOpen.range.last + 1)
    }

    /**
     * Whether the evaluateJavascript re-assertion applies to this document
     * load: only same-origin http(s) navigations of the hub (the WebView also
     * shows about:blank / error pages; foreign pages never load here — they
     * are handed to the system browser — but the guard keeps the marker off
     * anything that is not the hub document anyway).
     */
    fun shouldAssertMarker(url: String?, hubUrl: String): Boolean {
        if (url.isNullOrBlank()) return false
        val scheme = runCatching { java.net.URI(url.trim()).scheme?.lowercase() }.getOrNull()
        if (scheme != "https" && scheme != "http") return false
        return HubUrls.sameOrigin(url, hubUrl)
    }
}

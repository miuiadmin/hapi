package run.hapi.web.static

/**
 * Berry shell marker injection (详细日志模式 P0, 研究报告 §9 开放问题 8 已拍板):
 * the web telemetry SDK classifies the device as `berry` when
 * `window.__HAPI_WEB_SHELL__ === true`. The marker is injected into the served
 * index.html right after `<head>` — the earliest executing script in the
 * document, ahead of the app bundle — by [StaticResourceInterceptor] whenever
 * the document comes from the OTA or bundled layer.
 *
 * Zero `android.*` imports so it is fully covered by JVM unit tests.
 */
object ShellMarkerInjection {

    const val MARKER_SCRIPT = "<script>window.__HAPI_WEB_SHELL__=true;</script>"
    private val MARKER_PROBE = "__HAPI_WEB_SHELL__"

    /** Idempotent: html already carrying the marker is returned unchanged. */
    fun injectIntoIndexHtml(html: String): String {
        if (html.contains(MARKER_PROBE)) return html
        val headOpen = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html) ?: return "$MARKER_SCRIPT$html"
        return html.substring(0, headOpen.range.last + 1) + MARKER_SCRIPT + html.substring(headOpen.range.last + 1)
    }
}

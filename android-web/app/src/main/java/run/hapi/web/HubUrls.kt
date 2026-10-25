package run.hapi.web

import java.net.URI
import java.net.URLEncoder

/**
 * Pure-JVM hub URL helpers for the web shell.
 *
 * Deliberately free of any `android.*` imports so the whole surface runs in
 * plain JVM unit tests (`testDebugUnitTest`). Parsing uses [java.net.URI],
 * which is available on-device from API 1.
 *
 * Normalization contract:
 *  - scheme must be `https` (compared case-insensitively) — the manifest also
 *    pins `android:usesCleartextTraffic="false"`, so http hubs are dead on arrival;
 *  - host is lowercased (DNS names are case-insensitive), path case is preserved;
 *  - an explicitly typed port is always preserved (`:8443` stays, `:443` stays);
 *  - trailing slashes on the path are stripped;
 *  - a fragment is dropped (client-side only); a query string is rejected
 *    (a hub base URL never carries one — silently dropping it would hide typos);
 *  - userinfo is rejected.
 */
object HubUrls {

    /** Returns the normalized hub base URL, or null when the input is unusable. */
    fun normalizeHubUrl(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != SCHEME_HTTPS) return null
        if (uri.userInfo != null) return null
        if (uri.rawQuery != null) return null
        val host = uri.host?.lowercase() ?: return null
        if (host.isEmpty()) return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        val path = (uri.path ?: "").trimEnd('/')
        return "$scheme://$host$port$path"
    }

    /**
     * Builds the WebView boot URL: the hub origin itself plus the `hub` and
     * (only when a token is present) `token` URL parameters that the web app
     * consumes for auto-login. The token lands in per-origin localStorage via
     * the web app — it must never be re-loadable from history (MainActivity
     * clears it right after [android.webkit.WebView.loadUrl]).
     *
     * @throws IllegalArgumentException when [hubUrl] does not normalize.
     */
    fun buildBootUrl(hubUrl: String, token: String?): String {
        val base = normalizeHubUrl(hubUrl)
            ?: throw IllegalArgumentException("invalid hub url: $hubUrl")
        val sb = StringBuilder(base)
        sb.append("/?hub=").append(percentEncode(base))
        val jwt = token?.trim().orEmpty()
        if (jwt.isNotEmpty()) {
            sb.append("&token=").append(percentEncode(jwt))
        }
        return sb.toString()
    }

    /**
     * `scheme://host[:port]` with default ports folded away (https:443, http:80),
     * or null when the input is not an http(s) URL. Used for the external-link
     * gate: any navigation whose origin differs from the hub origin leaves the
     * shell for the system browser.
     */
    fun originOf(url: String): String? {
        val uri = runCatching { URI(url.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != SCHEME_HTTPS && scheme != "http") return null
        val host = uri.host?.lowercase() ?: return null
        if (host.isEmpty()) return null
        val port = when {
            uri.port == -1 -> ""
            scheme == SCHEME_HTTPS && uri.port == 443 -> ""
            scheme == "http" && uri.port == 80 -> ""
            else -> ":${uri.port}"
        }
        return "$scheme://$host$port"
    }

    /** True when [url] shares scheme/host/port with [other]. */
    fun sameOrigin(url: String, other: String): Boolean {
        val a = originOf(url) ?: return false
        val b = originOf(other) ?: return false
        return a == b
    }

    /**
     * RFC 3986 query percent-encoding (form-style `+` for spaces replaced with
     * `%20`), so the values survive `URLSearchParams` decoding on the web side.
     */
    fun percentEncode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private const val SCHEME_HTTPS = "https"
}

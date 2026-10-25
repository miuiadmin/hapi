package run.hapi.web.static

import android.content.Context
import java.io.InputStream
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Bundled fallback layer: the dist packed into the APK by the
 * `syncWebDist`/`generateWebDistManifest` gradle tasks. The path set comes
 * from `assets/webdist-manifest.json` (the generated dist listing) — the
 * restricted enumeration for this layer; `sw.js` is deliberately NOT in it
 * (see the gradle task) so the service worker always comes from the network
 * or the OTA dir, never from a stale bundle.
 */
class BundledAssetSource(private val context: Context) : StaticLayerSource {

    @Volatile
    private var paths: Set<String>? = null

    override fun available(): Set<String> = paths ?: load()

    override fun open(rel: String): InputStream? {
        if (rel !in available()) return null
        // rel is guaranteed to be one of the enumerated manifest entries.
        return runCatching { context.assets.open("$ASSET_PREFIX/$rel") }.getOrNull()
    }

    @Synchronized
    private fun load(): Set<String> {
        paths?.let { return it }
        val parsed = runCatching { parseManifest() }.getOrDefault(emptySet())
        paths = parsed
        return parsed
    }

    private fun parseManifest(): Set<String> {
        context.assets.open(MANIFEST_ASSET).bufferedReader(Charsets.UTF_8).use { reader ->
            val text = reader.readText()
            val arrayStart = text.indexOf('[')
            val arrayEnd = text.lastIndexOf(']')
            require(arrayStart >= 0 && arrayEnd > arrayStart) { "malformed webdist manifest" }
            // Manifest is self-generated (plain relative ASCII paths, escaped
            // per JSON) — a simple string-literal scan is exact here.
            return Regex("\"((?:[^\"\\\\]|\\\\.)*)\"")
                .findAll(text.substring(arrayStart, arrayEnd))
                .map { it.groupValues[1].replace("\\\"", "\"").replace("\\\\", "\\") }
                .toSet()
        }
    }

    private companion object {
        const val ASSET_PREFIX = "webdist"
        const val MANIFEST_ASSET = "webdist-manifest.json"
    }
}

/** Production [HttpFetch] — shared client, per-call timeouts. */
class OkHttpFetcher : HttpFetch {

    private val client =
        OkHttpClient.Builder()
            .cache(null)
            .followRedirects(true)
            .build()

    override fun get(url: String, timeoutMs: Long): ByteArray? =
        try {
            val request =
                Request.Builder()
                    .url(url)
                    // Hub frontends behind Cloudflare challenge the default
                    // okhttp UA; identify as the shell.
                    .header("User-Agent", USER_AGENT)
                    .build()
            client.newBuilder()
                .callTimeout(java.time.Duration.ofMillis(timeoutMs))
                .connectTimeout(java.time.Duration.ofMillis(timeoutMs))
                .readTimeout(java.time.Duration.ofMillis(timeoutMs))
                .build()
                .newCall(request)
                .execute()
                .use { response ->
                    if (response.isSuccessful) response.body?.bytes() else null
                }
        } catch (_: Exception) {
            null
        }

    private companion object {
        const val USER_AGENT = "hapi-web-shell/1.0 (+android)"
    }
}

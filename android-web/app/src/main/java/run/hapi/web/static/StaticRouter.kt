package run.hapi.web.static

import java.io.InputStream

/**
 * One locally servable static layer (OTA dir / bundled assets).
 *
 * `available()` is a **restricted enumeration**: the complete set of relative
 * paths the layer can serve right now. Lookups are set-membership checks
 * against it; `open()` is therefore only ever called with a path that came
 * out of the enumeration — never an arbitrary string that gets concatenated
 * into a filesystem/asset path.
 */
interface StaticLayerSource {

    /** Every relative path this layer currently holds (cheap; cache impls). */
    fun available(): Set<String>

    /** Opens a path previously confirmed via [available]; null when gone. */
    fun open(rel: String): InputStream?
}

/**
 * Pure three-layer routing decision for a single request path:
 *
 *  1. whitelist gate — only paths that are (a) in the bundled dist manifest,
 *     (b) in the runtime constant set, or (c) present in the current OTA
 *     version dir are considered static surface at all. Everything else —
 *     every `/api/...`, SSE, socket.io, upload — resolves to null and the
 *     WebView sends it to the network untouched;
 *  2. layer order — OTA current version > bundled assets > network.
 *
 * (c) deliberately extends the whitelist beyond the bundled manifest: a hot
 * update typically renames content-hashed assets (`assets/index-<hash>.js`)
 * that exist ONLY in the OTA dir; without (c) those would always fall to the
 * network and the OTA layer could never actually serve an update. The OTA
 * dir only ever contains files enumerated from the hub's own sw.js precache
 * manifest, so (c) can never whitelist an API path.
 */
class StaticRouter(
    private val otaLayer: StaticLayerSource,
    private val bundledLayer: StaticLayerSource,
) {

    enum class Layer { OTA, BUNDLED }

    data class LocalHit(val rel: String, val layer: Layer)

    /**
     * Resolves an already-percent-decoded request path to a local hit, or
     * null when the request must go to the network (not whitelisted, unsafe,
     * or whitelisted but no local copy — e.g. `/sw.js`, which is always
     * fetched fresh from the hub).
     */
    fun resolveLocal(decodedPath: String): LocalHit? {
        val rel = StaticPath.normalize(decodedPath) ?: return null
        if (!isWhitelisted(rel)) return null
        return when {
            rel in otaLayer.available() -> LocalHit(rel, Layer.OTA)
            rel in bundledLayer.available() -> LocalHit(rel, Layer.BUNDLED)
            else -> null // whitelisted constant with no local copy → network
        }
    }

    /** Whitelist predicate (unit-tested): constants ∪ bundled ∪ OTA content. */
    fun isWhitelisted(rel: String): Boolean =
        rel in StaticPath.CONSTANT_RELS ||
            rel in bundledLayer.available() ||
            rel in otaLayer.available()
}

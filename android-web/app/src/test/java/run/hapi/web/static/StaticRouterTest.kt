package run.hapi.web.static

import java.io.InputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Whitelist judgment + three-layer precedence. */
class StaticRouterTest {

    /** In-memory layer: membership is exactly what the enumeration says. */
    private class FakeLayer(private val files: Map<String, ByteArray>) : StaticLayerSource {
        override fun available(): Set<String> = files.keys

        override fun open(rel: String): InputStream? =
            files[rel]?.let { it.inputStream() }
    }

    private val bundled =
        FakeLayer(
            mapOf(
                "index.html" to "<html>bundled</html>".toByteArray(),
                // NOTE: no "sw.js" here — the generated asset manifest excludes
                // it on purpose so the SW always comes from OTA/network.
                "manifest.webmanifest" to "{}".toByteArray(),
                "404.html" to "404".toByteArray(),
                "assets/index-abc.js" to "bundled-js".toByteArray(),
                "assets/fonts/KaTeX_Main-Regular.ttf" to ByteArray(4),
            ),
        )

    private val router = StaticRouter(otaLayer = FakeLayer(emptyMap()), bundledLayer = bundled)

    @Test
    fun apiPathsAreNeverIntercepted() {
        assertNull(router.resolveLocal("/api/sessions"))
        assertNull(router.resolveLocal("/api/machines/abc/messages"))
        assertNull(router.resolveLocal("/cli/sessions/1/events")) // SSE
        assertNull(router.resolveLocal("/socket.io/?EIO=4&transport=polling"))
        assertNull(router.resolveLocal("/api/anything?x=1"))
        assertFalse(router.isWhitelisted("api/sessions"))
    }

    @Test
    fun bundledAssetsAreServedFromTheBundledLayer() {
        val hit = router.resolveLocal("/assets/index-abc.js")
        assertEquals(StaticRouter.Layer.BUNDLED, hit?.layer)
        assertEquals("assets/index-abc.js", hit?.rel)
        assertEquals(StaticRouter.Layer.BUNDLED, router.resolveLocal("/404.html")?.layer)
        assertEquals(
            StaticRouter.Layer.BUNDLED,
            router.resolveLocal("/assets/fonts/KaTeX_Main-Regular.ttf")?.layer,
        )
    }

    @Test
    fun rootMapsToIndexHtml() {
        val hit = router.resolveLocal("/")
        assertEquals(StaticPath.INDEX_HTML, hit?.rel)
        assertEquals(StaticRouter.Layer.BUNDLED, hit?.layer)
    }

    @Test
    fun hashedAssetsMissingEverywhereFallToNetwork() {
        assertNull(router.resolveLocal("/assets/index-doesnotexist.js"))
    }

    @Test
    fun swJsIsWhitelistedButNotServedFromTheBundle() {
        // sw.js is a whitelist constant (so the OTA layer may serve it), but
        // the bundled manifest excludes it deliberately: with no OTA copy the
        // resolution must fall through to the network.
        assertTrue(router.isWhitelisted("sw.js"))
        assertNull(router.resolveLocal("/sw.js"))
    }

    @Test
    fun otaLayerWinsOverBundled() {
        val ota =
            FakeLayer(
                mapOf(
                    "index.html" to "<html>ota</html>".toByteArray(),
                    "assets/index-NEW.js" to "ota-js".toByteArray(),
                ),
            )
        val r = StaticRouter(otaLayer = ota, bundledLayer = bundled)

        // Same path in both layers → OTA.
        assertEquals(StaticRouter.Layer.OTA, r.resolveLocal("/index.html")?.layer)
        assertEquals(StaticRouter.Layer.OTA, r.resolveLocal("/")?.layer)
        // Path only in OTA → still servable: this is what makes a hot update
        // effective for renamed content-hashed assets.
        val newHit = r.resolveLocal("/assets/index-NEW.js")
        assertEquals(StaticRouter.Layer.OTA, newHit?.layer)
        assertTrue(r.isWhitelisted("assets/index-NEW.js"))
        // Bundled-only path keeps working (fonts etc.).
        assertEquals(
            StaticRouter.Layer.BUNDLED,
            r.resolveLocal("/assets/fonts/KaTeX_Main-Regular.ttf")?.layer,
        )
        // API fencing unchanged.
        assertNull(r.resolveLocal("/api/sessions"))
    }

    @Test
    fun traversalNeverReachesAnyLayer() {
        assertNull(router.resolveLocal("/../assets/index-abc.js"))
        assertNull(router.resolveLocal("/assets/../index.html"))
        assertFalse(router.isWhitelisted("../secrets"))
    }

    @Test
    fun emptyLayersServeNothingButStillWhitelistConstants() {
        val empty = StaticRouter(FakeLayer(emptyMap()), FakeLayer(emptyMap()))
        assertNull(empty.resolveLocal("/index.html"))
        assertNull(empty.resolveLocal("/sw.js"))
        assertTrue(empty.isWhitelisted("index.html"))
        assertTrue(empty.isWhitelisted("manifest.webmanifest"))
        assertFalse(empty.isWhitelisted("api/x"))
    }
}

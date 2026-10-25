package run.hapi.web.static

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Path normalization + traversal safety (the pure core of the interceptor). */
class StaticPathTest {

    @Test
    fun rootAndIndexBothMapToIndexHtml() {
        assertEquals(StaticPath.INDEX_HTML, StaticPath.normalize("/"))
        assertEquals(StaticPath.INDEX_HTML, StaticPath.normalize("/index.html"))
    }

    @Test
    fun plainRelativeAssetsNormalizeToThemselves() {
        assertEquals("assets/index-abc.js", StaticPath.normalize("/assets/index-abc.js"))
        assertEquals("sw.js", StaticPath.normalize("/sw.js"))
        assertEquals(
            "assets/fonts/KaTeX_Main-Regular.ttf",
            StaticPath.normalize("/assets/fonts/KaTeX_Main-Regular.ttf"),
        )
        assertEquals("manifest.webmanifest", StaticPath.normalize("/manifest.webmanifest"))
    }

    @Test
    fun traversalAttacksAreRejected() {
        assertNull(StaticPath.normalize("/../etc/passwd"))
        assertNull(StaticPath.normalize("/assets/../../secrets"))
        assertNull(StaticPath.normalize("/a/./b"))
        assertNull(StaticPath.normalize("/.."))
        // The interceptor feeds already-decoded paths, so an encoded traversal
        // arrives as literal ".."; any stray percent that survives decoding is
        // rejected outright (dist filenames never contain '%').
        assertNull(StaticPath.normalize("/assets/../x"))
        assertNull(StaticPath.normalize("/assets/%2e%2e/x"))
        assertNull(StaticPath.normalize("/assets/a%2fb"))
        // Scheme smuggling / windows-style separators.
        assertNull(StaticPath.normalize("/https://evil.example/x"))
        assertNull(StaticPath.normalize("/assets/a\\b.js"))
        assertNull(StaticPath.normalize("/C:/win/path"))
    }

    @Test
    fun malformedPathsAreRejected() {
        assertNull(StaticPath.normalize("")) // empty
        assertNull(StaticPath.normalize("index.html")) // not rooted
        assertNull(StaticPath.normalize("api/sessions")) // not rooted
        assertNull(StaticPath.normalize("//double"))
        assertNull(StaticPath.normalize("/assets/")) // trailing slash
        assertNull(StaticPath.normalize("/a//b")) // empty inner segment
    }

    @Test
    fun constantsCoverTheShellSurface() {
        // The runtime-constant whitelist normalizes to exactly these rels.
        assertEquals(
            setOf("index.html", "sw.js", "manifest.webmanifest"),
            StaticPath.CONSTANT_RELS,
        )
        assertTrue(StaticPath.normalize("/404.html") != null)
    }
}

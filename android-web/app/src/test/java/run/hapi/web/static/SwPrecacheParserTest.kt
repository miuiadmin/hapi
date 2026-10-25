package run.hapi.web.static

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** sw.js precache-manifest parsing, incl. malformed inputs. */
class SwPrecacheParserTest {

    @Test
    fun parsesWorkboxStyleManifest() {
        // Real shape from web/dist/sw.js (revision first, url second, minified).
        val body =
            """
            import{precacheAndRoute}from"workbox-precaching";
            precacheAndRoute([{"revision":"3a8bbb82","url":"index.html"},
            {"revision":"10bddbf2","url":"icon.svg"},
            {"url":"assets/index-abc.js"},{"url":"assets/fonts/KaTeX_Main-Regular.ttf"},
            {"revision":"b29bee03","url":"404.html"}]);
            """.trimIndent()
        val urls = SwPrecacheParser.parse(body)
        assertEquals(
            listOf(
                "index.html",
                "icon.svg",
                "assets/index-abc.js",
                "assets/fonts/KaTeX_Main-Regular.ttf",
                "404.html",
            ),
            urls,
        )
    }

    @Test
    fun urlFirstKeyOrderAlsoWorks() {
        val urls = SwPrecacheParser.parse("""[{"url":"a.js","revision":"x"},{"url":"b.css"}]""")
        assertEquals(listOf("a.js", "b.css"), urls)
    }

    @Test
    fun duplicatesCollapse() {
        // workbox emits icon entries twice (revisioned + unrevisioned lists).
        val urls = SwPrecacheParser.parse("""[{"url":"m.png"},{"revision":"x","url":"m.png"},{"url":"m.png"}]""")
        assertEquals(listOf("m.png"), urls)
    }

    @Test
    fun unsafeAndAbsoluteEntriesAreDropped() {
        val body =
            """
            [{"url":"/absolute.js"},{"url":"https://evil.example/x.js"},{"url":"../escape.js"},
            {"url":"a/../../b.js"},{"url":"back\\slash.js"},{"url":"query.js?v=1"},
            {"url":"ok.js"},{"url":"also-ok.css"},{"url":"deep/nested/font.woff2"}]
            """.trimIndent()
        assertEquals(
            listOf("ok.js", "also-ok.css", "deep/nested/font.woff2"),
            SwPrecacheParser.parse(body),
        )
    }

    @Test
    fun jsonEscapesAreUnescaped() {
        val body = """[{"url":"space\u0020name.js"},{"url":"quote\"q\".js"}]"""
        val urls = SwPrecacheParser.parse(body)
        assertTrue("space name.js" in urls)
        assertTrue("quote\"q\".js" in urls)
        // An escaped backslash unescapes fine but is then dropped by the
        // safety filter (backslash can never appear in a dist filename).
        val withBackslash = """[{"url":"back\\slash.js"},{"url":"clean.js"}]"""
        val urls2 = SwPrecacheParser.parse(withBackslash)
        assertEquals(listOf("clean.js"), urls2)
    }

    @Test
    fun unknownEscapeDropsOnlyThatEntry() {
        val urls = SwPrecacheParser.parse("""[{"url":"bad\x41.js"},{"url":"good.js"},{"url":"also-good.css"}]""")
        assertEquals(listOf("good.js", "also-good.css"), urls)
    }

    @Test
    fun malformedOrEmptyBodyYieldsEmptyList() {
        assertTrue(SwPrecacheParser.parse("").isEmpty())
        assertTrue(SwPrecacheParser.parse("this is not javascript at all").isEmpty())
        assertTrue(SwPrecacheParser.parse("""{"url":"only-one.js"}""").size == 1)
        assertTrue(SwPrecacheParser.parse("""broken "url":"unterminated…""").isEmpty())
    }

    @Test
    fun realDistShapeFieldsAroundUrlsDoNotConfuseTheParser() {
        // Other sw.js content (e.g. share-target config) mentioning "url":
        // only well-formed, safe, relative entries survive.
        val body =
            """
            const data={"url":"/share-target",method:"POST"};
            precacheAndRoute([{"url":"index.html"},{"url":"sw-noop.js"},{"url":"manifest.webmanifest"}]);
            """.trimIndent()
        assertEquals(
            listOf("index.html", "sw-noop.js", "manifest.webmanifest"),
            SwPrecacheParser.parse(body),
        )
    }
}

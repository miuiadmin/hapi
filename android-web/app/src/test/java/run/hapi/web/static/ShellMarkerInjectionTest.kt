package run.hapi.web.static

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Berry shell marker injection into the served index.html (telemetry P0). */
class ShellMarkerInjectionTest {

    @Test
    fun injectsRightAfterHeadOpenTag() {
        val html = "<!doctype html><html><head><meta charset=\"utf-8\"><script src=\"/assets/app.js\"></script></head><body></body></html>"
        val out = ShellMarkerInjection.injectIntoIndexHtml(html)
        assertTrue(out.startsWith("<!doctype html><html><head>" + ShellMarkerInjection.MARKER_SCRIPT))
        // The rest of the document is untouched.
        assertTrue(out.endsWith("<script src=\"/assets/app.js\"></script></head><body></body></html>"))
        // The marker precedes every other script in the document.
        assertTrue(out.indexOf(ShellMarkerInjection.MARKER_SCRIPT) < out.indexOf("app.js"))
    }

    @Test
    fun handlesHeadWithAttributesAndCase() {
        val html = "<HTML><HEAD lang=\"en\"><title>t</title></HEAD></HTML>"
        val out = ShellMarkerInjection.injectIntoIndexHtml(html)
        assertEquals("<HTML><HEAD lang=\"en\">" + ShellMarkerInjection.MARKER_SCRIPT + "<title>t</title></HEAD></HTML>", out)
    }

    @Test
    fun prependsWhenNoHeadTag() {
        val html = "<div>x</div>"
        assertEquals(ShellMarkerInjection.MARKER_SCRIPT + html, ShellMarkerInjection.injectIntoIndexHtml(html))
    }

    @Test
    fun isIdempotent() {
        val once = ShellMarkerInjection.injectIntoIndexHtml("<head></head>")
        assertEquals(once, ShellMarkerInjection.injectIntoIndexHtml(once))
        assertFalse(once.replaceFirst(ShellMarkerInjection.MARKER_SCRIPT, "").contains(ShellMarkerInjection.MARKER_SCRIPT))
    }
}

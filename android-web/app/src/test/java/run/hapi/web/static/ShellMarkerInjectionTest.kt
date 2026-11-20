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

    @Test
    fun markerScriptEmbedsTheRawEvaluateJavascriptMarker() {
        // Channel 2 (SW-shadowing-proof re-assertion via evaluateJavascript)
        // must set exactly the same flag the interceptor script sets.
        assertTrue(ShellMarkerInjection.MARKER_SCRIPT.contains(ShellMarkerInjection.MARKER_JS))
        assertTrue(ShellMarkerInjection.MARKER_JS.endsWith("__HAPI_WEB_SHELL__=true;"))
    }

    @Test
    fun shouldAssertMarkerOnlyForSameOriginHubDocuments() {
        val hub = "https://hub.example"
        assertTrue(ShellMarkerInjection.shouldAssertMarker("https://hub.example/?hub=x", hub))
        assertTrue(ShellMarkerInjection.shouldAssertMarker("HTTPS://hub.example/sessions/abc?token=t", hub))
        assertTrue(ShellMarkerInjection.shouldAssertMarker("https://hub.example:8443/x", "https://hub.example:8443"))
        // different origin / non-document schemes / blank
        assertFalse(ShellMarkerInjection.shouldAssertMarker("https://other.example/", hub))
        assertFalse(ShellMarkerInjection.shouldAssertMarker("about:blank", hub))
        assertFalse(ShellMarkerInjection.shouldAssertMarker("data:text/html,x", hub))
        assertFalse(ShellMarkerInjection.shouldAssertMarker(null, hub))
        assertFalse(ShellMarkerInjection.shouldAssertMarker("", hub))
    }
}

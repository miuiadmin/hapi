package run.hapi.web

import java.net.URLDecoder
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * JVM tests for the shell's pure URL logic: pairing validation, hub URL
 * normalization (trailing slash / port preservation / host case) and boot URL
 * assembly (token present vs absent, percent-encoding correctness).
 */
class HubUrlsTest {

    // ------------------------------------------------ normalizeHubUrl: gate

    @Test
    fun `rejects non-https schemes`() {
        assertNull(HubUrls.normalizeHubUrl("http://hapi.example.com"))
        assertNull(HubUrls.normalizeHubUrl("http://hapi.example.com:8443"))
        assertNull(HubUrls.normalizeHubUrl("ftp://hapi.example.com"))
    }

    @Test
    fun `rejects scheme-less empty and malformed input`() {
        assertNull(HubUrls.normalizeHubUrl("hapi.example.com")) // bare host, no scheme
        assertNull(HubUrls.normalizeHubUrl("hapi.example.com:8443"))
        assertNull(HubUrls.normalizeHubUrl(""))
        assertNull(HubUrls.normalizeHubUrl("   "))
        assertNull(HubUrls.normalizeHubUrl("https://")) // no host
        assertNull(HubUrls.normalizeHubUrl("https://exa mple.com")) // space -> unparseable
    }

    @Test
    fun `rejects userinfo and query strings`() {
        assertNull(HubUrls.normalizeHubUrl("https://user:pass@hapi.example.com"))
        assertNull(HubUrls.normalizeHubUrl("https://user@hapi.example.com"))
        assertNull(HubUrls.normalizeHubUrl("https://hapi.example.com?a=1"))
    }

    @Test
    fun `rejects malformed port`() {
        assertNull(HubUrls.normalizeHubUrl("https://hapi.example.com:notaport"))
    }

    // ------------------------------------------- normalizeHubUrl: shaping

    @Test
    fun `lowercases scheme and host but preserves path case`() {
        assertEquals(
            "https://hapi.example.com/Sub/Path",
            HubUrls.normalizeHubUrl("HTTPS://HAPI.Example.COM/Sub/Path"),
        )
    }

    @Test
    fun `trims surrounding whitespace`() {
        assertEquals(
            "https://hapi.example.com",
            HubUrls.normalizeHubUrl("   https://hapi.example.com   "),
        )
    }

    @Test
    fun `strips trailing slashes`() {
        assertEquals("https://hapi.example.com", HubUrls.normalizeHubUrl("https://hapi.example.com"))
        assertEquals("https://hapi.example.com", HubUrls.normalizeHubUrl("https://hapi.example.com/"))
        assertEquals("https://hapi.example.com", HubUrls.normalizeHubUrl("https://hapi.example.com///"))
    }

    @Test
    fun `preserves non-default port with and without trailing slash`() {
        assertEquals("https://hapi.example.com:8443", HubUrls.normalizeHubUrl("https://hapi.example.com:8443"))
        assertEquals("https://hapi.example.com:8443", HubUrls.normalizeHubUrl("https://hapi.example.com:8443/"))
    }

    @Test
    fun `keeps explicitly typed default port`() {
        // Port preservation rule: what the user typed survives normalization.
        assertEquals("https://hapi.example.com:443", HubUrls.normalizeHubUrl("https://hapi.example.com:443"))
    }

    @Test
    fun `drops fragment keeps path`() {
        assertEquals(
            "https://hapi.example.com/sub",
            HubUrls.normalizeHubUrl("https://hapi.example.com/sub/#section"),
        )
    }

    // -------------------------------------------------------- buildBootUrl

    @Test
    fun `boot url without token omits token param`() {
        assertEquals(
            "https://hapi.example.com/?hub=https%3A%2F%2Fhapi.example.com",
            HubUrls.buildBootUrl("https://hapi.example.com", null),
        )
    }

    @Test
    fun `boot url with port carries port into both origin and hub param`() {
        assertEquals(
            "https://hapi.example.com:8443/?hub=https%3A%2F%2Fhapi.example.com%3A8443" +
                "&token=eyJabc.eyJdef.sig",
            HubUrls.buildBootUrl("https://hapi.example.com:8443", "eyJabc.eyJdef.sig"),
        )
    }

    @Test
    fun `blank token is treated as absent`() {
        assertEquals(
            HubUrls.buildBootUrl("https://hapi.example.com", null),
            HubUrls.buildBootUrl("https://hapi.example.com", "   "),
        )
    }

    @Test
    fun `unnormalized hub input still boots from its normalized form`() {
        // Users paste "HTTPS://Host/" — boot URL must be built from the
        // normalized value, not the raw paste.
        assertEquals(
            HubUrls.buildBootUrl("https://host.example.com", null),
            HubUrls.buildBootUrl("  HTTPS://Host.example.com/  ", null),
        )
    }

    @Test
    fun `hub param round-trips through URL decoding`() {
        val hub = "https://hapi.example.com:8443"
        val boot = HubUrls.buildBootUrl(hub, null)
        val hubParam = boot.substringAfter("hub=").substringBefore("&")
        assertEquals(hub, URLDecoder.decode(hubParam, "UTF-8"))
    }

    @Test
    fun `token special characters percent-encode and round-trip`() {
        val jwt = "abc+/= def"
        val boot = HubUrls.buildBootUrl("https://hapi.example.com", jwt)
        val tokenParam = boot.substringAfter("&token=")
        assertEquals(jwt, URLDecoder.decode(tokenParam, "UTF-8"))
        // Space must be %20, never the form-style '+' (it would corrupt the
        // literal '+' inside a JWT when the web side decodes).
        assertFalse(tokenParam.contains("+"))
        assertTrue(tokenParam.contains("%2B"))
        assertTrue(tokenParam.contains("%2F"))
        assertTrue(tokenParam.contains("%3D"))
        assertTrue(tokenParam.contains("%20"))
    }

    @Test
    fun `invalid hub url throws from buildBootUrl`() {
        assertFailsWith<IllegalArgumentException> {
            HubUrls.buildBootUrl("http://insecure.example.com", null)
        }
        assertFailsWith<IllegalArgumentException> {
            HubUrls.buildBootUrl("not a url", "tok")
        }
    }

    // ------------------------------------------------------------- origins

    @Test
    fun `same origin matches ignoring host case and path`() {
        assertTrue(HubUrls.sameOrigin("https://hapi.example.com/chat/abc", "https://HAPI.example.com"))
        assertTrue(HubUrls.sameOrigin("https://hapi.example.com:8443/api/v1/sessions", "https://hapi.example.com:8443/"))
    }

    @Test
    fun `different host or port is external`() {
        assertFalse(HubUrls.sameOrigin("https://evil.example.com/", "https://hapi.example.com"))
        assertFalse(HubUrls.sameOrigin("https://hapi.example.com:8443/x", "https://hapi.example.com"))
        assertFalse(HubUrls.sameOrigin("http://hapi.example.com/", "https://hapi.example.com"))
    }

    @Test
    fun `default ports fold for origin comparison`() {
        assertTrue(HubUrls.sameOrigin("https://hapi.example.com:443/chat", "https://hapi.example.com"))
        // :443 is only the default for https — for http it stays a real port.
        assertFalse(HubUrls.sameOrigin("http://hapi.example.com:443/", "http://hapi.example.com/"))
    }

    @Test
    fun `unparseable or non-http url is treated as external`() {
        assertFalse(HubUrls.sameOrigin("javascript:alert(1)", "https://hapi.example.com"))
        assertFalse(HubUrls.sameOrigin("about:blank", "https://hapi.example.com"))
    }

    @Test
    fun `percentEncode uses rfc3986 style`() {
        assertEquals("a%20b%2Fc%3Ad%2Be", HubUrls.percentEncode("a b/c:d+e"))
    }
}

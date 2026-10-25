package run.hapi.web.static

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import run.hapi.web.HubUrls

/**
 * Per-origin OTA namespacing — the cross-hub isolation invariant the
 * adversarial review demanded: the store's on-disk root must be a pure
 * function of the hub ORIGIN (scheme/host/port), stable across rounds,
 * distinct across hubs, and loud on blank input.
 */
class OtaNamespaceTest {

    @Test
    fun `stable for the same origin`() {
        assertEquals(
            otaNamespaceFor("https://hapi.example.com"),
            otaNamespaceFor("https://hapi.example.com"),
        )
    }

    @Test
    fun `same origin with different paths maps to one namespace`() {
        // The shell serves same-origin statics regardless of base path, so
        // two hub URLs sharing an origin must share the OTA cache.
        val a = otaNamespaceFor(HubUrls.originOf("https://h.example.com")!!)
        val b = otaNamespaceFor(HubUrls.originOf("https://h.example.com/hub-base")!!)
        assertEquals(a, b)
    }

    @Test
    fun `distinct hosts, ports and schemes never collide`() {
        val namespaces = setOf(
            otaNamespaceFor("https://a.example.com"),
            otaNamespaceFor("https://b.example.com"),
            otaNamespaceFor("https://a.example.com:8443"),
            otaNamespaceFor("http://a.example.com"),
        )
        assertEquals(4, namespaces.size)
    }

    @Test
    fun `default ports fold to the same namespace as explicit ones`() {
        // Port folding happens in HubUrls.originOf (the production
        // composition); otaNamespaceFor itself hashes the string it is
        // given, so this must be asserted through originOf.
        assertEquals(
            otaNamespaceFor(HubUrls.originOf("https://a.example.com")!!),
            otaNamespaceFor(HubUrls.originOf("https://a.example.com:443")!!),
        )
    }

    @Test
    fun `emits lowercase hex, fixed width`() {
        val ns = otaNamespaceFor("https://hapi.example.com:8443")
        assertEquals(16, ns.length)
        assertTrue(ns.all { it in '0'..'9' || it in 'a'..'f' }, "not lowercase hex: $ns")
    }

    @Test
    fun `blank origin fails loud`() {
        assertFailsWith<IllegalArgumentException> { otaNamespaceFor("") }
        assertFailsWith<IllegalArgumentException> { otaNamespaceFor("   ") }
    }
}

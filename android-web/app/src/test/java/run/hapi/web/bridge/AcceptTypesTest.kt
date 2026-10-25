package run.hapi.web.bridge

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AcceptTypesTest {

    @Test
    fun nullAndEmptyProduceNoFilter() {
        assertEquals(emptyList(), AcceptTypes.toMimeTypes(null))
        assertEquals(emptyList(), AcceptTypes.toMimeTypes(arrayOf()))
        assertEquals(emptyList(), AcceptTypes.toMimeTypes(arrayOf("", "  ")))
    }

    @Test
    fun mimeTokensPassThroughLowercased() {
        assertEquals(
            listOf("image/png"),
            AcceptTypes.toMimeTypes(arrayOf("image/PNG")),
        )
    }

    @Test
    fun wildcardsPassThrough() {
        assertEquals(
            listOf("image/*"),
            AcceptTypes.toMimeTypes(arrayOf("image/*")),
        )
    }

    @Test
    fun commaJoinedStringIsSplit() {
        // WebView frequently hands the whole attribute as one entry.
        assertEquals(
            listOf("image/*", "image/png", "application/pdf"),
            AcceptTypes.toMimeTypes(arrayOf("image/*, image/png ,application/pdf")),
        )
    }

    @Test
    fun extensionsMapToMimeTypes() {
        assertEquals(
            listOf("image/jpeg", "application/pdf"),
            AcceptTypes.toMimeTypes(arrayOf(".jpg", ".pdf")),
        )
    }

    @Test
    fun knownUnknownExtensionsAreDroppedNotPassed() {
        // Unknown extensions must NOT leak raw (".foo" is not a MIME type) —
        // dropping narrows the picker, which is the safe direction.
        assertEquals(emptyList(), AcceptTypes.toMimeTypes(arrayOf(".foo")))
    }

    @Test
    fun bareKnownWordsBecomeWildcards() {
        assertEquals(
            listOf("audio/*"),
            AcceptTypes.toMimeTypes(arrayOf("audio")),
        )
    }

    @Test
    fun unknownTokensAreIgnored() {
        assertTrue(AcceptTypes.toMimeTypes(arrayOf("file_extension")).isEmpty())
    }

    @Test
    fun duplicatesCollapseAndOrderIsPreserved() {
        assertEquals(
            listOf("image/*", "image/png"),
            AcceptTypes.toMimeTypes(arrayOf("image/*", "image/png", "image/*", "image/png")),
        )
    }
}

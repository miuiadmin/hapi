package app.hapi.companion.feature.share

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * JVM tests for the pure share-intent parser (slice A). The Android
 * [SystemShareReader] only unwraps the platform Intent; every tolerance rule
 * lives here and is exercised without Robolectric.
 */
class ShareIntentsTest {
    @Test
    fun `text share parses and seeds`() {
        val share = ShareIntents.parse(ShareIntents.ACTION_SEND, text = "hello world")!!
        assertEquals("hello world", share.seedText())
        assertTrue(share.hasPayload)
    }

    @Test
    fun `subject and text join with a newline like the web seed`() {
        val share = ShareIntents.parse(
            ShareIntents.ACTION_SEND,
            subject = "A title",
            text = "The body",
        )!!
        assertEquals("A title\nThe body", share.seedText())
    }

    @Test
    fun `blank subject and text are dropped from the seed`() {
        val share = ShareIntents.parse(
            ShareIntents.ACTION_SEND,
            subject = "   ",
            text = "\n\t",
            streams = listOf("content://media/external/file/1"),
        )!!
        assertEquals("", share.seedText())
        assertTrue(share.hasPayload) // the URI still carries the share
    }

    @Test
    fun `files only share parses with an empty seed`() {
        val share = ShareIntents.parse(
            ShareIntents.ACTION_SEND,
            streams = listOf("content://media/external/file/7"),
        )!!
        assertEquals("", share.seedText())
        assertEquals(listOf("content://media/external/file/7"), share.streamUris)
    }

    @Test
    fun `send_multiple keeps order and drops blank and duplicate streams`() {
        val share = ShareIntents.parse(
            ShareIntents.ACTION_SEND_MULTIPLE,
            streams = listOf(
                "content://a",
                null,
                "  ",
                "content://b",
                "content://a",
            ),
        )!!
        assertEquals(listOf("content://a", "content://b"), share.streamUris)
    }

    @Test
    fun `empty payload is not ours`() {
        assertNull(ShareIntents.parse(ShareIntents.ACTION_SEND))
        assertNull(ShareIntents.parse(ShareIntents.ACTION_SEND, text = "  ", streams = listOf(" ")))
    }

    @Test
    fun `non-share actions are ignored even with extras`() {
        assertNull(ShareIntents.parse("android.intent.action.VIEW", text = "hello"))
        assertNull(ShareIntents.parse(null, text = "hello"))
    }

    @Test
    fun `isShareAction accepts exactly the two send actions`() {
        assertTrue(ShareIntents.isShareAction(ShareIntents.ACTION_SEND))
        assertTrue(ShareIntents.isShareAction(ShareIntents.ACTION_SEND_MULTIPLE))
        assertFalse(ShareIntents.isShareAction("android.intent.action.MAIN"))
        assertFalse(ShareIntents.isShareAction(null))
    }

    @Test
    fun `permission flag tolerance is structural - parse never sees flags`() {
        // A share missing FLAG_GRANT_READ_URI_PERMISSION parses identically;
        // unreadable URIs surface per file at ingest (Unreadable), never here.
        val share = ShareIntents.parse(ShareIntents.ACTION_SEND, streams = listOf("content://denied/1"))!!
        assertEquals(1, share.streamUris.size)
    }
}

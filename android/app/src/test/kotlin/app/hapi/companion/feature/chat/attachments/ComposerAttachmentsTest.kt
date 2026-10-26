package app.hapi.companion.feature.chat.attachments

import app.hapi.data.api.AttachmentUploadApi
import app.hapi.protocol.wire.DeleteUploadResponse
import app.hapi.protocol.wire.UploadFileResponse
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

private const val SESSION = "sess-att"

/** Scriptable two-method fake for the upload seam. */
private class FakeUploadApi : AttachmentUploadApi {
    class UploadCall(val sessionId: String, val filename: String, val contentBase64: String, val mimeType: String)

    val uploads = MutableStateFlow<List<UploadCall>>(emptyList())
    val deletes = MutableStateFlow<List<String>>(emptyList())

    /** Results consumed per call; empty ⇒ success with a derived path. */
    val results = ArrayDeque<Result<UploadFileResponse>>()

    /** When set, uploads park here until completed (in-flight state tests). */
    var gate: CompletableDeferred<Unit>? = null

    override suspend fun uploadFile(
        sessionId: String,
        filename: String,
        contentBase64: String,
        mimeType: String,
    ): UploadFileResponse {
        uploads.value = uploads.value + UploadCall(sessionId, filename, contentBase64, mimeType)
        gate?.await()
        val scripted = results.removeFirstOrNull()
            ?: Result.success(UploadFileResponse(success = true, path = "/uploads/$filename"))
        return scripted.getOrThrow()
    }

    override suspend fun deleteUpload(sessionId: String, path: String): DeleteUploadResponse {
        deletes.value = deletes.value + path
        return DeleteUploadResponse(success = true)
    }
}

private fun prepared(
    id: String = "att-1",
    filename: String = "shot.jpg",
    mimeType: String = "image/jpeg",
    bytes: ByteArray = byteArrayOf(10, 20, 30),
    previewBytes: ByteArray? = byteArrayOf(1, 2),
) = PreparedAttachment(id = id, filename = filename, mimeType = mimeType, bytes = bytes, previewBytes = previewBytes)

class ComposerAttachmentsTest {

    private fun harness(scope: kotlinx.coroutines.CoroutineScope, api: FakeUploadApi) =
        ComposerAttachments(
            api = api,
            sessionId = SESSION,
            scope = scope,
            detachedCleanupScope = scope,
        )

    @Test
    fun `add uploads immediately with the exact base64 payload and settles Ready`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)

        tray.add(prepared(bytes = byteArrayOf(10, 20, 30)))

        val chip = tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Ready }[0]
        assertEquals("shot.jpg", chip.filename)
        assertEquals(3L, chip.sizeBytes)

        val call = api.uploads.value.single()
        assertEquals(SESSION, call.sessionId)
        assertEquals("shot.jpg", call.filename)
        assertEquals("image/jpeg", call.mimeType)
        assertEquals(Base64.getEncoder().encodeToString(byteArrayOf(10, 20, 30)), call.contentBase64)
        assertTrue(tray.allReady())
    }

    @Test
    fun `consume maps Ready chips to metadata with a preview data URL and clears the tray`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(previewBytes = byteArrayOf(9, 9)))
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Ready }

        val metadata = tray.consume()!!.single()

        assertEquals("att-1", metadata.id)
        assertEquals("shot.jpg", metadata.filename)
        assertEquals("image/jpeg", metadata.mimeType)
        assertEquals(3L, metadata.size)
        assertEquals("/uploads/shot.jpg", metadata.path)
        assertEquals(AttachmentPolicy.dataUrl("image/jpeg", byteArrayOf(9, 9)), metadata.previewUrl)
        assertTrue(tray.items.first { it.isEmpty() }.isEmpty())
        assertNull(tray.consume())
    }

    @Test
    fun `upload failure settles Failed and retry re-uploads to Ready`() = runTest {
        val api = FakeUploadApi()
        api.results += Result.failure(RuntimeException("boom"))
        val tray = harness(backgroundScope, api)

        tray.add(prepared())
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Failed }
        assertTrue(tray.hasUnsettled())

        tray.retry("att-1")
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Ready }
        assertEquals(2, api.uploads.value.size)
        assertEquals(api.uploads.value[0].contentBase64, api.uploads.value[1].contentBase64)
    }

    @Test
    fun `success=false responses settle Failed too`() = runTest {
        val api = FakeUploadApi()
        api.results += Result.success(UploadFileResponse(success = false, error = "disk full"))
        val tray = harness(backgroundScope, api)

        tray.add(prepared())
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Failed }
    }

    @Test
    fun `removing a Ready chip deletes the hub upload best-effort`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared())
        tray.items.first { it.size == 1 && it[0].status == ComposerAttachmentStatus.Ready }

        tray.remove("att-1")

        tray.items.first { it.isEmpty() }
        assertEquals(listOf("/uploads/shot.jpg"), api.deletes.first { it.isNotEmpty() })
    }

    @Test
    fun `removing a chip mid-upload deletes the orphan once the upload lands`() = runTest {
        val api = FakeUploadApi()
        val gate = CompletableDeferred<Unit>()
        api.gate = gate
        val tray = harness(backgroundScope, api)

        tray.add(prepared())
        api.uploads.first { it.isNotEmpty() } // upload started, parked on the gate
        tray.remove("att-1")
        tray.items.first { it.isEmpty() }
        gate.complete(Unit)

        // The late-arriving path is deleted, and the chip never reappears.
        assertEquals(listOf("/uploads/shot.jpg"), api.deletes.first { it.isNotEmpty() })
        assertTrue(tray.items.value.isEmpty())
    }

    @Test
    fun `consume takes only Ready chips and leaves unsettled ones in the tray`() = runTest {
        val api = FakeUploadApi()
        api.results += Result.failure(RuntimeException("boom"))
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "bad", filename = "bad.bin", mimeType = "application/octet-stream", previewBytes = null))
        tray.items.first { list -> list.any { it.status == ComposerAttachmentStatus.Failed } }
        tray.add(prepared(id = "good", filename = "good.jpg"))
        tray.items.first { list -> list.any { it.id == "good" && it.status == ComposerAttachmentStatus.Ready } }

        val metadata = tray.consume()!!

        assertEquals(listOf("good"), metadata.map { it.id })
        assertEquals(listOf("bad"), tray.items.first { it.size == 1 }.map { it.id })
    }

    @Test
    fun `discardAllDetached deletes every uploaded path and empties the tray`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "a", filename = "a.jpg"))
        tray.add(prepared(id = "b", filename = "b.jpg"))
        tray.items.first { list -> list.size == 2 && list.all { it.status == ComposerAttachmentStatus.Ready } }

        tray.discardAllDetached()

        assertEquals(
            setOf("/uploads/a.jpg", "/uploads/b.jpg"),
            api.deletes.first { it.size == 2 }.toSet(),
        )
        // `items` is derived from the entries flow — await the propagation.
        assertTrue(tray.items.first { it.isEmpty() }.isEmpty())
    }

    @Test
    fun `move reorders chips and consume sends metadata in tray order`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "att-a", filename = "a.jpg"))
        tray.add(prepared(id = "att-b", filename = "b.jpg"))
        tray.add(prepared(id = "att-c", filename = "c.jpg"))
        tray.items.first { list -> list.size == 3 && list.all { it.status == ComposerAttachmentStatus.Ready } }

        tray.move(2, 0)

        val order = tray.items.first { list -> list.map { it.id } == listOf("att-c", "att-a", "att-b") }
        assertEquals(listOf("att-c", "att-a", "att-b"), order.map { it.id })
        // Tray order IS the wire order (assistant-runtime.ts orderedAttachments).
        assertEquals(listOf("att-c", "att-a", "att-b"), tray.consume()!!.map { it.id })
    }

    @Test
    fun `move with equal or out-of-bounds indices is a no-op`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "att-a", filename = "a.jpg"))
        tray.add(prepared(id = "att-b", filename = "b.jpg"))
        tray.add(prepared(id = "att-c", filename = "c.jpg"))
        tray.items.first { list -> list.size == 3 && list.all { it.status == ComposerAttachmentStatus.Ready } }

        tray.move(1, 1)
        tray.move(-1, 0)
        tray.move(0, 3)

        assertEquals(listOf("att-a", "att-b", "att-c"), tray.items.value.map { it.id })
        assertEquals(listOf("att-a", "att-b", "att-c"), tray.consume()!!.map { it.id })
    }

    @Test
    fun `move preserves upload state and paths across mixed-status chips`() = runTest {
        val api = FakeUploadApi()
        api.results += Result.failure(RuntimeException("boom"))
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "bad", filename = "bad.bin", mimeType = "application/octet-stream", previewBytes = null))
        tray.items.first { list -> list.any { it.id == "bad" && it.status == ComposerAttachmentStatus.Failed } }
        tray.add(prepared(id = "good-a", filename = "ga.jpg"))
        tray.add(prepared(id = "good-b", filename = "gb.jpg"))
        tray.items.first { list -> list.size == 3 && list.count { it.status == ComposerAttachmentStatus.Ready } == 2 }

        // Drag the last Ready chip ahead of the Failed one.
        tray.move(2, 0)

        // Await items propagation (stateIn pipeline), then check tray order.
        val order = tray.items.first { list -> list.map { it.id } == listOf("good-b", "bad", "good-a") }
        assertEquals(listOf("good-b", "bad", "good-a"), order.map { it.id })
        // Consume takes only the Ready chips, in the new order; the uploaded
        // paths rode along with the moved entry.
        val metadata = tray.consume()!!
        assertEquals(listOf("good-b", "good-a"), metadata.map { it.id })
        assertEquals(listOf("/uploads/gb.jpg", "/uploads/ga.jpg"), metadata.map { it.path })
        assertEquals(listOf("bad"), tray.items.first { list -> list.size == 1 }.map { it.id })
        // Retry still works after the move (bytes rode along with the entry).
        tray.retry("bad")
        tray.items.first { list -> list.size == 1 && list[0].status == ComposerAttachmentStatus.Ready }
        assertEquals(listOf("bad"), tray.consume()!!.map { it.id })
    }

    // ---------------------------------------------------------- drafts v2 --

    @Test
    fun `draftRefs lists only Ready chips and encodes preview data URLs`() = runTest {
        val api = FakeUploadApi()
        api.results += Result.failure(RuntimeException("boom"))
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "bad", filename = "bad.bin", previewBytes = null))
        tray.items.first { list -> list.any { it.status == ComposerAttachmentStatus.Failed } }
        tray.add(prepared(id = "good", filename = "good.jpg", previewBytes = byteArrayOf(9, 9)))
        tray.items.first { list -> list.any { it.id == "good" && it.status == ComposerAttachmentStatus.Ready } }

        val refs = tray.draftRefs()

        assertEquals(listOf("good"), refs.map { it.id })
        assertEquals("/uploads/good.jpg", refs.single().path)
        assertEquals(AttachmentPolicy.dataUrl("image/jpeg", byteArrayOf(9, 9)), refs.single().previewUrl)
        assertTrue(tray.items.value.isNotEmpty(), "draftRefs must not consume the tray")
    }

    @Test
    fun `draftRefs on an empty or all-unsettled tray is empty`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)

        assertTrue(tray.draftRefs().isEmpty())
    }

    @Test
    fun `restoreDraftAttachments appends Ready chips that consume back to the stored path`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)

        tray.restoreDraftAttachments(
            listOf(
                ComposerDraftAttachment(
                    id = "restored", filename = "old.jpg", mimeType = "image/jpeg", sizeBytes = 3,
                    path = "/uploads/old.jpg",
                    previewUrl = AttachmentPolicy.dataUrl("image/jpeg", byteArrayOf(4, 5)),
                )
            )
        )

        val chip = tray.items.first { list -> list.size == 1 }[0]
        assertEquals(ComposerAttachmentStatus.Ready, chip.status)
        assertTrue(chip.previewBytes!!.contentEquals(byteArrayOf(4, 5)))
        assertTrue(tray.allReady())

        // A restored chip is sendable as-is: no re-upload, the stored path rides.
        val metadata = tray.consume()!!.single()
        assertEquals("/uploads/old.jpg", metadata.path)
        assertEquals("old.jpg", metadata.filename)
        assertEquals(3L, metadata.size)
        assertTrue(api.uploads.value.isEmpty(), "restore must not re-upload")
    }

    @Test
    fun `restoreDraftAttachments skips duplicate ids and path-less references`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "dup", filename = "dup.jpg"))
        tray.items.first { list -> list.size == 1 && list[0].status == ComposerAttachmentStatus.Ready }

        tray.restoreDraftAttachments(
            listOf(
                ComposerDraftAttachment("dup", "dup.jpg", "image/jpeg", 3, path = "/uploads/dup.jpg"),
                ComposerDraftAttachment("nopath", "n.jpg", "image/jpeg", 1, path = null),
                ComposerDraftAttachment("fresh", "f.jpg", "image/jpeg", 2, path = "/uploads/f.jpg"),
            )
        )

        val ids = tray.items.first { list -> list.size == 2 }.map { it.id }
        assertEquals(listOf("dup", "fresh"), ids)
        assertEquals(1, api.uploads.value.size, "only the original add uploaded")
    }

    @Test
    fun `discardAllKeepingUploads empties the tray without hub deletes`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "a", filename = "a.jpg"))
        tray.items.first { list -> list.size == 1 && list[0].status == ComposerAttachmentStatus.Ready }

        tray.discardAllKeepingUploads()

        assertTrue(tray.items.first { it.isEmpty() }.isEmpty())
        assertTrue(api.deletes.value.isEmpty(), "the persisted references own the upload now")
    }

    // ------------------------------------------------ scratchlist park (B18b) --

    @Test
    fun `Ready chips retain their bytes as the park-migration source`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "a", filename = "a.jpg", bytes = byteArrayOf(11, 22, 33)))

        tray.items.first { list -> list.isNotEmpty() && list[0].status == ComposerAttachmentStatus.Ready }

        val chips = tray.parkableChips()
        assertEquals(1, chips.size)
        assertEquals("a", chips[0].id)
        assertEquals("a.jpg", chips[0].filename)
        assertEquals("/uploads/a.jpg", chips[0].path)
        assertTrue(chips[0].bytes.contentEquals(byteArrayOf(11, 22, 33)))
    }

    @Test
    fun `parkableChips snapshots Ready chips only and leaves the tray intact`() = runTest {
        val api = FakeUploadApi().apply {
            results.add(Result.success(UploadFileResponse(success = true, path = "/uploads/ok.jpg")))
            results.add(Result.failure(RuntimeException("boom")))
        }
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "ready", filename = "ok.jpg"))
        tray.add(prepared(id = "failed", filename = "bad.jpg"))
        // Both uploads race in parallel: wait for the failure AND the
        // success chip's Ready transition, or the snapshot below can run
        // while "ready" is still Uploading (observed ~1/3 under suite load).
        tray.items.first { list ->
            list.size == 2 &&
                list.any { it.status == ComposerAttachmentStatus.Failed } &&
                list.any { it.id == "ready" && it.status == ComposerAttachmentStatus.Ready }
        }

        val chips = tray.parkableChips()

        assertEquals(listOf("ready"), chips.map { it.id })
        assertEquals(2, tray.items.value.size, "the tray is untouched by the snapshot")
    }

    @Test
    fun `removeParked drops exactly the parked chips and deletes their uploads`() = runTest {
        val api = FakeUploadApi()
        val tray = harness(backgroundScope, api)
        tray.add(prepared(id = "a", filename = "a.jpg"))
        tray.add(prepared(id = "b", filename = "b.jpg"))
        tray.items.first { list -> list.size == 2 && list.all { it.status == ComposerAttachmentStatus.Ready } }
        val parked = tray.parkableChips()

        tray.removeParked(setOf(parked[0].id))

        assertEquals(setOf("/uploads/a.jpg"), api.deletes.first { it.isNotEmpty() }.toSet())
        assertEquals(listOf("b"), tray.items.first { it.size == 1 }.map { it.id })
    }
}

package run.hapi.web.bridge

import kotlin.test.Test
import kotlin.test.assertEquals

class DownloadNamingTest {

    @Test
    fun dispositionFilenameStarWinsAndDecodes() {
        assertEquals(
            "结算单.pdf",
            DownloadNaming.guessFileName(
                url = "https://hub.example/api/files/abc",
                contentDisposition = "attachment; filename*=UTF-8''%E7%BB%93%E7%AE%97%E5%8D%95.pdf",
                mimeType = "application/pdf",
            ),
        )
    }

    @Test
    fun quotedPlainDispositionFilename() {
        assertEquals(
            "report.pdf",
            DownloadNaming.guessFileName(
                url = "https://hub.example/dl?id=1",
                contentDisposition = "attachment; filename=\"report.pdf\"; size=1024",
                mimeType = "application/pdf",
            ),
        )
    }

    @Test
    fun unquotedPlainDispositionFilename() {
        assertEquals(
            "photo.jpg",
            DownloadNaming.guessFileName(
                url = "https://hub.example/dl",
                contentDisposition = "attachment; filename=photo.jpg",
                mimeType = null,
            ),
        )
    }

    @Test
    fun urlLastSegmentFallsBackWhenNoDisposition() {
        assertEquals(
            "avatar.png",
            DownloadNaming.guessFileName(
                url = "https://hub.example/static/img/avatar.png?token=secret#frag",
                contentDisposition = null,
                mimeType = "image/png",
            ),
        )
    }

    @Test
    fun everythingMissingYieldsFallbackWithMimeExtension() {
        assertEquals(
            "downloadfile.png",
            DownloadNaming.guessFileName("https://hub.example/", null, "image/png"),
        )
        assertEquals(
            "downloadfile.bin",
            DownloadNaming.guessFileName(null, null, "application/x-unknown-future"),
        )
        assertEquals(
            "downloadfile.bin",
            DownloadNaming.guessFileName(null, null, null),
        )
    }

    @Test
    fun extensionLessNameGetsMimeExtension() {
        assertEquals(
            "statement.pdf",
            DownloadNaming.guessFileName(
                url = "https://hub.example/dl/statement",
                contentDisposition = null,
                mimeType = "application/pdf",
            ),
        )
    }

    @Test
    fun existingExtensionIsKeptEvenWhenMimeDisagrees() {
        assertEquals(
            "blob.bin",
            DownloadNaming.guessFileName(
                url = "https://hub.example/dl/blob.bin",
                contentDisposition = null,
                mimeType = "image/png",
            ),
        )
    }

    @Test
    fun pathTraversalInDispositionIsSanitized() {
        assertEquals(
            "evil.png",
            DownloadNaming.guessFileName(
                url = "https://hub.example/",
                contentDisposition = "attachment; filename=\"../../evil.png\"",
                mimeType = null,
            ),
        )
    }

    @Test
    fun leadingDotIsNotAnExtension() {
        assertEquals(
            ".hidden.txt",
            DownloadNaming.guessFileName(
                url = "https://hub.example/.hidden",
                contentDisposition = null,
                mimeType = "text/plain",
            ),
        )
    }
}

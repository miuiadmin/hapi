package run.hapi.web.bridge

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DownloadRouterTest {

    @Test
    fun httpUrlGoesToDownloadManagerWithDerivedName() {
        val route = DownloadRouter.decide(
            "https://hub.example/api/files/report?token=x",
            "attachment; filename=report.pdf",
            "application/pdf",
        )
        assertTrue(route is DownloadRouter.Route.Enqueue)
        assertEquals("report.pdf", route.fileName)
        assertEquals("application/pdf", route.mimeType)
    }

    @Test
    fun blankMimeIsNormalizedToNull() {
        val route = DownloadRouter.decide("https://hub.example/dl/thing.zip", null, "  ")
        assertTrue(route is DownloadRouter.Route.Enqueue)
        assertEquals(null, route.mimeType)
        assertEquals("thing.zip", route.fileName)
    }

    @Test
    fun nonHttpSchemesFallBackToSystemView() {
        assertTrue(
            DownloadRouter.decide("blob:https://hub.example/uuid", null, null)
                is DownloadRouter.Route.OpenExternally,
        )
        assertTrue(
            DownloadRouter.decide("data:image/png;base64,AAAA", null, "image/png")
                is DownloadRouter.Route.OpenExternally,
        )
        assertTrue(
            DownloadRouter.decide("about:blank", null, null)
                is DownloadRouter.Route.OpenExternally,
        )
    }

    @Test
    fun emptyOrNullUrlOpensNothing() {
        val route = DownloadRouter.decide(null, null, null)
        assertTrue(route is DownloadRouter.Route.OpenExternally)
        assertEquals("", route.url)
    }

    @Test
    fun schemeIsCaseInsensitive() {
        assertTrue(
            DownloadRouter.decide("HTTPS://hub.example/f.bin", null, null)
                is DownloadRouter.Route.Enqueue,
        )
    }
}

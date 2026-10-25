package run.hapi.web.bridge

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WebPermissionGateTest {

    @Test
    fun audioCaptureMapsToRecordAudio() {
        val decision = WebPermissionGate.decide(arrayOf(WebPermissionGate.RESOURCE_AUDIO_CAPTURE))
        assertEquals(
            WebPermissionGate.Decision.Grant(
                listOf(WebPermissionGate.RESOURCE_AUDIO_CAPTURE),
                listOf(WebPermissionGate.PERMISSION_RECORD_AUDIO),
            ),
            decision,
        )
    }

    @Test
    fun videoCaptureMapsToCamera() {
        val decision = WebPermissionGate.decide(arrayOf(WebPermissionGate.RESOURCE_VIDEO_CAPTURE))
        assertEquals(
            WebPermissionGate.Decision.Grant(
                listOf(WebPermissionGate.RESOURCE_VIDEO_CAPTURE),
                listOf(WebPermissionGate.PERMISSION_CAMERA),
            ),
            decision,
        )
    }

    @Test
    fun combinedCaptureNeedsBothRuntimePermissions() {
        val decision = WebPermissionGate.decide(
            arrayOf(
                WebPermissionGate.RESOURCE_AUDIO_CAPTURE,
                WebPermissionGate.RESOURCE_VIDEO_CAPTURE,
            ),
        )
        assertEquals(
            WebPermissionGate.Decision.Grant(
                listOf(
                    WebPermissionGate.RESOURCE_AUDIO_CAPTURE,
                    WebPermissionGate.RESOURCE_VIDEO_CAPTURE,
                ),
                listOf(
                    WebPermissionGate.PERMISSION_RECORD_AUDIO,
                    WebPermissionGate.PERMISSION_CAMERA,
                ),
            ),
            decision,
        )
    }

    @Test
    fun anyUnsupportedResourceDeniesTheWholeRequest() {
        assertEquals(
            WebPermissionGate.Decision.Deny,
            WebPermissionGate.decide(
                arrayOf(WebPermissionGate.RESOURCE_AUDIO_CAPTURE, "midi_sysex"),
            ),
        )
        assertEquals(
            WebPermissionGate.Decision.Deny,
            WebPermissionGate.decide(arrayOf("protected_media_id")),
        )
        assertEquals(
            WebPermissionGate.Decision.Deny,
            WebPermissionGate.decide(arrayOf("something_new_in_2031")),
        )
    }

    @Test
    fun emptyRequestIsDenied() {
        assertEquals(WebPermissionGate.Decision.Deny, WebPermissionGate.decide(arrayOf()))
    }

    @Test
    fun duplicateResourcesCollapse() {
        val decision = WebPermissionGate.decide(
            arrayOf(
                WebPermissionGate.RESOURCE_AUDIO_CAPTURE,
                WebPermissionGate.RESOURCE_AUDIO_CAPTURE,
            ),
        )
        assertTrue(decision is WebPermissionGate.Decision.Grant)
        assertEquals(1, decision.resources.size)
        assertEquals(1, decision.runtimePermissions.size)
    }
}

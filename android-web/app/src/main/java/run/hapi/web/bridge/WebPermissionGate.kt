package run.hapi.web.bridge

/**
 * Pure allow-list gate for WebView
 * [android.webkit.WebChromeClient.onPermissionRequest] resource requests.
 *
 * Policy (fixed by the shell's architecture): only getUserMedia capture is
 * ever granted — `audio_capture` (RECORD_AUDIO) and `video_capture` (CAMERA).
 * A request containing ANY other resource (midi_sysex, protected_media_id,
 * future ones) is denied in full; partial grants of unknown resources are not
 * attempted.
 *
 * Runtime permissions are NOT checked here — the caller asks the OS first and
 * only then grants the web request for the resources that were actually
 * allowed by the user.
 *
 * Kept free of android.* classes so it is unit-testable on the JVM.
 */
object WebPermissionGate {

    const val RESOURCE_AUDIO_CAPTURE = "audio_capture"
    const val RESOURCE_VIDEO_CAPTURE = "video_capture"

    const val PERMISSION_RECORD_AUDIO = "android.permission.RECORD_AUDIO"
    const val PERMISSION_CAMERA = "android.permission.CAMERA"

    /** What to do with a [android.webkit.PermissionRequest]. */
    sealed interface Decision {
        /** Deny the whole request (unsupported resource present, or empty). */
        data object Deny : Decision

        /**
         * Provisionally supported: these web resources, needing these runtime
         * permissions. The caller still has to obtain them from the OS.
         */
        data class Grant(val resources: List<String>, val runtimePermissions: List<String>) : Decision
    }

    private val SUPPORTED: Map<String, String> = mapOf(
        RESOURCE_AUDIO_CAPTURE to PERMISSION_RECORD_AUDIO,
        RESOURCE_VIDEO_CAPTURE to PERMISSION_CAMERA,
    )

    fun decide(requestedResources: Array<String>): Decision {
        if (requestedResources.isEmpty()) return Decision.Deny
        val resources = ArrayList<String>(requestedResources.size)
        val permissions = ArrayList<String>(requestedResources.size)
        for (resource in requestedResources) {
            val permission = SUPPORTED[resource] ?: return Decision.Deny
            if (resource !in resources) {
                resources.add(resource)
                permissions.add(permission)
            }
        }
        if (resources.isEmpty()) return Decision.Deny
        return Decision.Grant(resources, permissions)
    }
}

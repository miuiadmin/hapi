package run.hapi.web.bridge

import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.core.content.ContextCompat
import run.hapi.web.R

/**
 * The native bridges every WebView shell needs (the web app inside the hub
 * origin must behave exactly as in a browser):
 *
 *  - **File choosing** — `<input type=file>` is the one capability a WebView
 *    cannot serve on its own. [onShowFileChooser] launches the system
 *    ACTION_GET_CONTENT picker and feeds the picked content URIs back into
 *    the page.
 *  - **getUserMedia** — [onPermissionRequest] allows ONLY audio_capture /
 *    video_capture, after asking for RECORD_AUDIO / CAMERA at runtime;
 *    everything else (midi, protected media, …) is denied.
 *  - **Downloads** — attachment URLs go to the system DownloadManager (or
 *    ACTION_VIEW as a fallback), never swallowed silently.
 *
 * Pure decision logic lives in [AcceptTypes] / [WebPermissionGate] /
 * [DownloadRouter] / [DownloadNaming] (JVM-testable); this class only glues
 * it to Android APIs. MainActivity owns the activity-result launchers —
 * registration must happen before the activity is STARTED.
 */
class ShellBridges(
    private val context: Context,
    private val fileChooserLauncher: ActivityResultLauncher<Intent>,
    private val permissionLauncher: ActivityResultLauncher<Array<String>>,
) {

    /** WebView requires exactly one onReceiveValue per onShowFileChooser. */
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null

    /** One web permission request at a time; superseded/canceled ones are denied. */
    private var pendingPermission: PendingWebPermission? = null

    private class PendingWebPermission(
        val request: PermissionRequest,
        /** (web resource, runtime permission) pairs, in request order. */
        val pairs: List<Pair<String, String>>,
    )

    fun chromeClient(): WebChromeClient = object : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean = this@ShellBridges.onShowFileChooser(filePathCallback, fileChooserParams)

        override fun onPermissionRequest(request: PermissionRequest) {
            this@ShellBridges.onPermissionRequest(request)
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest?) {
            if (request != null) this@ShellBridges.onPermissionRequestCanceled(request)
        }
    }

    fun downloadListener(): DownloadListener = DownloadListener { url, _, contentDisposition, mimeType, _ ->
        routeDownload(url, contentDisposition, mimeType)
    }

    // ------------------------------------------------------------------ files

    internal fun onShowFileChooser(
        filePathCallback: ValueCallback<Array<Uri>>,
        params: FileChooserParams,
    ): Boolean {
        // A second chooser while one is pending: the first callback MUST still
        // fire (WebView keeps a single slot) — cancel it before opening a new one.
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = filePathCallback

        val mimes = AcceptTypes.toMimeTypes(params.acceptTypes)
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            if (mimes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
            if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }
        return try {
            fileChooserLauncher.launch(Intent.createChooser(intent, null))
            true
        } catch (_: ActivityNotFoundException) {
            pendingFileChooser = null
            filePathCallback.onReceiveValue(null)
            false
        }
    }

    /** Delivered by MainActivity's StartActivityForResult launcher. */
    fun onFileChooserResult(result: ActivityResult) {
        val callback = pendingFileChooser ?: return
        pendingFileChooser = null
        if (result.resultCode != Activity.RESULT_OK) {
            callback.onReceiveValue(null)
            return
        }
        callback.onReceiveValue(urisFrom(result.data))
    }

    private fun urisFrom(data: Intent?): Array<Uri>? {
        data ?: return null
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            val uris = ArrayList<Uri>(clip.itemCount)
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i).uri?.let(uris::add)
            }
            if (uris.isNotEmpty()) return uris.toTypedArray()
        }
        return data.data?.let { arrayOf(it) }
    }

    // ------------------------------------------------------------- permissions

    internal fun onPermissionRequest(request: PermissionRequest) {
        when (val decision = WebPermissionGate.decide(request.resources)) {
            WebPermissionGate.Decision.Deny -> request.deny()
            is WebPermissionGate.Decision.Grant -> {
                val pairs = decision.resources.zip(decision.runtimePermissions)
                val missing = pairs.filter { !isRuntimeGranted(it.second) }.map { it.second }
                if (missing.isEmpty()) {
                    request.grant(decision.resources.toTypedArray())
                    return
                }
                // Finalize any superseded request before parking this one.
                pendingPermission?.let { previous ->
                    pendingPermission = null
                    previous.request.deny()
                }
                pendingPermission = PendingWebPermission(request, pairs)
                try {
                    permissionLauncher.launch(missing.toTypedArray())
                } catch (_: ActivityNotFoundException) {
                    pendingPermission = null
                    request.deny()
                }
            }
        }
    }

    internal fun onPermissionRequestCanceled(request: PermissionRequest) {
        val pending = pendingPermission ?: return
        if (pending.request === request) {
            // WebView dropped it; the runtime dialog may still return — make
            // that result a no-op instead of granting a dead request.
            pendingPermission = null
        }
    }

    /** Delivered by MainActivity's RequestMultiplePermissions launcher. */
    fun onRuntimePermissionsResult(grants: Map<String, Boolean>) {
        val pending = pendingPermission ?: return
        pendingPermission = null
        // Absent from the map = not launched = already granted at request time.
        val allGranted = pending.pairs.all { (res, perm) ->
            grants[perm] ?: isRuntimeGranted(perm)
        }
        if (allGranted) {
            pending.request.grant(pending.pairs.map { it.first }.toTypedArray())
        } else {
            pending.request.deny()
        }
    }

    private fun isRuntimeGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    // --------------------------------------------------------------- downloads

    internal fun routeDownload(url: String?, contentDisposition: String?, mimeType: String?) {
        val safeUrl = url?.trim().orEmpty()
        when (val route = DownloadRouter.decide(safeUrl, contentDisposition, mimeType)) {
            is DownloadRouter.Route.Enqueue -> enqueueDownload(safeUrl, route.mimeType, route.fileName)
            is DownloadRouter.Route.OpenExternally -> openExternally(route.url)
        }
    }

    private fun enqueueDownload(url: String, mimeType: String?, fileName: String) {
        try {
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                mimeType?.let(::setMimeType)
                setTitle(fileName)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                // Hub downloads may ride cookie auth; DownloadManager does not
                // see the WebView cookie store, so forward what it needs.
                CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }?.let {
                    addRequestHeader("Cookie", it)
                }
                // Throws SecurityException on API 26–28 without storage
                // permission — caught below, falls back to ACTION_VIEW.
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            }
            val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            manager.enqueue(request)
            Toast.makeText(context, context.getString(R.string.download_started, fileName), Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {
            openExternally(url)
        }
    }

    private fun openExternally(url: String) {
        if (url.isEmpty()) return
        try {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: ActivityNotFoundException) {
            // No handler on this device — nothing else the shell can do.
        }
    }
}

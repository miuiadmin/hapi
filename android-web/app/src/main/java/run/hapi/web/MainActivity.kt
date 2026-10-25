package run.hapi.web

import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.ViewFlipper
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import run.hapi.web.bridge.ShellBridges
import run.hapi.web.static.WebStaticServing

/**
 * Hapi Web shell — a thin, system-UI-only host (no Compose, no Material
 * library) around a full-screen WebView that loads the REAL hub origin.
 *
 * Two screens, switched via a [ViewFlipper]:
 *  1. Pairing (no stored hub): hub URL input (https:// enforced), an optional
 *     collapsed "paste token" field, and a direct-open button. Opening without
 *     a token lets the user log in inside the web app (it has its own login
 *     prompt); pasting a JWT bootstraps auto-login via `?token=`.
 *  2. Web (paired): full-screen WebView, same-origin everything, external
 *     links to the system browser. A small corner "⋮" button clears pairing.
 *
 * Credentials live in [PairingStore] (EncryptedSharedPreferences).
 */
class MainActivity : ComponentActivity() {

    private lateinit var store: PairingStore
    private lateinit var flipper: ViewFlipper
    private lateinit var hubInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var tokenToggle: TextView
    private lateinit var pairingError: TextView
    private lateinit var webContainer: FrameLayout
    private var webView: WebView? = null
    private var webClient: ShellWebViewClient? = null

    /** Native bridges (file chooser / getUserMedia / downloads). */
    private var bridges: ShellBridges? = null

    // Launchers registered at construction (before STARTED, as required).
    // Their callbacks may only ever fire once onCreate has run, by which time
    // [bridges] is set whenever a picker/permission dialog could be open.
    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            bridges?.onFileChooserResult(result)
        }
    private val runtimePermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            bridges?.onRuntimePermissionsResult(grants)
        }

    /** OTA + bundled static serving for the currently paired hub. */
    private val servingScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var staticServing: WebStaticServing? = null
    private var servingHub: String? = null

    /** System back: in-web history first, default (finish) otherwise. */
    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val view = webView
            if (flipper.displayedChild == SCREEN_WEB && view != null && view.canGoBack()) {
                view.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed() // fall through to default
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = PairingStore(this)
        setContentView(R.layout.activity_main)

        flipper = findViewById(R.id.flipper)
        hubInput = findViewById(R.id.hub_input)
        tokenInput = findViewById(R.id.token_input)
        tokenToggle = findViewById(R.id.token_toggle)
        pairingError = findViewById(R.id.pairing_error)
        webContainer = findViewById(R.id.web_container)

        findViewById<View>(R.id.btn_open).setOnClickListener { tryOpenHub() }
        findViewById<View>(R.id.btn_settings).setOnClickListener { confirmUnpair() }
        tokenToggle.setOnClickListener { toggleTokenInput() }
        hubInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                tryOpenHub()
                true
            } else {
                false
            }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)

        if (store.hubUrl() != null) showWeb() else showPairing()
    }

    override fun onPause() {
        super.onPause()
        webView?.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    override fun onDestroy() {
        servingScope.cancel()
        destroyWebView()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- screen

    private fun showPairing() {
        flipper.displayedChild = SCREEN_PAIRING
    }

    private fun showWeb() {
        val hub = store.hubUrl() ?: return showPairing()
        val view = ensureWebView(hub)
        // Three-layer static serving (OTA > bundled > network) for this hub —
        // attach before the first load, then run one OTA round (silent).
        if (servingHub != hub) {
            servingHub = hub
            staticServing = WebStaticServing(this, hub).also { serving ->
                webClient?.staticResolver = serving.resolver
                serving.launchHotUpdate(servingScope) // app start / post-pairing round
            }
        }
        val bootUrl = HubUrls.buildBootUrl(hub, store.accessToken())
        webClient?.armHistoryClear()
        view.loadUrl(bootUrl)
        // Token-in-history guard, first half: clear immediately, and the client
        // clears once more when the ?token= page actually commits.
        view.clearHistory()
        flipper.displayedChild = SCREEN_WEB
    }

    private fun ensureWebView(hubUrl: String): WebView {
        webView?.let { return it }
        val view = WebView(this)
        view.settings.apply {
            javaScriptEnabled = true
            // Per-origin localStorage — the web app keeps its auth/session here;
            // the shell must not starve it.
            domStorageEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        view.setBackgroundColor(Color.WHITE)
        val client = ShellWebViewClient(this, hubUrl)
        view.webViewClient = client
        val bridge = ShellBridges(this, fileChooserLauncher, runtimePermissionLauncher)
        view.webChromeClient = bridge.chromeClient()
        view.setDownloadListener(bridge.downloadListener())
        webClient = client
        bridges = bridge
        webContainer.addView(
            view,
            0,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        webView = view
        return view
    }

    private fun destroyWebView() {
        val view = webView ?: return
        view.stopLoading()
        webContainer.removeView(view)
        view.destroy()
        webView = null
        webClient = null
        bridges = null
    }

    // -------------------------------------------------------------- pairing

    private fun tryOpenHub() {
        val normalized = HubUrls.normalizeHubUrl(hubInput.text.toString())
        if (normalized == null) {
            pairingError.visibility = View.VISIBLE
            return
        }
        pairingError.visibility = View.GONE
        val token = tokenInput.text.toString().trim()
        store.save(normalized, token.takeIf { it.isNotEmpty() })
        showWeb()
    }

    private fun toggleTokenInput() {
        if (tokenInput.visibility == View.VISIBLE) {
            tokenInput.visibility = View.GONE
            tokenToggle.setText(R.string.token_toggle_show)
        } else {
            tokenInput.visibility = View.VISIBLE
            tokenToggle.setText(R.string.token_toggle_hide)
        }
    }

    private fun confirmUnpair() {
        AlertDialog.Builder(this)
            .setTitle(R.string.settings_clear_title)
            .setMessage(R.string.settings_clear_message)
            .setPositiveButton(R.string.settings_clear_confirm) { _, _ -> unpair() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun unpair() {
        val previousHub = store.hubUrl()
        store.clear()
        destroyWebView()
        // The serving stack dies with its WebView. Without this reset, a
        // re-pair to the SAME hub skips the `servingHub != hub` branch in
        // showWeb(): the freshly created client would never get a resolver
        // wired and three-layer static serving would be silently dead.
        staticServing = null
        servingHub = null
        hubInput.setText(previousHub ?: "")
        tokenInput.setText("")
        tokenInput.visibility = View.GONE
        tokenToggle.setText(R.string.token_toggle_show)
        pairingError.visibility = View.GONE
        showPairing()
    }

    private companion object {
        const val SCREEN_PAIRING = 0
        const val SCREEN_WEB = 1
    }
}

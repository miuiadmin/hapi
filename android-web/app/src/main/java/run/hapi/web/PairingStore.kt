@file:Suppress("DEPRECATION") // security-crypto 1.1.0 deprecates the whole surface;
// EncryptedSharedPreferences is the mandated storage here (same pin as android/).

package run.hapi.web

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Pairing credentials at rest, in an [EncryptedSharedPreferences] file.
 *
 * Keys: [KEY_HUB_URL] (normalized hub base URL) and [KEY_ACCESS_TOKEN]
 * (optional hub JWT; when present the boot URL carries `?token=` for the
 * web app's auto-login, after which it lives in per-origin localStorage).
 */
class PairingStore(context: Context) {

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        FILE_NAME,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    /** Normalized hub URL, or null when unpaired. */
    fun hubUrl(): String? = prefs.getString(KEY_HUB_URL, null)?.takeIf { it.isNotBlank() }

    /** Stored JWT, or null when the user chose "log in inside the web app". */
    fun accessToken(): String? =
        prefs.getString(KEY_ACCESS_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun save(hubUrl: String, accessToken: String?) {
        prefs.edit()
            .putString(KEY_HUB_URL, hubUrl)
            .apply {
                if (accessToken.isNullOrBlank()) remove(KEY_ACCESS_TOKEN)
                else putString(KEY_ACCESS_TOKEN, accessToken)
            }
            .apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        const val KEY_HUB_URL = "hub_url"
        const val KEY_ACCESS_TOKEN = "access_token"
        private const val FILE_NAME = "hapi_web_pairing"
    }
}

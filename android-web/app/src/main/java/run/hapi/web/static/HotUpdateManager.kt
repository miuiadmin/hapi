package run.hapi.web.static

import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Blocking HTTP GET seam (OkHttp in production, fake in JVM tests). */
interface HttpFetch {
    /** Body bytes, or null on any non-2xx / IO / timeout failure. */
    fun get(url: String, timeoutMs: Long): ByteArray?
}

/**
 * Filesystem seam for the OTA store (`<filesDir>/web-ota`), fully implemented
 * by the android-side [OtaFileStore] and by an in-temp-dir fake under test.
 */
interface OtaFs {
    fun currentVersion(): String?

    fun hasVersion(version: String): Boolean

    /** Staging dir for a download round (fresh; caller owns its lifetime). */
    fun stagingDir(version: String): File

    /** Deletes every `staging-*` dir — leftovers are garbage (single writer). */
    fun clearStaging()

    /**
     * Atomically publishes the staged tree as `versions/<v>`: rename when the
     * target is absent, no-op-reuse when a previous round already committed
     * it. True on success.
     */
    fun commitStaging(version: String): Boolean

    /** Atomically writes the `current-version` pointer. */
    fun writeCurrentVersion(version: String): Boolean

    fun listVersions(): List<OtaPlan.VersionEntry>

    /** Deletes version dirs not in [keep] and any stray staging dirs. */
    fun prune(keep: Set<String>)
}

/**
 * Atomic OTA hot-update for the bundled web shell.
 *
 * One round (app start + after pairing; 15 s total budget; every failure is
 * silent — the shell keeps serving whatever it already has):
 *
 *  1. `GET <hub>/sw.js` → `version = sha256(body)`;
 *  2. up-to-date check via [OtaPlan.plan];
 *  3. parse the precache manifest ([SwPrecacheParser]); fewer than 3 entries
 *     counts as a broken sw.js → abandon the round (never half-update);
 *  4. download all entries into `staging-<version>/` (4 concurrent, 30 s per
 *     file); ANY failure voids the whole round and the staging dir is wiped;
 *  5. atomic `staging → versions/<version>` rename, atomic current-version
 *     pointer write, prune to the 2 most recent versions.
 *
 * The static interceptor reads `current-version` → `versions/<v>/` on every
 * request; a committed round becomes visible to the next page load without
 * any restart.
 */
class HotUpdateManager(
    private val hubBaseUrl: String,
    private val fetch: HttpFetch,
    private val fs: OtaFs,
) {

    /** Runs one update round. True when the OTA layer is (now) current. */
    suspend fun runOnce(): Boolean =
        withTimeoutOrNull(TOTAL_TIMEOUT_MS) {
            withContext(Dispatchers.IO) { attempt() }
        } ?: false.also {
            // The 15s budget ran out mid-round; drop whatever was staged.
            runCatching { fs.clearStaging() }
        }

    private suspend fun attempt(): Boolean {
        fs.clearStaging()
        val body = fetch.get(swJsUrl, SW_JS_TIMEOUT_MS) ?: return false
        val version = sha256Hex(body)

        return when (OtaPlan.plan(fs.currentVersion(), fs.hasVersion(version), version)) {
            OtaPlan.UpdatePlan.UpToDate -> true
            OtaPlan.UpdatePlan.ReuseExistingVersion -> {
                if (!fs.writeCurrentVersion(version)) return false
                fs.prune(OtaPlan.keepVersions(version, fs.listVersions()))
                true
            }
            OtaPlan.UpdatePlan.Download -> downloadAndPublish(body, version)
        }
    }

    private suspend fun downloadAndPublish(swJsBody: ByteArray, version: String): Boolean {
        val entries = SwPrecacheParser.parse(String(swJsBody, Charsets.UTF_8))
        if (entries.size < MIN_PRECACHE_ENTRIES) return false

        val staging = fs.stagingDir(version)
        staging.mkdirs()
        val allDownloaded = downloadAll(entries, staging)
        if (!allDownloaded) {
            fs.clearStaging()
            return false
        }
        if (!fs.commitStaging(version)) {
            fs.clearStaging()
            return false
        }
        if (!fs.writeCurrentVersion(version)) return false
        fs.prune(OtaPlan.keepVersions(version, fs.listVersions()))
        return true
    }

    private suspend fun downloadAll(entries: List<String>, staging: File): Boolean =
        coroutineScope {
            val gate = Semaphore(DOWNLOAD_CONCURRENCY)
            entries
                .map { rel ->
                    async(Dispatchers.IO) {
                        gate.withPermit {
                            downloadOne(rel, staging)
                        }
                    }
                }
                .all { job -> job.await() }
        }

    private suspend fun downloadOne(rel: String, staging: File): Boolean {
        val bytes =
            withTimeoutOrNull(FILE_TIMEOUT_MS) {
                withContext(Dispatchers.IO) { fetch.get("$hubBaseUrl/$rel", FILE_TIMEOUT_MS) }
            } ?: return false
        val target = File(staging, rel)
        target.parentFile?.mkdirs()
        return runCatching { target.writeBytes(bytes) }.isSuccess
    }

    val swJsUrl: String get() = "$hubBaseUrl/sw.js"

    companion object {
        const val TOTAL_TIMEOUT_MS = 15_000L
        const val SW_JS_TIMEOUT_MS = 15_000L
        const val FILE_TIMEOUT_MS = 30_000L
        const val DOWNLOAD_CONCURRENCY = 4
        const val MIN_PRECACHE_ENTRIES = 3

        fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256")
                .digest(bytes)
                .joinToString("") { String.format(java.util.Locale.ROOT, "%02x", it) }
    }
}

package run.hapi.web.static

import android.content.Context
import java.io.File
import java.io.InputStream

/**
 * Android OTA store: `<filesDir>/web-ota/`
 *
 * ```
 * web-ota/
 *   current-version        # one line: sha256 hex of the sw.js this build came from
 *   versions/<sha256>/…    # published dist trees (immutable once committed)
 *   staging-<sha256>/…     # in-flight downloads; renamed atomically on success
 * ```
 *
 * Implements [OtaFs] for [HotUpdateManager] and [StaticLayerSource] for the
 * interceptor (current version only). Directory listings are snapshotted into
 * a @Volatile set and refreshed after each committed round — the restricted
 * enumeration the router does its membership checks against.
 */
class OtaFileStore(context: Context) : OtaFs, StaticLayerSource {

    private val root: File = File(context.filesDir, ROOT_DIR)
    private val versionsRoot: File = File(root, "versions")
    private val currentVersionFile: File = File(root, "current-version")

    @Volatile
    private var snapshot: Snapshot = Snapshot(null, emptySet())

    // ------------------------------------------------------------ OtaFs side

    override fun currentVersion(): String? = readCurrentVersion()

    override fun hasVersion(version: String): Boolean =
        isHashLike(version) && File(versionsRoot, version).isDirectory

    override fun stagingDir(version: String): File = File(root, "staging-$version")

    override fun clearStaging() {
        root.listFiles { f -> f.name.startsWith("staging-") }
            ?.forEach { it.deleteRecursively() }
    }

    override fun commitStaging(version: String): Boolean {
        if (!isHashLike(version)) return false
        val staging = stagingDir(version)
        val target = File(versionsRoot, version)
        if (target.isDirectory) return true // an earlier round already won
        target.parentFile?.mkdirs()
        if (staging.renameTo(target)) return true
        // renameTo can fail across odd mount states — treat a fully-formed
        // target as success, anything else as a failed round.
        return target.isDirectory.also { if (!it) staging.deleteRecursively() }
    }

    override fun writeCurrentVersion(version: String): Boolean {
        if (!isHashLike(version)) return false
        val tmp = File(root, "current-version.tmp")
        return try {
            tmp.writeText(version)
            if (tmp.renameTo(currentVersionFile)) {
                refresh()
                true
            } else {
                tmp.delete()
                false
            }
        } catch (_: java.io.IOException) {
            false
        }
    }

    override fun listVersions(): List<OtaPlan.VersionEntry> =
        versionsRoot.listFiles { f -> f.isDirectory }
            ?.map { OtaPlan.VersionEntry(it.name, it.lastModified()) }
            ?.sortedBy { it.name }
            .orEmpty()

    override fun prune(keep: Set<String>) {
        versionsRoot.listFiles { f -> f.isDirectory && f.name !in keep }
            ?.forEach { it.deleteRecursively() }
        clearStaging()
        refresh()
    }

    // ------------------------------------------------------ StaticLayerSource

    override fun available(): Set<String> = ensureSnapshot().rels

    override fun open(rel: String): InputStream? {
        val current = ensureSnapshot().version ?: return null
        if (rel !in ensureSnapshot().rels) return null
        val versionDir = File(versionsRoot, current)
        val file = File(versionDir, rel)
        // Defense in depth on top of set-membership: canonical containment.
        val canonFile = file.canonicalFile
        val canonRoot = versionDir.canonicalFile
        if (!canonFile.path.startsWith(canonRoot.path + File.separator)) return null
        if (!canonFile.isFile) return null
        return runCatching { file.inputStream().buffered() }.getOrNull()
    }

    /** Reloads the current-version pointer + its file listing. */
    @Synchronized
    fun refresh() {
        val version = readCurrentVersion()
        snapshot =
            if (version == null) {
                Snapshot(null, emptySet())
            } else {
                val dir = File(versionsRoot, version)
                val rels =
                    if (dir.isDirectory) {
                        dir.walkTopDown()
                            .filter { it.isFile }
                            .map { it.relativeTo(dir).invariantSeparatorsPath }
                            .toSet()
                    } else {
                        emptySet()
                    }
                Snapshot(version, rels)
            }
    }

    @Synchronized
    private fun ensureSnapshot(): Snapshot {
        // Cheap consistency probe: if the pointer changed under us (hot
        // update committed between requests), rescan before answering.
        if (readCurrentVersion() != snapshot.version) refresh()
        return snapshot
    }

    private fun readCurrentVersion(): String? =
        runCatching { currentVersionFile.readText().trim() }.getOrNull()
            ?.takeIf { isHashLike(it) }

    private fun isHashLike(v: String): Boolean =
        v.length == 64 && v.all { it in '0'..'9' || it in 'a'..'f' }

    private data class Snapshot(val version: String?, val rels: Set<String>)

    private companion object {
        const val ROOT_DIR = "web-ota"
    }
}

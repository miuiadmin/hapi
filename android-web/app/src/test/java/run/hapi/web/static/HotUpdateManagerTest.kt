package run.hapi.web.static

import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

/**
 * Full OTA round against fakes: [HttpFetch] is a canned map, [OtaFs] is the
 * same layout as OtaFileStore but rooted in a junit temp dir, so rename/
 * delete semantics are the real filesystem's.
 */
class HotUpdateManagerTest {

    private val tmp: File = Files.createTempDirectory("web-ota-test").toFile()
    private val root = File(tmp, "web-ota").apply { mkdirs() }
    private val versionsRoot = File(root, "versions").apply { mkdirs() }

    private val swBody =
        """
        precacheAndRoute([{"revision":"aaa","url":"index.html"},
        {"url":"assets/app-abc.js"},{"url":"assets/app-abc.css"},
        {"url":"assets/fonts/KaTeX_Main-Regular.ttf"}]);
        """.trimIndent()

    private class FakeFetch(private val routes: Map<String, ByteArray>) : HttpFetch {
        /** Downloaded 4-wide concurrently — must be a synchronized list. */
        val requested = java.util.Collections.synchronizedList(mutableListOf<String>())

        override fun get(url: String, timeoutMs: Long): ByteArray? {
            requested += url
            return routes[url]
        }
    }

    /** Mirrors OtaFileStore's on-disk layout, minus Android Context. */
    private inner class DirOtaFs : OtaFs {
        val pruned = mutableListOf<Set<String>>()

        override fun currentVersion(): String? {
            val f = File(root, "current-version")
            return if (f.isFile) f.readText().trim() else null
        }

        override fun hasVersion(version: String): Boolean = File(versionsRoot, version).isDirectory

        override fun stagingDir(version: String): File = File(root, "staging-$version")

        override fun clearStaging() {
            root.listFiles { f -> f.name.startsWith("staging-") }
                ?.forEach { it.deleteRecursively() }
        }

        override fun commitStaging(version: String): Boolean {
            val staging = stagingDir(version)
            val target = File(versionsRoot, version)
            if (target.isDirectory) return true
            return staging.renameTo(target)
        }

        override fun writeCurrentVersion(version: String): Boolean {
            File(root, "current-version").writeText(version)
            return true
        }

        override fun listVersions(): List<OtaPlan.VersionEntry> =
            versionsRoot.listFiles { f -> f.isDirectory }
                ?.map { OtaPlan.VersionEntry(it.name, it.lastModified()) }
                .orEmpty()

        override fun prune(keep: Set<String>) {
            pruned += keep
            versionsRoot.listFiles { f -> f.isDirectory && f.name !in keep }
                ?.forEach { it.deleteRecursively() }
            clearStaging()
        }
    }

    private fun routesFor(vararg extra: Pair<String, ByteArray>): Map<String, ByteArray> {
        val hub = "https://hub.example"
        val routes = mutableMapOf<String, ByteArray>(
            "$hub/sw.js" to swBody.toByteArray(),
            "$hub/index.html" to "<html/>".toByteArray(),
            "$hub/assets/app-abc.js" to "js".toByteArray(),
            "$hub/assets/app-abc.css" to "css".toByteArray(),
            "$hub/assets/fonts/KaTeX_Main-Regular.ttf" to ByteArray(4),
        )
        extra.forEach { (k, v) -> routes[k] = v }
        return routes
    }

    private val hub = "https://hub.example"

    @AfterTest
    fun cleanup() {
        tmp.deleteRecursively()
    }

    @Test
    fun happyPathDownloadsCommitsAndPoints() = runBlocking {
        val fs = DirOtaFs()
        val fetch = FakeFetch(routesFor())
        val manager = HotUpdateManager(hub, fetch, fs)

        assertTrue(manager.runOnce())
        val expectedVersion = HotUpdateManager.sha256Hex(swBody.toByteArray())
        assertEquals(expectedVersion, fs.currentVersion())
        val versionDir = File(versionsRoot, expectedVersion)
        assertTrue(versionDir.isDirectory)
        assertEquals("<html/>", File(versionDir, "index.html").readText())
        assertTrue(File(versionDir, "assets/app-abc.js").isFile)
        assertTrue(File(versionDir, "assets/fonts/KaTeX_Main-Regular.ttf").isFile)
        // Staging is gone after the atomic rename.
        assertFalse(File(root, "staging-$expectedVersion").exists())
        // Exactly sw.js + 4 precache entries fetched, nothing else.
        assertEquals(5, fetch.requested.size)
        // sw.js itself is not part of the downloaded tree.
        assertFalse(File(versionDir, "sw.js").exists())
    }

    @Test
    fun secondRunWithSameSwJsIsANoop() = runBlocking {
        val fs = DirOtaFs()
        val fetch = FakeFetch(routesFor())
        val manager = HotUpdateManager(hub, fetch, fs)
        assertTrue(manager.runOnce())
        val fetch2 = FakeFetch(routesFor())
        assertTrue(HotUpdateManager(hub, fetch2, fs).runOnce())
        // Only sw.js was requested — no re-download round.
        assertEquals(listOf("$hub/sw.js"), fetch2.requested)
    }

    @Test
    fun tooFewEntriesAbandonsTheRound() = runBlocking {
        // Exactly two well-formed entries: below the >=3 sanity threshold.
        val tiny = """precacheAndRoute([{"url":"index.html"},{"url":"only-two.css"}]);"""
        val fs = DirOtaFs()
        val routes = mapOf("$hub/sw.js" to tiny.toByteArray())
        val manager = HotUpdateManager(hub, FakeFetch(routes), fs)
        assertFalse(manager.runOnce())
        assertEquals(null, fs.currentVersion())
        assertTrue(versionsRoot.listFiles().isNullOrEmpty())
    }

    @Test
    fun missingSwJsFailsSilently() = runBlocking {
        val fs = DirOtaFs()
        assertFalse(HotUpdateManager(hub, FakeFetch(emptyMap()), fs).runOnce())
        assertEquals(null, fs.currentVersion())
    }

    @Test
    fun anyFileFailureVoidsTheRoundAndWipesStaging() = runBlocking {
        val fs = DirOtaFs()
        val routes =
            routesFor().toMutableMap().apply {
                remove("$hub/assets/app-abc.css") // simulate one 404 among 4 files
            }
        assertFalse(HotUpdateManager(hub, FakeFetch(routes), fs).runOnce())
        assertEquals(null, fs.currentVersion())
        assertTrue(versionsRoot.listFiles().isNullOrEmpty())
        assertTrue(root.listFiles { f -> f.name.startsWith("staging-") }.isNullOrEmpty())
    }

    @Test
    fun existingVersionDirIsReusedWithoutDownloading() = runBlocking {
        val fs = DirOtaFs()
        val version = HotUpdateManager.sha256Hex(swBody.toByteArray())
        // A previous round committed the tree but the pointer was lost.
        File(versionsRoot, version).apply {
            mkdirs()
            File(this, "index.html").writeText("<html>old</html>")
        }
        val fetch = FakeFetch(routesFor())
        assertTrue(HotUpdateManager(hub, fetch, fs).runOnce())
        assertEquals(version, fs.currentVersion())
        // Only sw.js was fetched — the round reused the existing dir.
        assertEquals(listOf("$hub/sw.js"), fetch.requested)
        assertEquals("<html>old</html>", File(File(versionsRoot, version), "index.html").readText())
    }

    @Test
    fun pruneKeepsOnlyTwoNewestVersions() = runBlocking {
        val fs = DirOtaFs()
        val old1 = "old1"; val old2 = "old2"; val old3 = "old3"
        listOf(old1, old2, old3).forEachIndexed { i, v ->
            File(versionsRoot, v).apply {
                mkdirs()
                File(this, "index.html").writeText("v$i")
                // Distinct mtimes so "newest" is deterministic.
                setLastModified(1_000_000L * (i + 1))
            }
        }
        assertTrue(HotUpdateManager(hub, FakeFetch(routesFor()), fs).runOnce())
        val current = fs.currentVersion()!!
        val survivors = versionsRoot.listFiles { f -> f.isDirectory }!!.map { it.name }.toSet()
        // current (freshly committed, newest mtime) + the newest old dir survive;
        // the two older pre-existing dirs are pruned.
        assertEquals(setOf(current, old3), survivors)
        assertFalse(old1 in survivors)
        assertFalse(old2 in survivors)
    }
}

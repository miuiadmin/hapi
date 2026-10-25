package run.hapi.web.static

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Version comparison (plan) and retention (prune) logic. */
class OtaPlanTest {

    @Test
    fun planIsUpToDateOnlyWhenPointerAndDirAgree() {
        assertEquals(
            OtaPlan.UpdatePlan.UpToDate,
            OtaPlan.plan(currentVersion = "a", hasVersionDir = true, fetchedVersion = "a"),
        )
    }

    @Test
    fun existingDirWithStalePointerReusesWithoutDownload() {
        assertEquals(
            OtaPlan.UpdatePlan.ReuseExistingVersion,
            OtaPlan.plan(currentVersion = "old", hasVersionDir = true, fetchedVersion = "new"),
        )
    }

    @Test
    fun missingDirAlwaysDownloads() {
        assertEquals(
            OtaPlan.UpdatePlan.Download,
            OtaPlan.plan(currentVersion = null, hasVersionDir = false, fetchedVersion = "new"),
        )
        assertEquals(
            OtaPlan.UpdatePlan.Download,
            OtaPlan.plan(currentVersion = "new", hasVersionDir = false, fetchedVersion = "new"),
        )
    }

    @Test
    fun pruneKeepsCurrentPlusNewestOther() {
        val candidates =
            listOf(
                OtaPlan.VersionEntry("v1", lastModifiedMillis = 100),
                OtaPlan.VersionEntry("v2", lastModifiedMillis = 300),
                OtaPlan.VersionEntry("v3", lastModifiedMillis = 200),
            )
        // Current is the oldest — it must survive anyway; the newest other (v2) fills slot 2.
        val keep = OtaPlan.keepVersions(current = "v1", candidates = candidates)
        assertEquals(setOf("v1", "v2"), keep)
    }

    @Test
    fun pruneWithFewerCandidatesKeepsAll() {
        val keep = OtaPlan.keepVersions(
            current = "only",
            candidates = listOf(OtaPlan.VersionEntry("other", 1)),
            keep = 4,
        )
        assertEquals(setOf("only", "other"), keep)
    }

    @Test
    fun pruneNeverDropsCurrentEvenWhenOldestAndOverKeep() {
        val candidates =
            (1..5).map { OtaPlan.VersionEntry("v$it", lastModifiedMillis = it * 10L) }
        val keep = OtaPlan.keepVersions(current = "v1", candidates = candidates)
        assertEquals(setOf("v1", "v5"), keep)
        assertTrue("v1" in keep)
    }
}

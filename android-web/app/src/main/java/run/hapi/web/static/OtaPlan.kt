package run.hapi.web.static

/**
 * Pure decision logic for the OTA hot-update round (all of it JVM-tested).
 */
object OtaPlan {

    /** What the current round has to do after fetching and hashing sw.js. */
    sealed interface UpdatePlan {
        /** `current-version` == fetched hash and the dir still exists. */
        data object UpToDate : UpdatePlan

        /** Version dir already on disk (earlier round won) — just re-point. */
        data object ReuseExistingVersion : UpdatePlan

        /** Full download round needed. */
        data object Download : UpdatePlan
    }

    /**
     * Version comparison. Note the corrupt-state repair: current == fetched
     * but the dir is missing → Download again instead of silently pointing
     * `current-version` at nothing.
     */
    fun plan(
        currentVersion: String?,
        hasVersionDir: Boolean,
        fetchedVersion: String,
    ): UpdatePlan = when {
        currentVersion == fetchedVersion && hasVersionDir -> UpdatePlan.UpToDate
        hasVersionDir -> UpdatePlan.ReuseExistingVersion
        else -> UpdatePlan.Download
    }

    /** A version directory candidate with its lastModified stamp. */
    data class VersionEntry(val name: String, val lastModifiedMillis: Long)

    /**
     * Pruning selection: always keep the current version, then fill up to
     * [keep] total with the most recently modified others. Callers delete
     * every version dir NOT in the returned set.
     */
    fun keepVersions(
        current: String,
        candidates: Collection<VersionEntry>,
        keep: Int = DEFAULT_KEEP,
    ): Set<String> {
        require(keep >= 1) { "keep must be >= 1 (current version is always kept)" }
        val keepSet = mutableSetOf(current)
        candidates
            .filter { it.name != current && it.name.isNotEmpty() }
            .sortedByDescending { it.lastModifiedMillis }
            .forEach { entry ->
                if (keepSet.size < keep) keepSet += entry.name
            }
        return keepSet
    }

    const val DEFAULT_KEEP = 2
}

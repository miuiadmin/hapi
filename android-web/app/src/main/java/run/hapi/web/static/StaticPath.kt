package run.hapi.web.static

/**
 * Pure path normalization + safety gate for the static-serving layers.
 * Zero `android.*` imports so it is fully covered by JVM unit tests.
 *
 * Contract: the caller feeds in the **already percent-decoded** URL path
 * (android.net.Uri.getPath() decodes; decoding before validating is what
 * makes `%2e%2e` traversals hit the same rejection as literal `..`).
 *
 * Rules:
 *  - must start with `/` (only http(s) URL paths reach this);
 *  - no empty segments (rejects `//` and trailing `/` — dist has no such
 *    paths; they belong to the network layer);
 *  - no `.` / `..` segments, no `\` or `:` anywhere (kills Windows-style and
 *    scheme-smuggling payloads), no control characters;
 *  - `/` and `/index.html` both map to [INDEX_HTML].
 *
 * A path that survives is a plain `a/b/c.ext` relative path that only ever
 * gets looked up in restricted enumerations (sets built from directory
 * listings) — never concatenated blindly into a filesystem path.
 */
object StaticPath {

    const val INDEX_HTML = "index.html"

    /**
     * Runtime-constant whitelist (request paths that are always static shell
     * surface even if a particular dist build forgot them): the document
     * itself, the service worker and the installable manifest.
     */
    val CONSTANT_PATHS = setOf("/", "/index.html", "/sw.js", "/manifest.webmanifest")

    /** Normalizes a decoded request path to a dist-relative path, or null. */
    fun normalize(decodedPath: String): String? {
        if (decodedPath.isEmpty() || decodedPath[0] != '/') return null
        if (decodedPath == "/") return INDEX_HTML // document root — only "/" allowed
        val segments = decodedPath.split('/')
        // segments[0] is "" from the leading slash by construction.
        val out = ArrayList<String>(segments.size - 1)
        for ((index, segment) in segments.withIndex()) {
            if (index == 0) continue
            if (segment.isEmpty()) return null // "//" mid-path or trailing "/"
            if (segment == "." || segment == "..") return null
            if ('\\' in segment || ':' in segment) return null
            if ('%' in segment) return null // decoded input has no escapes left; dist names never contain '%'
            if (segment.any { it.code < 0x20 || it.code == 0x7f }) return null
            out.add(segment)
        }
        val rel = out.joinToString("/")
        return rel.ifEmpty { INDEX_HTML }
    }

    /** The constant whitelist expressed as relative paths (post-normalize). */
    val CONSTANT_RELS: Set<String> =
        CONSTANT_PATHS.mapNotNullTo(mutableSetOf()) { normalize(it) }
}

package run.hapi.web.static

/**
 * Parser for the workbox `sw.js` precache manifest. Pure Kotlin, regex-based
 * per the fixed design: the minified bundle emits entries shaped
 * `{"revision":"<sha1>","url":"assets/index-abc.js"}` (key order varies with
 * the workbox version, so we anchor on `"url":"…"` pairs only).
 *
 * Robustness rules:
 *  - JSON string escapes (`\"`, `\\`, `\/`, `\b\f\n\r\t`, `\uXXXX`) are
 *    unescaped; an invalid escape drops just that entry, not the round;
 *  - entries are validated with the same segment rules as [StaticPath]
 *    (relative only: no leading `/`, no scheme, no `..`) — anything that
 *    survives is safe to turn into a file path component later;
 *  - duplicates are collapsed (workbox emits icon entries twice when
 *    revisioned and unrevisioned lists overlap);
 *  - the caller enforces the minimum-entry threshold (>= 3) — a parse that
 *    yields fewer is treated as a broken/garbage sw.js and the whole OTA
 *    round is abandoned rather than half-updating.
 */
object SwPrecacheParser {

    private val URL_ENTRY = Regex(""""url"\s*:\s*"((?:[^"\\]|\\.)*)"""")

    /** Parses the distinct, safe, relative precache URLs. Empty on garbage. */
    fun parse(swJsBody: String): List<String> {
        val out = LinkedHashSet<String>()
        for (match in URL_ENTRY.findAll(swJsBody)) {
            val raw = match.groupValues[1]
            val url = unescapeJson(raw) ?: continue
            if (isSafeRelativePath(url)) out.add(url)
        }
        return out.toList()
    }

    private fun isSafeRelativePath(url: String): Boolean {
        if (url.isEmpty() || url.startsWith("/")) return false
        if (url.contains('\\') || url.contains(':')) return false // scheme-smuggling / windows paths
        if (url.contains('?') || url.contains('#')) return false
        return url.split('/').all { segment ->
            segment.isNotEmpty() && segment != "." && segment != ".." &&
                segment.none { it.code < 0x20 || it.code == 0x7f }
        }
    }

    /** Returns null when the string contains an escape we do not understand. */
    internal fun unescapeJson(s: String): String? {
        if ('\\' !in s) return s
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c != '\\') {
                sb.append(c)
                i++
                continue
            }
            if (i + 1 >= s.length) return null
            when (val esc = s[i + 1]) {
                '"' -> sb.append('"')
                '\\' -> sb.append('\\')
                '/' -> sb.append('/')
                'b' -> sb.append('\b')
                'f' -> sb.append('\u000C')
                'n' -> sb.append('\n')
                'r' -> sb.append('\r')
                't' -> sb.append('\t')
                'u' -> {
                    if (i + 6 > s.length) return null
                    val hex = s.substring(i + 2, i + 6)
                    val code = hex.toIntOrNull(16) ?: return null
                    sb.append(code.toChar())
                    i += 6
                    continue
                }
                else -> return null // unknown escape → distrust the whole entry
            }
            i += 2
        }
        return sb.toString()
    }
}

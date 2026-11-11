/**
 * Hermes intercepts a REGISTERED slash command inside the prompt text
 * (acp_adapter/gateway_server.py `_slash_command`): leading whitespace is
 * stripped, and when the first whitespace-delimited token is `/name` of a
 * known command, the text NEVER reaches the model — `/clear` wipes the
 * conversation, `/new` starts one, `/undo` rewinds it, `/discard` drops a
 * lost turn, `/branch` forks it. A plain HAPI chat send that merely starts
 * with one of those verbs must not destroy the session by accident.
 *
 * Mirror of hermes's rule (unknown `/words` and paths like `/etc/hosts` are
 * ordinary prompt text), so the guard only fires where hermes itself would
 * intercept. Escaping prefixes a notice line — a leading space would NOT
 * work (hermes lstrips before matching).
 */

/** Verbs hermes executes destructively when they lead a prompt. */
export const HERMES_DESTRUCTIVE_SLASH_VERBS = ['clear', 'new', 'undo', 'discard', 'branch'] as const

/** Documented read-only hermes verbs that stay passthrough (never escaped). */
export const HERMES_PASSTHROUGH_SLASH_VERBS = ['help', 'model', 'queue', 'status', 'usage', 'tools', 'title'] as const

/** The hermes slash verb `text` invokes, or null for ordinary text — mirrors
 * `_slash_command`'s tokenize rule (lstrip → '/name' first token, no second
 * '/'), BEFORE hermes's own registered-command resolution: an unknown verb
 * returns its lowercased name here and callers decide what to do with it. */
export function hermesSlashVerb(text: string): string | null {
    const stripped = text.replace(/^[\s\uFEFF\u00A0]+/, '')
    if (!stripped.startsWith('/')) return null
    const firstToken = stripped.split(/\s+/)[0] ?? ''
    const name = firstToken.slice(1)
    if (!name || name.includes('/')) return null
    return name.toLowerCase()
}

export function isHermesDestructiveSlashVerb(verb: string | null): verb is string {
    return verb !== null && (HERMES_DESTRUCTIVE_SLASH_VERBS as readonly string[]).includes(verb)
}

export type HermesSlashGuardResult = {
    /** The text to echo and send: unchanged for passthrough, prefixed with a
     * notice line when the verb was escaped. */
    text: string
    escaped: boolean
    verb: string | null
}

/**
 * Escape a plain chat send that would otherwise run a destructive hermes
 * verb: the notice line both breaks the leading-`/` interception (hermes
 * lstrips only whitespace, and the text now starts with `[`) and tells the
 * user in the echoed content that hermes verbs must be typed deliberately
 * (i.e. in a native hermes client, not through HAPI).
 */
export function escapeHermesDestructiveSlash(text: string): HermesSlashGuardResult {
    const verb = hermesSlashVerb(text)
    if (!isHermesDestructiveSlashVerb(verb)) {
        return { text, escaped: false, verb }
    }
    const notice = `[Hermes slash guard: /${verb} is a destructive Hermes verb — escaped so it runs as a prompt. Hermes verbs (/clear /new /undo /discard /branch) must be typed deliberately.]`
    return { text: `${notice}\n\n${text}`, escaped: true, verb }
}

import { ApiError } from '@/api/client'

/**
 * Extract a human-readable message from a Reopen failure.
 *
 * The hub returns `{ error, missing: [...] }` on 422 when required metadata
 * is gone (e.g. Cursor session lacks `cursorSessionId`). For other errors the
 * body is `{ error, code? }`. Both shapes are surfaced verbatim; we fall back
 * to the raw `Error.message` when the body is unparseable or absent.
 */
export function formatReopenError(error: unknown): string {
    const fallback = error instanceof Error ? error.message : 'Failed to reopen session'

    const body = error instanceof ApiError ? error.body : undefined
    const source = body ?? extractJsonFromMessage(fallback)
    if (!source) return fallback

    try {
        const parsed = JSON.parse(source) as { error?: string; missing?: string[] }
        if (parsed.error && Array.isArray(parsed.missing) && parsed.missing.length > 0) {
            return `${parsed.error} (missing: ${parsed.missing.join(', ')})`
        }
        if (parsed.error) {
            return parsed.error
        }
    } catch {
        // body was not JSON; fall through
    }
    return fallback
}

/**
 * The hub's own sentence for a failed archive (`{ error, code }` on a 5xx),
 * rather than the HTTP status line the client wraps it in. `null` when there
 * is nothing readable, so the dialog can say "operation failed" instead.
 */
export function formatArchiveError(error: unknown): string | null {
    if (!(error instanceof ApiError)) {
        return error instanceof Error && error.message ? error.message : null
    }
    const body = error.body ?? extractJsonFromMessage(error.message)
    if (body) {
        try {
            const parsed = JSON.parse(body) as { error?: string }
            if (parsed.error) return parsed.error
        } catch {
            // body was not JSON; use the message
        }
    }
    return error.message || null
}

function extractJsonFromMessage(message: string): string | undefined {
    const start = message.indexOf('{')
    return start === -1 ? undefined : message.slice(start)
}

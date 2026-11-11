import type { AcpJsonRpcError } from '@/agent/backends/acp/AcpStdioTransport'

/**
 * Resume-failure classification for the Hermes ACP flavor.
 *
 * Hermes ground truth (hermes-agent source): `session/resume` of a session
 * the gateway no longer knows fails through `GatewayClientError("not_found")`
 * / a `RequestError.invalid_params` response — while a REPLAYING resume that
 * simply has not finished yet must never be mistaken for a dead session. On
 * the hapi side the JSON-RPC rejection carries the code on `error.code` and
 * the bounded gateway reason in `error.data` (the bare message is the
 * generic "Internal error" / "Invalid params").
 */

/**
 * Per-request timeout for hermes `session/resume`. Hermes replays the FULL
 * restored transcript as session/update notifications BEFORE the RPC
 * resolves — unbounded on long histories — so the default 120s transport
 * timeout would kill perfectly healthy resumes of large sessions. Ten
 * minutes covers replaying very long transcripts on a slow gateway.
 */
export const HERMES_RESUME_TIMEOUT_MS = 10 * 60 * 1000

/** Bounded gateway reason codes / message fragments that mean "this session
 * id is dead or unknown to hermes" (GatewayRPCError reason strings: snake
 * codes, no spaces) — plus the invalidParams text form, for servers whose
 * rejections reach hapi as pre-formatted messages without a code field. */
const SESSION_GONE_MARKERS = [
    'not_found',
    'unknown_session',
    'unknown session',
    'session not found',
    'no such session',
    'missing session',
    'session gone',
    'expired session',
    '-32602',
    'invalid params',
    'invalidparams'
]

/** JSON-RPC invalid params: hermes answers a resume it cannot validate with
 * -32602 (RequestError.invalid_params), terminal for this session id. */
const JSON_RPC_INVALID_PARAMS = -32602

function errorText(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

/**
 * Whether a hermes `session/resume` failure means the stored session id is
 * GONE (fork-OK: the only recovery is a brand-new session):
 * - JSON-RPC -32602 invalidParams responses, and
 * - responses/transport errors whose message or error.data carries one of
 *   the gateway's unknown-session reason markers.
 *
 * Everything else (timeouts mid-replay, transport loss, internal errors
 * without a not-found marker) is NOT proof of death: the launcher surfaces
 * the error, keeps the stored hermesSessionId, and retries on a later turn
 * instead of silently forking away from the transcript.
 */
export function isHermesSessionGoneError(error: unknown): boolean {
    const candidate = error as AcpJsonRpcError | null | undefined
    if (!candidate || typeof candidate !== 'object') return false

    if (candidate.code === JSON_RPC_INVALID_PARAMS) {
        return true
    }

    const haystack = `${errorText(candidate.message)} ${errorText(candidate.data)}`.toLowerCase()
    return SESSION_GONE_MARKERS.some((marker) => haystack.includes(marker))
}

/**
 * Whether a hermes resume failure means the server cannot EVER resume (it
 * does not implement `session/resume`): starting a fresh session is the only
 * sensible recovery, so it is fork-OK exactly like a gone session.
 */
export function isHermesResumeUnsupportedError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return /does not advertise session\/resume|method not found/i.test(error.message)
}

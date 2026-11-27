/**
 * Hub client for bots: the item ledger, reply receipts, session tasks and
 * answering another session's pending request.
 *
 * One implementation behind two entry points — MCP `bot_item` / `bot_task`
 * (registered only in a bot's home chat) and the shell commands `hapi item`,
 * `hapi task`, `hapi peer-answer`. Same hub JWT flow as ping-peer
 * (`POST /api/auth` with the CLI access token, scoped to its namespace);
 * callers must not invent parallel auth or arbitrary hosts. HTTP is
 * injectable so every call is testable without a hub.
 */

import axios, { type AxiosInstance } from 'axios'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'

export type BotClientErrorCode =
    | 'bad_args'
    | 'disabled'
    | 'auth_failed'
    | 'forbidden'
    | 'not_found'
    | 'request_failed'

export class BotClientError extends Error {
    readonly code: BotClientErrorCode
    /** Present when the failure came from an HTTP response. */
    readonly httpStatus?: number

    constructor(code: BotClientErrorCode, message: string, httpStatus?: number) {
        super(message)
        this.name = 'BotClientError'
        this.code = code
        if (httpStatus !== undefined) this.httpStatus = httpStatus
    }
}

export const BOT_AUTH_RECOVERY_HINT =
    'On a remote runner, set HAPI_API_URL to the runner hub, and set CLI_API_TOKEN ' +
    'or run `hapi auth login`. Inside a HAPI session prefer the MCP tools, which use ' +
    'the session CLI credentials.'

export function resolveBotApiUrl(apiUrl?: string): string {
    const raw = (apiUrl ?? configuration.apiUrl).trim().replace(/\/+$/, '')
    if (!raw) {
        throw new BotClientError('bad_args', `HAPI API URL is empty. ${BOT_AUTH_RECOVERY_HINT}`)
    }
    // Bot calls only target the configured hub — never a host from tool args.
    return raw
}

export function resolveBotAccessToken(accessToken?: string): string {
    let token = ''
    try {
        token = (accessToken ?? getAuthToken()).trim()
    } catch {
        token = (accessToken ?? '').trim()
    }
    if (!token) {
        throw new BotClientError(
            'bad_args',
            `CLI_API_TOKEN is required (run \`hapi auth login\`). ${BOT_AUTH_RECOVERY_HINT}`
        )
    }
    return token
}

export async function exchangeBotJwt(
    apiUrl: string,
    accessToken: string,
    http: AxiosInstance
): Promise<string> {
    try {
        const response = await http.post(
            `${apiUrl}/api/auth`,
            { accessToken },
            {
                headers: buildHubRequestHeaders({ 'Content-Type': 'application/json' }),
                timeout: 10_000,
                validateStatus: () => true
            }
        )
        const token = typeof response.data?.token === 'string' ? response.data.token : ''
        if (response.status < 200 || response.status >= 300 || !token) {
            const detail = typeof response.data?.error === 'string'
                ? response.data.error
                : `HTTP ${response.status}`
            throw new BotClientError(
                'auth_failed',
                `failed to exchange access token for JWT (${detail}). Hub URL: ${apiUrl}. ${BOT_AUTH_RECOVERY_HINT}`
            )
        }
        return token
    } catch (error) {
        if (error instanceof BotClientError) throw error
        throw new BotClientError(
            'auth_failed',
            `failed to exchange access token for JWT (${error instanceof Error ? error.message : String(error)}). Hub URL: ${apiUrl}. ${BOT_AUTH_RECOVERY_HINT}`
        )
    }
}

export function botAuthHeaders(jwt: string): Record<string, string> {
    return buildHubRequestHeaders({
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json'
    })
}

export type BotClientOptions = {
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    /**
     * Shared auth for one command or tool call: the JWT is exchanged once and
     * reused by every request made with this source. Omitted: one exchange per
     * request.
     */
    auth?: BotAuthSource
}

/** Memoized `resolveBotAuth`: the first `get()` exchanges the JWT, later ones reuse it. */
export type BotAuthSource = { get(): Promise<BotAuthContext> }

export function createBotAuthSource(options: BotClientOptions = {}): BotAuthSource {
    let cached: Promise<BotAuthContext> | undefined
    return {
        get() {
            if (!cached) {
                cached = resolveBotAuth({ ...options, auth: undefined }).catch((error: unknown) => {
                    cached = undefined
                    throw error
                })
            }
            return cached
        }
    }
}

/**
 * True when the hub definitely refused the request: a 4xx answer, or a
 * refusal that never left this process (bad arguments, auth, the peer-tools
 * switch). False for timeouts, network errors, 5xx and malformed answers —
 * the outcome of those is unknown and the request may have been applied.
 */
export function isHubRejection(error: unknown): boolean {
    if (!(error instanceof BotClientError)) return false
    if (error.code === 'bad_args' || error.code === 'disabled' || error.code === 'auth_failed' || error.code === 'forbidden') return true
    return typeof error.httpStatus === 'number' && error.httpStatus >= 400 && error.httpStatus < 500
}

type HubResponse = { status: number; data?: unknown }

export function hubErrorMessage(response: HubResponse): string {
    const data = response.data
    if (typeof data === 'object' && data !== null) {
        const record = data as { error?: unknown; message?: unknown; code?: unknown }
        if (typeof record.error === 'string' && record.error) return record.error
        if (typeof record.message === 'string' && record.message) return record.message
        if (typeof record.code === 'string' && record.code) return record.code
    }
    return `HTTP ${response.status}`
}

/**
 * Wrap an axios instance so a URL starting with `/` is resolved against
 * `apiUrl`. The bot modules write hub routes as `/api/...`; without this the
 * raw axios gets a relative URL and fails with `"/api/..." cannot be parsed as
 * a URL` (seen on a real runner: every `bot_item` / `bot_task` call). Done
 * here, once, so a new call site cannot forget the prefix.
 */
export function withApiUrlPrefix(http: AxiosInstance, apiUrl: string): AxiosInstance {
    const absolutize = (url: unknown): unknown => (typeof url === 'string' && url.startsWith('/') ? `${apiUrl}${url}` : url)
    return new Proxy(http, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver)
            if (typeof value !== 'function') return value
            switch (prop) {
                case 'request':
                    return (config: any) => (value as (config: any) => unknown).call(target, { ...config, url: absolutize(config?.url) })
                case 'get':
                case 'delete':
                case 'head':
                case 'options':
                    return (url: string, config?: unknown) => (value as (...args: unknown[]) => unknown).call(target, absolutize(url), config)
                case 'post':
                case 'put':
                case 'patch':
                    return (url: string, data?: unknown, config?: unknown) => (value as (...args: unknown[]) => unknown).call(target, absolutize(url), data, config)
                default:
                    return value.bind(target)
            }
        }
    }) as AxiosInstance
}

/**
 * Run one authenticated hub request: exchange a JWT, call `request`, and map
 * the status onto `BotClientError`. A 404 maps to `not_found` only when the
 * caller names it (the route exists and the entity is missing); otherwise an
 * unknown route surfaces as `request_failed` with the hub's status.
 */
export async function botRequest<T>(
    options: BotClientOptions,
    params: {
        action: string
        notFoundMessage?: string
        request: (ctx: { apiUrl: string; jwt: string; http: AxiosInstance }) => Promise<HubResponse>
        parse: (data: unknown) => T
    }
): Promise<T> {
    const { apiUrl, jwt, http } = options.auth ? await options.auth.get() : await resolveBotAuth(options)
    let response: HubResponse
    try {
        response = await params.request({ apiUrl, jwt, http })
    } catch (error) {
        throw new BotClientError(
            'request_failed',
            `${params.action} failed: ${error instanceof Error ? error.message : String(error)}`
        )
    }
    const error = botStatusError(params.action, response, params.notFoundMessage)
    if (error) throw error
    return params.parse(response.data)
}

/**
 * Exit codes for the bot shell commands, following the `hapi job` convention:
 * 2 bad arguments (or the peer-tools switch), 3 auth, 4 not found, 5 refused
 * by the hub, 1 anything else.
 */
export function exitCodeForBotClientError(error: BotClientError): number {
    switch (error.code) {
        case 'bad_args':
        case 'disabled':
            return 2
        case 'auth_failed':
            return 3
        case 'not_found':
            return 4
        case 'forbidden':
            return 5
        default:
            return 1
    }
}

export function botErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export type BotAuthContext = { apiUrl: string; jwt: string; http: AxiosInstance }

/**
 * Resolve the hub and exchange one JWT for a flow that needs several calls
 * (the single-call `botRequest` does this internally).
 */
export async function resolveBotAuth(options: BotClientOptions): Promise<BotAuthContext> {
    const http = options.http ?? axios
    const apiUrl = resolveBotApiUrl(options.apiUrl)
    const jwt = await exchangeBotJwt(apiUrl, resolveBotAccessToken(options.accessToken), http)
    return { apiUrl, jwt, http: withApiUrlPrefix(http, apiUrl) }
}

/** Map a non-2xx hub status onto `BotClientError`; null when the call succeeded. */
export function botStatusError(action: string, response: HubResponse, notFoundMessage?: string): BotClientError | null {
    if (response.status >= 200 && response.status < 300) return null
    if (response.status === 401) {
        return new BotClientError('auth_failed', `${action} failed: ${hubErrorMessage(response)}`, response.status)
    }
    if (response.status === 403) {
        return new BotClientError('forbidden', `${action} refused: ${hubErrorMessage(response)}`, response.status)
    }
    if (response.status === 404 && notFoundMessage) {
        return new BotClientError('not_found', notFoundMessage, response.status)
    }
    return new BotClientError('request_failed', `${action} failed: ${hubErrorMessage(response)}`, response.status)
}

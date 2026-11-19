import type { TelemetryLevel } from '@hapi/protocol/telemetry'
import { TELEMETRY_SELF_HEADER } from '@hapi/protocol/telemetry'
import { resolveLiveBaseUrl } from './device'
import {
    LEVEL_REFRESH_MS,
    PROBE_THROTTLE_MS,
    RETRY_PROBE_MS,
    state,
} from './state'

/**
 * Capability & level negotiation (ruling 7: features 持能力位, settings 持值).
 *
 * install 后 GET {baseUrl}/api/features:无 `telemetry` 能力位 / 404 / 任何失败
 * → 本地 disable(全 no-op)+ 每 30min 重探一次(旧 hub 版本交错自愈,风险 5)。
 * 能力位在 → telemetryLevel 即当前级;成功 flush 后顺带刷新(≥5min 间隔),
 * ingest 成功响应体也回传 level(直接采纳)。
 *
 * Token 来源:config.getAuthToken()(main.tsx 传 null)∪ authProxy 单点观测到的
 * Bearer 头(httpObserver.noteBearerFromHeaders)。首个 app 请求出现 token 时
 * 立即触发一次受节流的探测。
 */

function clampLevel(raw: unknown): TelemetryLevel {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 1
    if (n <= 0) return 0
    if (n === 1) return 1
    if (n === 2) return 2
    return 3
}

/** Tolerant capability extraction: `{ telemetry: true, telemetryLevel: n }` (hub
 *  契约形状),或 `{ telemetry: { enabled, level } }` 变体。无能力位 → null。 */
export function extractTelemetryCapability(payload: unknown): { level: TelemetryLevel } | null {
    if (typeof payload !== 'object' || payload === null) return null
    const p = payload as Record<string, unknown>
    let capable = false
    let levelRaw: unknown = undefined
    if (p.telemetry === true) {
        capable = true
    } else if (typeof p.telemetry === 'object' && p.telemetry !== null) {
        const t = p.telemetry as Record<string, unknown>
        if (t.enabled === true) {
            capable = true
            levelRaw = t.level
        }
    }
    if (!capable) return null
    if (levelRaw === undefined) levelRaw = p.telemetryLevel
    return { level: clampLevel(levelRaw) }
}

/** Token resolution: explicit config getter first, then the observed Bearer. */
export function resolveBearerToken(): string | null {
    try {
        const fromConfig = state.config?.getAuthToken()
        if (fromConfig) return fromConfig
    } catch {
        // getter must never break telemetry
    }
    return state.lastSeenBearer
}

export function telemetryUrl(path: string): string {
    const base = resolveLiveBaseUrl(state.config?.baseUrl ?? '')
    try {
        return new URL(path, base || undefined).toString()
    } catch {
        return path
    }
}

export function buildTelemetryHeaders(token: string | null): Record<string, string> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        [TELEMETRY_SELF_HEADER]: '1',
    }
    if (token) headers.authorization = `Bearer ${token}`
    return headers
}

function scheduleProbe(delayMs: number): void {
    try {
        if (state.probeTimer !== null) clearTimeout(state.probeTimer)
        state.probeTimer = setTimeout(() => {
            state.probeTimer = null
            void probeCapability()
        }, delayMs)
    } catch {
        // fail-silent
    }
}

export function startNegotiation(): void {
    void probeCapability()
    scheduleProbe(RETRY_PROBE_MS)
}

/** Called by the http observer whenever a Bearer token flows past the single
 *  fetch point — re-probes while disabled, throttled. */
export function onBearerObserved(): void {
    if (!state.installed || state.enabled) return
    if (state.probeInFlight) return
    if (Date.now() - state.probedAt < PROBE_THROTTLE_MS) return
    void probeCapability()
}

export async function probeCapability(): Promise<void> {
    if (!state.installed) return
    if (state.probeInFlight) return
    const token = resolveBearerToken()
    if (!token) {
        // No token yet (auth happens later in React) — retry as soon as one is
        // observed at the authProxy point; the 30min timer is the backstop.
        // Deliberately does not consume the probe throttle: a token observed a
        // moment later must trigger the probe immediately, not 15s out.
        return
    }
    state.probeInFlight = true
    try {
        const res = await fetch(telemetryUrl('/api/features'), {
            method: 'GET',
            headers: buildTelemetryHeaders(token),
            cache: 'no-store',
        })
        state.probedAt = Date.now()
        if (!res.ok) {
            state.enabled = false
            state.level = 0
            return
        }
        const payload: unknown = await res.json().catch(() => null)
        const capability = extractTelemetryCapability(payload)
        if (capability === null) {
            // Old hub without the capability bit → fully disabled, re-probe later.
            state.enabled = false
            state.level = 0
            return
        }
        const wasEnabled = state.enabled
        state.enabled = capability.level > 0
        state.level = capability.level
        state.levelRefreshedAt = Date.now()
        if (!wasEnabled && state.enabled) {
            // Freshly negotiated: deliver anything the outbox held from a
            // previous page lifetime.
            void import('./queue').then(({ flushQueue }) => flushQueue('negotiated'))
        }
    } catch {
        state.probedAt = Date.now()
        state.enabled = false
        state.level = 0
    } finally {
        state.probeInFlight = false
    }
}

/** After a successful flush (or an ingest response carrying `level`): refresh
 *  the negotiated level, piggybacked and rate-limited to once per 5min. */
export function onFlushSuccessMaybeRefreshLevel(levelFromResponse?: unknown): void {
    try {
        if (typeof levelFromResponse === 'number') {
            const next = clampLevel(levelFromResponse)
            state.level = next
            state.enabled = next > 0
            state.levelRefreshedAt = Date.now()
            return
        }
        if (Date.now() - state.levelRefreshedAt >= LEVEL_REFRESH_MS) {
            void probeCapability()
        }
    } catch {
        // fail-silent
    }
}

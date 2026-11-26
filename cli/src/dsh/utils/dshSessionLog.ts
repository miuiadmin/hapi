import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { DshLocalSessionSummary, DshLocalSessionWithMessages } from '@hapi/protocol/apiTypes'

/**
 * Durable DSH session reader (disk side of the local-session import).
 *
 * DSH persists every session as `~/.dsh/sessions/<projectKey>/<id>/
 * session.v4.jsonl.zstd` — a concatenation of independent zstd frames (one
 * header frame, then one frame per append batch) — plus a projection cache
 * at `~/.dsh/storages/session_projcache/sessions/<id>.json` that folds the
 * interesting state (title, turn boundaries, token usage, model selection,
 * permissions). ACP `session/list` exposes none of that (only {sessionId,
 * cwd}, subagents hidden, createdAt computed then dropped), so the import
 * list is built straight from disk:
 *
 * - summaries: 8KB header read through node:zlib (whose zstdDecompressSync
 *   only decodes the FIRST frame — exactly the header) + the projcache JSON.
 * - transcripts: full-frame decode through Bun.zstdDecompressSync, folding
 *   user/message, assistant/message, tool/call, tool/result and terminal
 *   turn/end events into the CodexMessage payload shapes the web renders.
 *
 * Everything is read-only: the log is append-only under flock and must never
 * be written from outside. Sessions whose header says version !== 4 or whose
 * cwd has disappeared are skipped / flagged rather than failing the scan.
 */

/** Env override for custom DSH_HOME layouts (mirrors HAPI_DSH_PROFILE_DIR). */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    const override = env.HAPI_DSH_HOME?.trim()
    if (override) return override
    return join(home, '.dsh')
}

/** Compressed-size cap for full-transcript reads: beyond this the decode
 * buffer risk outweighs the import value; the session stays listable but
 * is skipped as a transcript (the hub reports it not found). */
const MAX_TRANSCRIPT_COMPRESSED_BYTES = 96 * 1024 * 1024

type DshSessionHeader = {
    id: string
    createdAt?: number
    cwd?: string
    parentSession?: string
    origin?: string
    version?: number
}

type ProjcacheRow = { ver?: number; seq?: number; val?: unknown }

type DshProjcache = {
    record?: {
        identity?: { createdAt?: number; cwd?: string }
        rows?: Record<string, ProjcacheRow>
    }
}

/** Folded transcript message content — the CodexMessage payload shapes the
 * web chat normalizer already renders for live DSH sessions. */
export type DshFoldedMessage = DshLocalSessionWithMessages['messages'][number]

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

/** Read the log's first zstd frame (the header row) via node:zlib, whose
 * zstdDecompressSync stops after one frame. Returns null on any mismatch —
 * a torn header or a foreign format skips the session instead of failing
 * the scan. */
function readSessionHeader(path: string): DshSessionHeader | null {
    let buffer: Buffer
    try {
        const fd = statSync(path)
        if (!fd.isFile()) return null
        buffer = readFileSync(path).subarray(0, 8192)
    } catch {
        return null
    }
    try {
        const decompressed = zstdDecompressSync(buffer)
        const newline = decompressed.indexOf(0x0a)
        const firstLine = (newline >= 0 ? decompressed.subarray(0, newline) : decompressed).toString('utf8')
        const parsed = asRecord(JSON.parse(firstLine))
        if (!parsed || parsed.type !== 'session') return null
        const id = asString(parsed.id)
        if (!id) return null
        return {
            id,
            ...(typeof parsed.createdAt === 'number' ? { createdAt: parsed.createdAt } : {}),
            ...(asString(parsed.cwd) ? { cwd: asString(parsed.cwd)! } : {}),
            ...(asString(parsed.parentSession) ? { parentSession: asString(parsed.parentSession)! } : {}),
            ...(asString(parsed.origin) ? { origin: asString(parsed.origin)! } : {}),
            ...(typeof parsed.version === 'number' ? { version: parsed.version } : {})
        }
    } catch {
        return null
    }
}

function readProjcache(path: string): DshProjcache | null {
    try {
        return asRecord(JSON.parse(readFileSync(path, 'utf8'))) as DshProjcache | null
    } catch {
        return null
    }
}

function rowVal(cache: DshProjcache | null, key: string): unknown {
    return cache?.record?.rows?.[key]?.val
}

function rowString(cache: DshProjcache | null, key: string, field?: string): string | null {
    const value = rowVal(cache, key)
    const target = field !== undefined ? asRecord(value)?.[field] : value
    return asString(target)
}

/** The opaque ACP model value the model rail sends back verbatim. */
function launchModelTuple(cache: DshProjcache | null): { model: string; reasoningEffort: string | null } | null {
    const lastUsed = asRecord(rowVal(cache, 'modelSelection'))?.lastUsed
    const record = asRecord(lastUsed)
    const provider = asString(record?.provider)
    const model = asString(record?.model)
    if (!provider || !model) return null
    const reasoning = asString(record?.reasoningEffort)
    return { model: JSON.stringify([provider, model]), reasoningEffort: reasoning }
}

function existsDir(path: string | null | undefined): boolean {
    if (!path) return false
    try {
        return statSync(path).isDirectory()
    } catch {
        return false
    }
}

export type DshSessionScan = {
    summaries: DshLocalSessionSummary[]
    /** Session ids skipped because their durable cwd no longer exists. */
    unresumableIds: string[]
}

/** Scan the DSH home for durable root sessions, richest data first from the
 * projection cache with the log header as the identity source of truth.
 * Subagent sessions are excluded (ACP resume rejects them and the import
 * list mirrors session/list). */
export function listDshSessionSummaries(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): DshSessionScan {
    const dshHome = resolveDshHome(env, home)
    const sessionsRoot = join(dshHome, 'sessions')
    const cacheRoot = join(dshHome, 'storages', 'session_projcache', 'sessions')
    const summaries: DshLocalSessionSummary[] = []
    const unresumableIds: string[] = []
    let projects: string[]
    try {
        projects = readdirSync(sessionsRoot)
    } catch {
        return { summaries, unresumableIds }
    }
    for (const project of projects) {
        const projectDir = join(sessionsRoot, project)
        let segments: string[]
        try {
            if (!statSync(projectDir).isDirectory()) continue
            segments = readdirSync(projectDir)
        } catch {
            continue
        }
        for (const segment of segments) {
            const logPath = join(projectDir, segment, 'session.v4.jsonl.zstd')
            const header = readSessionHeader(logPath)
            if (!header) continue
            if (header.version !== undefined && header.version !== 4) continue
            if (header.origin === 'subagent' || header.parentSession) continue
            const cwd = header.cwd ?? null
            if (!cwd || !cwd.startsWith('/')) continue
            const cache = readProjcache(join(cacheRoot, `${header.id}.json`))
            const firstPrompt = asString(asRecord(asRecord(rowVal(cache, 'titleInput'))?.first)?.text)
            const title = rowString(cache, 'title') ?? rowString(cache, 'title', 'title')
                ?? firstPrompt?.split('\n')[0] ?? ''
            const turns = asRecord(rowVal(cache, 'turnBoundary'))?.lastTurn
            const tokens = asRecord(rowVal(cache, 'tokenUsage'))
            const totals = asRecord(tokens?.totals)
            const permissionPreset = rowString(cache, 'permissions', 'preset')
                ?? rowString(cache, 'sandboxMode')
            const contextTokens = asRecord(rowVal(cache, 'contextPressure'))?.surfaceTokens
            const workingDirectory = rowString(cache, 'workingDirectory')
                ?? rowString(cache, 'workingDirectory', 'cwd')
            const resumable = existsDir(cwd)
            if (!resumable) unresumableIds.push(header.id)
            let modifiedAt = header.createdAt ?? 0
            try {
                modifiedAt = statSync(logPath).mtimeMs
            } catch {
                // createdAt fallback already in place
            }
            const launch = launchModelTuple(cache)
            summaries.push({
                id: header.id,
                title,
                ...(firstPrompt ? { lastUserMessage: firstPrompt } : {}),
                cwd,
                file: logPath,
                modifiedAt,
                ...(launch ? { model: launch.model, reasoningEffort: launch.reasoningEffort } : {})
            })
            // Display extras ride the generic list item; numeric/string/null only.
            summaries[summaries.length - 1].extra = {
                turns: typeof turns === 'number' ? turns : null,
                inputTokens: typeof totals?.uncachedInputTokens === 'number' ? totals.uncachedInputTokens : null,
                outputTokens: typeof totals?.outputTokens === 'number' ? totals.outputTokens : null,
                cacheReadTokens: typeof totals?.cacheReadTokens === 'number' ? totals.cacheReadTokens : null,
                contextTokens: typeof contextTokens === 'number' ? contextTokens : null,
                permissionPreset: permissionPreset,
                workingDirectory: workingDirectory,
                resumable: resumable ? 1 : 0
            }
        }
    }
    summaries.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return { summaries, unresumableIds }
}

type DshLogEvent = { type: string; seq?: number; time?: number; data?: unknown }

/** The zstd frame magic (LE 0xFD2FB528) — every dsh append frame starts it. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode a multi-frame zstd buffer. Bun's one-shot zstdDecompressSync handles
 * concatenated frames (verified against real dsh logs); node:zlib — what
 * vitest/CI runs on — silently stops after the FIRST frame, so there we walk
 * the frame boundaries (magic positions, greedy-merge on false positives
 * where the magic appears inside compressed payload) and decode each frame.
 */
function decompressAllFrames(raw: Buffer): Buffer {
    if (typeof Bun !== 'undefined' && typeof Bun.zstdDecompressSync === 'function') {
        return Bun.zstdDecompressSync(raw)
    }
    const positions: number[] = []
    let at = raw.indexOf(ZSTD_MAGIC)
    while (at >= 0) {
        positions.push(at)
        at = raw.indexOf(ZSTD_MAGIC, at + 1)
    }
    if (positions.length === 0) {
        // Not a frame concatenation we understand; surface the raw failure.
        return zstdDecompressSync(raw)
    }
    const parts: Buffer[] = []
    let start = 0
    let index = 0
    while (index < positions.length) {
        // Greedy: try the next magic as the boundary; on decode failure merge
        // the following magic-delimited span (the magic occurred inside this
        // frame's compressed payload) and retry.
        let end = index + 1 < positions.length ? positions[index + 1]! : raw.length
        let slice = raw.subarray(positions[index]!, end)
        while (true) {
            try {
                parts.push(zstdDecompressSync(slice))
                start = end
                break
            } catch (error) {
                if (end >= raw.length) throw error
                const next = raw.indexOf(ZSTD_MAGIC, end + 1)
                end = next >= 0 ? next : raw.length
                slice = raw.subarray(start, end)
            }
        }
        index = positions.indexOf(end, index)
        if (index < 0) break
    }
    // Trailing bytes after the last magic-delimited frame (checksum padding
    // etc.) carry no events.
    return Buffer.concat(parts)
}

/** Decode the full multi-frame zstd log and split it back into event rows. */
function readLogEvents(path: string): DshLogEvent[] {
    const raw = readFileSync(path)
    if (raw.length > MAX_TRANSCRIPT_COMPRESSED_BYTES) {
        throw new Error(`DSH transcript too large to import (${Math.round(raw.length / 1048576)}MB compressed)`)
    }
    const decompressed = decompressAllFrames(raw)
    const text = decompressed.toString('utf8')
    const events: DshLogEvent[] = []
    for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
            const parsed = asRecord(JSON.parse(line))
            if (parsed && typeof parsed.type === 'string') {
                events.push(parsed as unknown as DshLogEvent)
            }
        } catch {
            // A torn tail line is never written by dsh (fsync batches), but a
            // foreign/corrupt file must not fail the whole import.
        }
    }
    return events
}

function textOfBlocks(blocks: unknown): string {
    if (!Array.isArray(blocks)) return ''
    const parts: string[] = []
    for (const block of blocks) {
        const record = asRecord(block)
        if (!record) continue
        if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) {
            parts.push(record.text)
        }
    }
    return parts.join('')
}

function foldToolOutput(blocks: unknown): string {
    if (!Array.isArray(blocks)) return ''
    const parts: string[] = []
    for (const block of blocks) {
        const record = asRecord(block)
        if (!record) continue
        if (typeof record.text === 'string' && record.text.length > 0) {
            parts.push(record.text)
        }
    }
    return parts.join('\n')
}

let localIdCounter = 0
function nextLocalId(seq: number | undefined): string {
    if (typeof seq === 'number') return `dsh:${seq}`
    // Seq is the stable identity; the counter only backs foreign logs.
    localIdCounter += 1
    return `dsh:foreign:${localIdCounter}`
}

/** Fold one durable log into importable transcript messages. Only real
 * operator turns (source.kind === 'user') become user rows; injected
 * notices (model-change banners, queued follow-ups) stay out of the chat.
 * Tool activity folds from tool/call + tool/result events — the tool-call
 * blocks inside assistant/message would double-count it. Terminal
 * turn/end states other than completed/aborted become error rows so the
 * transcript shows WHY a session stopped. */
export function foldDshLogEvents(events: DshLogEvent[]): DshFoldedMessage[] {
    const messages: DshFoldedMessage[] = []
    for (const event of events) {
        const time = typeof event.time === 'number' ? event.time : Date.now()
        const data = asRecord(event.data)
        switch (event.type) {
            case 'user/message': {
                if (asRecord(data?.source)?.kind !== 'user') break
                const text = textOfBlocks(data?.content)
                if (!text.trim()) break
                messages.push({
                    localId: nextLocalId(event.seq),
                    createdAt: time,
                    content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } }
                })
                break
            }
            case 'assistant/message': {
                const message = asRecord(data?.message)
                const blocks = message?.content
                if (!Array.isArray(blocks)) break
                for (const block of blocks) {
                    const record = asRecord(block)
                    if (!record) continue
                    if (record.type === 'reasoning' && typeof record.text === 'string' && record.text.length > 0) {
                        messages.push({
                            localId: nextLocalId(event.seq),
                            createdAt: time,
                            content: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'reasoning', message: record.text, id: `dsh-r:${event.seq ?? time}` } }, meta: { sentFrom: 'cli' } }
                        })
                    } else if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) {
                        messages.push({
                            localId: nextLocalId(event.seq),
                            createdAt: time,
                            content: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: record.text, id: asString(message?.id) ?? `dsh-m:${event.seq ?? time}` } }, meta: { sentFrom: 'cli' } }
                        })
                    }
                }
                break
            }
            case 'tool/call': {
                const callId = asString(data?.callId)
                const name = asString(data?.name)
                if (!callId || !name) break
                let input: unknown = data?.arguments
                if (typeof input === 'string') {
                    try { input = JSON.parse(input) } catch { /* opaque string input */ }
                }
                messages.push({
                    localId: nextLocalId(event.seq),
                    createdAt: time,
                    content: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'tool-call', name, callId, input, status: 'in_progress' } }, meta: { sentFrom: 'cli' } }
                })
                break
            }
            case 'tool/result': {
                const result = asRecord(data?.message)
                const callId = asString(result?.toolCallId)
                if (!callId) break
                messages.push({
                    localId: nextLocalId(event.seq),
                    createdAt: time,
                    content: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'tool-call-result', callId, output: foldToolOutput(result?.content), is_error: result?.isError === true } }, meta: { sentFrom: 'cli' } }
                })
                break
            }
            case 'turn/end': {
                const reason = asString(data?.reason)
                if (!reason || reason === 'completed' || reason === 'aborted') break
                const detail = asString(data?.message) ?? asString(asRecord(data?.error)?.message)
                messages.push({
                    localId: nextLocalId(event.seq),
                    createdAt: time,
                    content: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'error', message: detail ? `Turn ended (${reason}): ${detail}` : `Turn ended (${reason})` } }, meta: { sentFrom: 'cli' } }
                })
                break
            }
            default:
                break
        }
    }
    return messages
}

// Local alias helper removed — AGENT_MESSAGE_PAYLOAD_TYPE is imported above.

/** Full transcript read for import: header identity + folded messages. */
export function readDshSessionTranscriptById(id: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): DshLocalSessionWithMessages | null {
    const summaries = listDshSessionSummaries(env, home).summaries
    const summary = summaries.find((session) => session.id === id)
    if (!summary) return null
    const events = readLogEvents(summary.file)
    return {
        ...summary,
        messages: foldDshLogEvents(events)
    }
}

export function readDshSessionTranscriptsByIds(ids: readonly string[], env: NodeJS.ProcessEnv = process.env, home: string = homedir()): DshLocalSessionWithMessages[] {
    // One scan serves the whole batch; missing ids surface as hub-side
    // not_found results exactly like the other flavors.
    const wanted = new Set(ids)
    const summaries = listDshSessionSummaries(env, home).summaries.filter((session) => wanted.has(session.id))
    const transcripts: DshLocalSessionWithMessages[] = []
    for (const summary of summaries) {
        try {
            transcripts.push({
                ...summary,
                messages: foldDshLogEvents(readLogEvents(summary.file))
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.warn(`[dsh-import] skipping transcript ${summary.id}: ${message}`)
        }
    }
    return transcripts
}

/** Exists for tests + callers that only need the presence check. */
export function dshSessionsRootExists(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): boolean {
    return existsSync(join(resolveDshHome(env, home), 'sessions'))
}

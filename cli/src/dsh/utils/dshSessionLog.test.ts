import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { listDshSessionSummaries, readDshSessionTranscriptById, foldDshLogEvents } from './dshSessionLog'

/** DSH logs are concatenations of independent zstd frames: one header frame,
 * then one frame per append batch. Build fixtures the same way. */
function writeDshLog(path: string, lines: object[]): void {
    const frames = lines.map((line) => zstdCompressSync(Buffer.from(JSON.stringify(line) + '\n', 'utf8')))
    writeFileSync(path, Buffer.concat(frames))
}

const home = mkdtempSync(join(tmpdir(), 'dsh-log-test-'))

// Session 1: a full conversation with tool activity and an error turn.
const sessionA = {
    header: { type: 'session', version: 4, id: 'sess-a', createdAt: 1700000000000, cwd: '/tmp/proj-a', isSeeded: false, delegationDepth: 0 },
    events: [
        { type: 'user/message', seq: 1, time: 1700000001000, data: { content: [{ type: 'text', text: '帮我修一下登录页' }], source: { kind: 'user' } } },
        // Injected notice: not an operator turn, must not fold.
        { type: 'user/message', seq: 2, time: 1700000002000, data: { content: [{ type: 'text', text: '[model changed: …]' }], source: { kind: 'system' } } },
        {
            type: 'assistant/message', seq: 3, time: 1700000003000,
            data: {
                turn: 1, step: 1,
                message: {
                    id: 'msg-1',
                    content: [
                        { type: 'reasoning', text: '先看看路由' },
                        { type: 'text', text: '我来检查登录页代码。' }
                    ],
                    source: { kind: 'model', provider: 'deepseek-official', model: 'glm-5.4' }
                },
                usage: { inputTokens: 100, outputTokens: 20 }
            }
        },
        { type: 'tool/call', seq: 4, time: 1700000004000, data: { callId: 'call-1', name: 'read_file', arguments: '{"path":"/tmp/proj-a/login.ts"}' } },
        { type: 'tool/result', seq: 5, time: 1700000005000, data: { message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'const x = 1' }] } } },
        { type: 'turn/end', seq: 6, time: 1700000006000, data: { reason: 'completed' } },
        { type: 'user/message', seq: 7, time: 1700000007000, data: { content: [{ type: 'text', text: '再跑下测试' }], source: { kind: 'user' } } },
        { type: 'turn/end', seq: 8, time: 1700000008000, data: { reason: 'error', message: 'RATE_LIMIT: upstream 429' } }
    ]
}

// Session 2: subagent — must be excluded from the import list.
const sessionB = {
    header: { type: 'session', version: 4, id: 'sess-b', createdAt: 1700000100000, cwd: '/tmp/proj-a', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'sess-a' },
    events: []
}

function projcache(id: string, rows: Record<string, unknown>): void {
    mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    writeFileSync(
        join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
        JSON.stringify({ version: 7, record: { identity: { formatVersion: 4 }, rows } })
    )
}

mkdirSync(join(home, 'sessions', '--tmp-proj-a--', 'sess-a'), { recursive: true })
writeDshLog(join(home, 'sessions', '--tmp-proj-a--', 'sess-a', 'session.v4.jsonl.zstd'), [sessionA.header, ...sessionA.events])
projcache('sess-a', {
    title: { ver: 2, seq: 8, val: '修复登录页' },
    titleInput: { ver: 1, seq: 1, val: { first: { seq: 1, text: '帮我修一下登录页' }, count: 2 } },
    turnBoundary: { ver: 3, seq: 8, val: { lastTurn: 2 } },
    tokenUsage: { ver: 2, seq: 8, val: { totals: { uncachedInputTokens: 1234, outputTokens: 567, cacheReadTokens: 8901 } } },
    modelSelection: { ver: 2, seq: 3, val: { lastUsed: { provider: 'deepseek-official', model: 'glm-5.4', reasoningEffort: 'high' } } },
    permissions: { ver: 1, seq: 0, val: { preset: 'workspace-write', sandbox: 'workspace-write' } },
    contextPressure: { ver: 1, seq: 8, val: { surfaceTokens: 45678 } }
})
mkdirSync(join(home, 'sessions', '--tmp-proj-a--', 'sess-b'), { recursive: true })
writeDshLog(join(home, 'sessions', '--tmp-proj-a--', 'sess-b', 'session.v4.jsonl.zstd'), [sessionB.header])
// Keep the log mtime stable for the modifiedAt assertion.
utimesSync(join(home, 'sessions', '--tmp-proj-a--', 'sess-a', 'session.v4.jsonl.zstd'), new Date(1700000090000), new Date(1700000090000))

afterAll(() => {
    rmSync(home, { recursive: true, force: true })
})

describe('listDshSessionSummaries', () => {
    it('builds rich summaries from header + projcache, excluding subagents', () => {
        const scan = listDshSessionSummaries({ HAPI_DSH_HOME: home })
        expect(scan.summaries).toHaveLength(1)
        const summary = scan.summaries[0]!
        expect(summary.id).toBe('sess-a')
        expect(summary.title).toBe('修复登录页')
        expect(summary.cwd).toBe('/tmp/proj-a')
        expect(summary.modifiedAt).toBe(1700000090000)
        // The opaque launch hint reconstructs the picker's JSON tuple.
        expect(summary.model).toBe('["deepseek-official","glm-5.4"]')
        expect(summary.reasoningEffort).toBe('high')
        expect(summary.lastUserMessage).toBe('帮我修一下登录页')
        expect(summary.extra).toMatchObject({
            turns: 2,
            inputTokens: 1234,
            outputTokens: 567,
            cacheReadTokens: 8901,
            contextTokens: 45678,
            permissionPreset: 'workspace-write',
            resumable: 0 // /tmp/proj-a does not exist in the test env
        })
        expect(scan.unresumableIds).toEqual(['sess-a'])
    })
})

describe('readDshSessionTranscriptById', () => {
    it('folds operator turns, assistant blocks, tools and terminal errors', () => {
        const transcript = readDshSessionTranscriptById('sess-a', { HAPI_DSH_HOME: home })
        expect(transcript).not.toBeNull()
        const kinds = transcript!.messages.map((message) => {
            const record = message.content as { role: string; content: { type: string; data?: { type?: string } } }
            return record.role === 'user' ? 'user' : record.content.data?.type ?? record.content.type
        })
        expect(kinds).toEqual([
            'user',        // operator turn
            'reasoning',   // assistant reasoning block
            'message',     // assistant text block
            'tool-call',   // tool/call event
            'tool-call-result',
            'user',        // second operator turn
            'error'        // turn/end error — completed/aborted stay silent
        ])
        // The injected model-change notice never becomes a chat row.
        expect(transcript!.messages.every((message) => {
            const record = message.content as { role: string; content: { type: string; data?: { type?: string; message?: string } } }
            return record.content.data?.message !== '[model changed: …]'
        })).toBe(true)
        // Tool arguments arrive parsed; results carry output + error flag.
        const toolCall = transcript!.messages.find((message) => {
            const record = message.content as { role: string; content: { data?: { type?: string; input?: unknown } } }
            return record.content.data?.type === 'tool-call'
        })!
        expect((toolCall.content as { content: { data: { input: { path: string } } } }).content.data.input).toEqual({ path: '/tmp/proj-a/login.ts' })
        const error = transcript!.messages.find((message) => {
            const record = message.content as { role: string; content: { data?: { type?: string; message?: string } } }
            return record.content.data?.type === 'error'
        })!
        expect((error.content as { content: { data: { message: string } } }).content.data.message).toContain('RATE_LIMIT')
    })

    it('returns null for unknown ids', () => {
        expect(readDshSessionTranscriptById('missing', { HAPI_DSH_HOME: home })).toBeNull()
    })
})

describe('foldDshLogEvents', () => {
    it('keeps completed and aborted turns silent', () => {
        const messages = foldDshLogEvents([
            { type: 'turn/end', seq: 1, time: 1, data: { reason: 'completed' } },
            { type: 'turn/end', seq: 2, time: 2, data: { reason: 'aborted' } },
            { type: 'turn/end', seq: 3, time: 3, data: { reason: 'max-tokens' } }
        ])
        expect(messages).toHaveLength(1)
        const record = messages[0]!.content as { role: string; content: { data: { message: string } } }
        expect(record.content.data.message).toContain('max-tokens')
    })
})

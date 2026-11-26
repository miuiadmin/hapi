import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    decodeZstdFrames,
    decodeZstdFramesTolerant,
    listDshSessionSummaries,
    readDshSessionTranscriptById
} from './dshSessionLog'

/**
 * Production-runtime spec for the DSH log reader.
 *
 * The cli suite runs on vitest/Node, which exercises the node:zlib frame walk
 * (`decodeZstdFrames` fallback). The shipped runner is a Bun binary, so the
 * Bun one-shot decode — and its torn-tail fallback, which Bun needs because it
 * rejects the whole file for one torn frame — is only covered here:
 *
 *     cd cli && bun test ./src/dsh/utils/dshSessionLog.bun-spec.ts
 *
 * (vitest only includes `*.test.ts`, so this file never runs under Node; the
 * `./` prefix makes bun treat the path as a file rather than a filter, since
 * the name deliberately avoids `.spec.ts`/`.test.ts` discovery patterns.)
 */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** One append batch per frame, the way DSH writes a log. */
function batch(lines: object[]): Buffer {
    return Bun.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8'))
}

const T0 = 1_700_000_000_000
const event = (type: string, seq: number, data?: unknown) => ({ type, seq, time: T0 + seq * 1000, data })
const header = (id: string) => ({ type: 'session', version: 4, id, createdAt: T0, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 0 })

const home = mkdtempSync(join(tmpdir(), 'dsh-log-bun-spec-'))
const env = { HAPI_DSH_HOME: home }

function write(id: string, frames: Buffer[]): string {
    const dir = join(home, 'sessions', '--tmp-proj--', id)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(path, Buffer.concat(frames))
    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, `${id}.json`), JSON.stringify({
        version: 7,
        record: { identity: { formatVersion: 4 }, rows: { turnBoundary: { ver: 1, seq: 3, val: { lastTurn: 1 } } } }
    }))
    return path
}

afterAll(() => {
    rmSync(home, { recursive: true, force: true })
})

describe('dshSessionLog on the Bun runtime', () => {
    it('decodes every frame of a DSH log in one shot', () => {
        const decoded = decodeZstdFrames(Buffer.concat([
            batch([{ a: 1 }, { a: 2 }]),
            batch([{ a: 3 }]),
            batch([{ a: 4 }, { a: 5 }])
        ]))
        expect(Buffer.isBuffer(decoded)).toBe(true)
        expect(decoded.toString('utf8').trim().split('\n').map((line) => JSON.parse(line).a)).toEqual([1, 2, 3, 4, 5])
    })

    it('drops a torn tail frame instead of rejecting the whole log', () => {
        const frames = [batch([{ a: 1 }]), batch([{ a: 2 }]), batch([{ a: 3 }])]
        const whole = Buffer.concat(frames)
        // Bun rejects the file outright for the torn last frame…
        expect(() => decodeZstdFrames(whole.subarray(0, whole.length - Math.floor(frames[2]!.length * 0.4)))).toThrow()
        // …and the tolerant decode keeps every complete frame.
        const decoded = decodeZstdFramesTolerant(whole.subarray(0, whole.length - Math.floor(frames[2]!.length * 0.4)))
        expect(decoded.toString('utf8').trim().split('\n').map((line) => JSON.parse(line).a)).toEqual([1, 2])
    })

    it('is not fooled by a frame boundary look-alike inside a compressed payload', () => {
        const payload = Buffer.concat([
            Buffer.from('{"type":"assistant/message","seq":1,"time":' + T0 + ',"data":{"message":{"id":"m","content":[{"type":"text","text":"before '),
            ZSTD_MAGIC,
            Buffer.from(' after magic"}]}}}\n')
        ])
        // A RAW-block frame keeps the magic verbatim inside the frame body.
        const frameHeader = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x0a])
        const block = (payload.length << 3) | 1
        const rawFrame = Buffer.concat([frameHeader, Buffer.from([block & 0xff, (block >> 8) & 0xff, (block >> 16) & 0xff]), payload])
        const path = write('sess-magic', [batch([header('sess-magic')]), rawFrame])
        const text = decodeZstdFrames(readFileSync(path)).toString('utf8')
        expect(text).toContain('before (')
        expect(text).toContain(' after magic')
    })

    it('lists the session and folds its transcript with unique prefixed ids', async () => {
        write('sess-a', [
            batch([header('sess-a')]),
            batch([
                event('user/message', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
                event('assistant/message', 2, { message: { id: 'm', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'hi' }] } }),
                event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } })
            ])
        ])
        expect(listDshSessionSummaries(env, home).map((session) => session.id)).toEqual(['sess-a', 'sess-magic'])
        const transcript = await readDshSessionTranscriptById('sess-a', env, home)
        expect(transcript?.messages.map((message) => message.localId)).toEqual([
            'dsh:sess-a:1', 'dsh:sess-a:2', 'dsh:sess-a:2:1'
        ])
    })
})

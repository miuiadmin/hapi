import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, PREFETCHED_PAGE_TTL_MS } from './client'
import {
    RECONCILE_MAX_IDS,
    RECONCILE_MIN_LABELLED_ROWS,
    isReconcileManifestQuery,
    markReconcilePage,
    reconcileManifestQuery,
    resetReconcilePageForTests,
    rowsToFetch
} from './reconcilePage'
import type { MessagesResponse } from '@/types/api'

function row(id: string, text: string, rowHash?: string) {
    return { id, seq: 1, localId: null, content: { role: 'user', content: { type: 'text', text } }, createdAt: 1000, ...(rowHash ? { rowHash } : {}) }
}

function page(overrides: Partial<MessagesResponse['page']> = {}): MessagesResponse['page'] {
    return {
        direction: 'latest',
        limit: 200,
        epoch: 3,
        reset: false,
        nextBeforeSeq: 7,
        nextBeforeAt: 900,
        nextAfterSeq: null,
        nextAfterAt: null,
        snapshotHeadSeq: 12,
        snapshotHeadAt: 1500,
        hasMore: true,
        ...overrides
    }
}

function body(messages: unknown[], pageOverride: Partial<MessagesResponse['page']> = {}): MessagesResponse {
    return { messages: messages as MessagesResponse['messages'], page: page(pageOverride) }
}

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

function queryOf(url: string): URLSearchParams {
    return new URL(url, 'https://hub.example').searchParams
}

/** A window holding the given rows plus enough labelled filler to be worth a manifest. */
function window(rows: Array<[string, string | undefined]>): Map<string, string | undefined> {
    return new Map([
        ...Array.from({ length: RECONCILE_MIN_LABELLED_ROWS }, (_, i) => [`filler-${i}`, `f${`${i}`.padStart(11, '0')}`] as [string, string]),
        ...rows
    ])
}

describe('ApiClient gap-recovery reconcile', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>
    const urls = () => fetchMock.mock.calls.map((call) => String(call[0]))

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
        resetReconcilePageForTests()
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        resetReconcilePageForTests()
    })

    it('a full latest page is a plain request unless the window store marked it', async () => {
        fetchMock.mockResolvedValueOnce(json(body([row('a', 'a', 'aaaaaaaaaaaa')])))
        const api = new ApiClient('test-token')
        await api.getMessages('session-1', { limit: 200 })
        expect(urls()).toEqual(['/api/sessions/session-1/messages?limit=200&withRowHashes=1'])
    })

    it('asks for the manifest and fetches nothing when the window holds every row as served', async () => {
        const list = [
            { id: 'a', hash: 'aaaaaaaaaaaa' },
            { id: 'b', hash: 'bbbbbbbbbbbb' }
        ]
        fetchMock.mockResolvedValueOnce(json(body([], { rowHashes: list })))
        const api = new ApiClient('test-token')
        markReconcilePage('session-1', { epoch: 3, rows: window([['a', 'aaaaaaaaaaaa'], ['b', 'bbbbbbbbbbbb'], ['old', 'cccccccccccc']]) })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual(['/api/sessions/session-1/messages?limit=200&knownEpoch=3&withRowHashes=1&rowHashes=1&manifestAnyEpoch=1'])
        expect(response.messages).toEqual([])
        // The page is the whole page's; the list rides along on it.
        expect(response.page).toEqual(page({ rowHashes: list }))
    })

    it('fetches only the rows the window lacks or holds with another fingerprint', async () => {
        const fresh = row('b', 'b changed', 'ffffffffffff')
        const added = row('c', 'c', 'cccccccccccc')
        const list = [
            { id: 'a', hash: 'aaaaaaaaaaaa' },
            { id: 'b', hash: 'ffffffffffff' },
            { id: 'c', hash: 'cccccccccccc' }
        ]
        fetchMock
            .mockResolvedValueOnce(json(body([], { rowHashes: list })))
            .mockResolvedValueOnce(json(body([fresh, added])))
        const api = new ApiClient('test-token')
        // `b` was served with another fingerprint, `c` is not held, and a row
        // that never got a fingerprint counts as not held as served.
        markReconcilePage('session-1', {
            epoch: 3,
            rows: window([['a', 'aaaaaaaaaaaa'], ['b', 'bbbbbbbbbbbb'], ['unlabelled', undefined]])
        })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual([
            '/api/sessions/session-1/messages?limit=200&knownEpoch=3&withRowHashes=1&rowHashes=1&manifestAnyEpoch=1',
            '/api/sessions/session-1/messages?limit=200&knownEpoch=3&withRowHashes=1&ids=b,c'
        ])
        expect(response.messages).toEqual([fresh, added])
        expect(response.page).toEqual(page({ rowHashes: list }))
    })

    it('returns the page itself when the hub answers with it', async () => {
        const whole = [row('a', 'a', 'aaaaaaaaaaaa')]
        // An older hub ignores the manifest…
        fetchMock.mockResolvedValueOnce(json(body(whole)))
        const api = new ApiClient('test-token')
        markReconcilePage('session-1', { epoch: 3, rows: window([['a', 'aaaaaaaaaaaa']]) })
        expect(await api.getMessages('session-1', { limit: 200 })).toEqual(body(whole))

        // …and the hub answers with the page once the epoch has moved on.
        fetchMock.mockResolvedValueOnce(json(body(whole, { epoch: 4 })))
        markReconcilePage('session-1', { epoch: 3, rows: window([['a', 'aaaaaaaaaaaa']]) })
        expect(await api.getMessages('session-1', { limit: 200 })).toEqual(body(whole, { epoch: 4 }))
        expect(urls()).toHaveLength(2)
    })

    it('returns the page itself when the epoch moves on between the manifest and the rows', async () => {
        const whole = [row('a', 'a', 'aaaaaaaaaaaa')]
        fetchMock
            .mockResolvedValueOnce(json(body([], { rowHashes: [{ id: 'a', hash: '000000000000' }] })))
            .mockResolvedValueOnce(json(body(whole, { epoch: 4 })))
        const api = new ApiClient('test-token')
        markReconcilePage('session-1', { epoch: 3, rows: window([['a', 'aaaaaaaaaaaa']]) })

        expect(await api.getMessages('session-1', { limit: 200 })).toEqual(body(whole, { epoch: 4 }))
    })

    it('the mark is one shot and only ever narrows a full latest page of its own session', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(json(body([]))))
        const api = new ApiClient('test-token')
        const mark = { epoch: 3, rows: window([]) }

        // Another session's request drops it…
        markReconcilePage('session-1', mark)
        await api.getMessages('session-2', { limit: 200 })
        expect(queryOf(urls()[0]).has('rowHashes')).toBe(false)
        await api.getMessages('session-1', { limit: 200 })
        expect(queryOf(urls()[1]).has('rowHashes')).toBe(false)

        // …and so does a page of another shape, so it cannot wait for a replacement page.
        markReconcilePage('session-1', mark)
        await api.getMessages('session-1', { limit: 20 })
        await api.getMessages('session-1', { beforeAt: 900, beforeSeq: 7, limit: 200 })
        expect(urls().slice(2).some((url) => queryOf(url).has('rowHashes'))).toBe(false)
    })

    it('a failed manifest fails the reconcile like any failed request', async () => {
        fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))
        const api = new ApiClient('test-token')
        markReconcilePage('session-1', { epoch: 3, rows: window([]) })
        await expect(api.getMessages('session-1', { limit: 200 })).rejects.toThrow()
    })

    it(`asks for the page itself when the window holds few labelled rows`, async () => {
        // A cold open (its first page only), or a window saved before the hub
        // labelled pages: the page differs in most of its rows, so the manifest
        // would only be a request on top of the page.
        fetchMock.mockImplementation(() => Promise.resolve(json(body([]))))
        const api = new ApiClient('test-token')
        const barely = new Map(Array.from({ length: RECONCILE_MIN_LABELLED_ROWS - 1 }, (_, i) => [`held-${i}`, `${i}`]))
        markReconcilePage('session-1', { epoch: 3, rows: barely })
        await api.getMessages('session-1', { limit: 200 })
        expect(urls()).toEqual(['/api/sessions/session-1/messages?limit=200&withRowHashes=1'])
    })

    it(`lists up to ${RECONCILE_MAX_IDS} differing rows, and beyond that asks for the plain page`, async () => {
        const api = new ApiClient('test-token')
        const listed = Array.from({ length: RECONCILE_MAX_IDS }, (_, i) => `row-${i}`)
        fetchMock
            .mockResolvedValueOnce(json(body([], { rowHashes: listed.map((id, i) => ({ id, hash: `${i}` })) })))
            .mockImplementation(() => Promise.resolve(json(body([]))))
        markReconcilePage('session-1', { epoch: 3, rows: window([]) })
        await api.getMessages('session-1', { limit: 200 })
        const ids = queryOf(urls()[1]).getAll('ids')
        expect(ids).toHaveLength(1)
        expect(ids[0].split(',')).toEqual(listed)

        // One more differing row than that: the whole page, with no id list at all.
        fetchMock.mockReset()
        fetchMock.mockResolvedValueOnce(json(body([], {
            rowHashes: [...listed, 'row-overflow'].map((id, i) => ({ id, hash: `${i}` }))
        })))
        fetchMock.mockImplementation(() => Promise.resolve(json(body([]))))
        markReconcilePage('session-1', { epoch: 3, rows: window([]) })
        await api.getMessages('session-1', { limit: 200 })
        expect(urls()).toEqual([
            '/api/sessions/session-1/messages?limit=200&knownEpoch=3&withRowHashes=1&rowHashes=1&manifestAnyEpoch=1',
            '/api/sessions/session-1/messages?limit=200&withRowHashes=1'
        ])
    })
})

describe('rowsToFetch', () => {
    const mark = { epoch: 1, rows: new Map<string, string | undefined>([['a', 'aaaaaaaaaaaa'], ['unlabelled', undefined]]) }

    it('lists rows that are not held, held without a fingerprint, or held with another one', () => {
        expect(rowsToFetch(mark, [
            { id: 'a', hash: 'aaaaaaaaaaaa' },
            { id: 'unlabelled', hash: '111111111111' },
            { id: 'missing', hash: '222222222222' },
            { id: 'stale', hash: '333333333333' }
        ].filter(({ id }) => id !== 'stale'))).toEqual(['unlabelled', 'missing'])
    })

    it('is empty for an empty manifest', () => {
        expect(rowsToFetch(mark, [])).toEqual([])
    })
})

describe('ApiClient first-page prefetch', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>
    const urls = () => fetchMock.mock.calls.map((call) => String(call[0]))

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
        resetReconcilePageForTests()
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        vi.restoreAllMocks()
        resetReconcilePageForTests()
    })

    it('starts the first page on the tap and hands it to the session page', async () => {
        const first = body([row('a', 'a', 'aaaaaaaaaaaa')], { limit: 20 })
        let resolve: (response: Response) => void = () => {}
        fetchMock.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done }))
        const api = new ApiClient('test-token')

        api.prefetchMessages('session-1', { limit: 20 })
        expect(urls()).toEqual(['/api/sessions/session-1/messages?limit=20&minConversation=1&withRowHashes=1'])

        // The page is still in flight when the session page asks for it.
        const asked = api.getMessages('session-1', { limit: 20 })
        expect(urls()).toHaveLength(1)
        resolve(json(first))
        expect(await asked).toEqual(first)
    })

    it('a consumed page that failed fails for the caller', async () => {
        fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }))
        const api = new ApiClient('test-token')
        api.prefetchMessages('session-1', { limit: 20 })
        await expect(api.getMessages('session-1', { limit: 20 })).rejects.toThrow()
    })

    it('keeps the page for its session when another shape is asked for first', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(json(body([]))))
        const api = new ApiClient('test-token')
        api.prefetchMessages('session-1', { limit: 20 })
        await api.getMessages('session-1', { limit: 200 })
        expect(urls()).toHaveLength(2)
        // A session opened right after another one is asked for a catch-up
        // page first; its first page is still the one started on the tap.
        await api.getMessages('session-1', { limit: 20 })
        expect(urls()).toHaveLength(2)
        // Taken once: the next first page is a new request.
        await api.getMessages('session-1', { limit: 20 })
        expect(urls()).toHaveLength(3)
        expect(urls()[2]).toBe(urls()[0])
    })

    it('drops pages nobody asked for after a while', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(json(body([]))))
        let now = 1_000_000
        vi.spyOn(Date, 'now').mockImplementation(() => now)
        const api = new ApiClient('test-token')
        const stash = () => (api as unknown as { prefetchedPages: Map<string, unknown> }).prefetchedPages

        api.prefetchMessages('old', { limit: 20 })
        now += PREFETCHED_PAGE_TTL_MS + 1
        api.prefetchMessages('fresh', { limit: 20 })
        expect([...stash().keys()]).toHaveLength(1)
        expect([...stash().keys()][0]).toMatch(/^fresh\?limit=20&minConversation=1&withRowHashes=1$/)

        // An expired page is never handed out.
        now += PREFETCHED_PAGE_TTL_MS + 1
        await api.getMessages('fresh', { limit: 20 })
        expect(urls()).toHaveLength(3)
        expect(stash().size).toBe(0)
    })

    it('prefetches the latest page only', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(json(body([]))))
        const api = new ApiClient('test-token')
        api.prefetchMessages('session-1', { beforeAt: 900, beforeSeq: 7, limit: 200 })
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('ApiClient reconcile list prefetch', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>
    const urls = () => fetchMock.mock.calls.map((call) => String(call[0]))

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
        resetReconcilePageForTests()
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        vi.restoreAllMocks()
        resetReconcilePageForTests()
    })

    const listUrl = (sessionId: string, epoch: number) => `/api/sessions/${sessionId}/messages?limit=200&knownEpoch=${epoch}&withRowHashes=1&rowHashes=1&manifestAnyEpoch=1`
    const pageUrl = (sessionId: string) => `/api/sessions/${sessionId}/messages?limit=200&withRowHashes=1`
    const held = window([['a', 'aaaaaaaaaaaa'], ['b', 'bbbbbbbbbbbb'], ['c', 'cccccccccccc']])

    it('starts the list on the tap, for the window\'s epoch', () => {
        fetchMock.mockImplementation(() => Promise.resolve(json(body([]))))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 7)
        expect(urls()).toEqual([listUrl('session-1', 7)])
    })

    const abc = [
        { id: 'a', hash: 'aaaaaaaaaaaa' },
        { id: 'b', hash: 'bbbbbbbbbbbb' },
        { id: 'c', hash: 'cccccccccccc' }
    ]

    it('hands the reconcile the list started on the tap: no request of its own, and no rows when nothing differs', async () => {
        fetchMock.mockResolvedValueOnce(json(body([], { rowHashes: abc })))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        markReconcilePage('session-1', { epoch: 3, rows: held })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual([listUrl('session-1', 3)])
        expect(response.messages).toEqual([])
        // The page is the whole page's; the list rides along on it.
        expect(response.page).toEqual(page({ rowHashes: abc }))
    })

    it('fetches only the rows the prefetched list says differ', async () => {
        const fresh = row('b', 'b changed', 'ffffffffffff')
        const list = [
            { id: 'a', hash: 'aaaaaaaaaaaa' },
            { id: 'b', hash: 'ffffffffffff' },
            { id: 'c', hash: 'cccccccccccc' }
        ]
        fetchMock
            .mockResolvedValueOnce(json(body([], { rowHashes: list })))
            .mockResolvedValueOnce(json(body([fresh])))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        markReconcilePage('session-1', { epoch: 3, rows: held })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual([
            listUrl('session-1', 3),
            '/api/sessions/session-1/messages?limit=200&knownEpoch=3&withRowHashes=1&ids=b'
        ])
        expect(response.messages).toEqual([fresh])
        expect(response.page).toEqual(page({ rowHashes: list }))
    })

    it('answers a moved epoch with the list and only the rows that differ, instead of the page', async () => {
        // The window's rows were read under epoch 3; the first page found the
        // hub on 4; the list asked for on the tap was answered with the list
        // under 4 (manifestAnyEpoch). The rows that differ are asked for
        // under the epoch the list named.
        const fresh = row('b', 'b changed', 'ffffffffffff')
        const list = [
            { id: 'a', hash: 'aaaaaaaaaaaa' },
            { id: 'b', hash: 'ffffffffffff' },
            { id: 'c', hash: 'cccccccccccc' }
        ]
        fetchMock
            .mockResolvedValueOnce(json(body([], { epoch: 4, rowHashes: list })))
            .mockResolvedValueOnce(json(body([fresh], { epoch: 4 })))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        markReconcilePage('session-1', { epoch: 3, rows: held, seenEpoch: 4 })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual([
            listUrl('session-1', 3),
            '/api/sessions/session-1/messages?limit=200&knownEpoch=4&withRowHashes=1&ids=b'
        ])
        expect(response.messages).toEqual([fresh])
        expect(response.page).toEqual(page({ epoch: 4, rowHashes: list }))
    })

    it('asks for nothing beyond the list when a moved epoch left every row the window holds as it was', async () => {
        // A streamed block settled: its snapshot was swept (the window's copy
        // is dropped by the store, which reads the list) and the settled line
        // came with the first page. Nothing is left to fetch.
        const list = [
            { id: 'a', hash: 'aaaaaaaaaaaa' },
            { id: 'b', hash: 'bbbbbbbbbbbb' },
            { id: 'c', hash: 'cccccccccccc' },
            { id: 'settled', hash: '111111111111' }
        ]
        fetchMock
            .mockResolvedValueOnce(json(body([], { epoch: 4, rowHashes: list })))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        // The first page brought `settled` with its fingerprint; `snapshot` has none.
        const withFirstPage = new Map([...held, ['settled', '111111111111'], ['snapshot', undefined]])
        markReconcilePage('session-1', { epoch: 3, rows: withFirstPage, seenEpoch: 4 })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual([listUrl('session-1', 3)])
        expect(response.messages).toEqual([])
        expect(response.page).toEqual(page({ epoch: 4, rowHashes: list }))
    })

    it('takes a list read under a later epoch than the page that found the epoch moved', async () => {
        const list = [{ id: 'a', hash: 'aaaaaaaaaaaa' }, { id: 'b', hash: 'bbbbbbbbbbbb' }, { id: 'c', hash: 'cccccccccccc' }]
        fetchMock.mockResolvedValueOnce(json(body([], { epoch: 5, rowHashes: list })))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        markReconcilePage('session-1', { epoch: 3, rows: held, seenEpoch: 4 })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual([listUrl('session-1', 3)])
        expect(response.page).toEqual(page({ epoch: 5, rowHashes: list }))
    })

    it('asks for the list again when the prefetched one was read before the page that found the epoch moved', async () => {
        // The list left on the tap was read while the hub was still on epoch 3;
        // the first page, read after it, found epoch 4. That list may still
        // name a row the page already lacked: asked for again, and answered
        // under the hub's epoch now.
        const list = [{ id: 'a', hash: 'aaaaaaaaaaaa' }, { id: 'b', hash: 'bbbbbbbbbbbb' }, { id: 'c', hash: 'cccccccccccc' }]
        fetchMock
            .mockResolvedValueOnce(json(body([], { rowHashes: list })))
            .mockResolvedValueOnce(json(body([], { epoch: 4, rowHashes: list })))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        markReconcilePage('session-1', { epoch: 3, rows: held, seenEpoch: 4 })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual([listUrl('session-1', 3), listUrl('session-1', 3)])
        expect(response.page).toEqual(page({ epoch: 4, rowHashes: list }))
    })

    it('asks for the list again when the prefetched one is for an epoch older than the window\'s', async () => {
        // The list left on the tap for epoch 3 and was answered for epoch 3;
        // by the reconcile the window is under epoch 4. One read under a
        // later epoch than the window's is taken as it is.
        const list = [{ id: 'a', hash: 'aaaaaaaaaaaa' }, { id: 'b', hash: 'bbbbbbbbbbbb' }, { id: 'c', hash: 'cccccccccccc' }]
        fetchMock
            .mockResolvedValueOnce(json(body([], { rowHashes: list })))
            .mockResolvedValueOnce(json(body([], { epoch: 4, rowHashes: list })))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        markReconcilePage('session-1', { epoch: 4, rows: held })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual([listUrl('session-1', 3), listUrl('session-1', 4)])
        expect(response.page).toEqual(page({ epoch: 4, rowHashes: list }))

        // A list read under a later epoch than the window's needs no second request.
        fetchMock.mockReset()
        fetchMock.mockResolvedValueOnce(json(body([], { epoch: 5, rowHashes: list })))
        api.prefetchReconcileManifest('session-1', 4)
        markReconcilePage('session-1', { epoch: 4, rows: held })
        const newer = await api.getMessages('session-1', { limit: 200 })
        expect(urls()).toEqual([listUrl('session-1', 4)])
        expect(newer.page).toEqual(page({ epoch: 5, rowHashes: list }))
    })

    it('asks for the list again when the prefetched one failed', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response('nope', { status: 503 }))
            .mockResolvedValueOnce(json(body([], { rowHashes: [{ id: 'a', hash: 'aaaaaaaaaaaa' }] })))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        markReconcilePage('session-1', { epoch: 3, rows: held })

        const response = await api.getMessages('session-1', { limit: 200 })

        expect(urls()).toEqual([listUrl('session-1', 3), listUrl('session-1', 3)])
        expect(response.messages).toEqual([])
    })

    describe('a hub that does not know the any-epoch list', () => {
        const whole = [row('a', 'a', 'aaaaaaaaaaaa'), row('b', 'b changed', 'ffffffffffff')]

        it('returns the page it answered the stale list with, without asking again', async () => {
            // The window's rows were read under epoch 3 and the hub has moved on
            // to 4: the list asked for on the tap came back as the page itself.
            fetchMock.mockResolvedValueOnce(json(body(whole, { epoch: 4 })))
            const api = new ApiClient('test-token')
            api.prefetchReconcileManifest('session-1', 3)
            markReconcilePage('session-1', { epoch: 3, rows: held, seenEpoch: 4 })

            expect(await api.getMessages('session-1', { limit: 200 })).toEqual(body(whole, { epoch: 4 }))
            expect(urls()).toEqual([listUrl('session-1', 3)])
        })

        it('asks for the list itself when the moved-epoch reconcile has no prefetched one: the page is what comes back', async () => {
            fetchMock.mockResolvedValueOnce(json(body(whole, { epoch: 4 })))
            const api = new ApiClient('test-token')
            markReconcilePage('session-1', { epoch: 3, rows: held, seenEpoch: 4 })

            expect(await api.getMessages('session-1', { limit: 200 })).toEqual(body(whole, { epoch: 4 }))
            expect(urls()).toEqual([listUrl('session-1', 3)])
        })

        it('returns the page it answers the list asked for again with', async () => {
            // The prefetched list was read under the old epoch (the hub was
            // still on it); asked for again once the first page found the
            // epoch moved, the page comes back.
            fetchMock
                .mockResolvedValueOnce(json(body([], { rowHashes: [{ id: 'a', hash: 'aaaaaaaaaaaa' }] })))
                .mockResolvedValueOnce(json(body(whole, { epoch: 4 })))
            const api = new ApiClient('test-token')
            api.prefetchReconcileManifest('session-1', 3)
            markReconcilePage('session-1', { epoch: 3, rows: held, seenEpoch: 4 })

            expect(await api.getMessages('session-1', { limit: 200 })).toEqual(body(whole, { epoch: 4 }))
            expect(urls()).toEqual([listUrl('session-1', 3), listUrl('session-1', 3)])
        })
    })

    it('asks for the page itself when more than the listed rows differ under a moved epoch', async () => {
        const listed = Array.from({ length: RECONCILE_MAX_IDS }, (_, i) => `row-${i}`)
        const whole = [row('a', 'a', 'aaaaaaaaaaaa')]
        fetchMock
            .mockResolvedValueOnce(json(body([], { epoch: 4, rowHashes: [...listed, 'row-overflow'].map((id, i) => ({ id, hash: `${i}` })) })))
            .mockResolvedValueOnce(json(body(whole, { epoch: 4 })))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        markReconcilePage('session-1', { epoch: 3, rows: held, seenEpoch: 4 })

        expect(await api.getMessages('session-1', { limit: 200 })).toEqual(body(whole, { epoch: 4 }))
        expect(urls()).toEqual([listUrl('session-1', 3), pageUrl('session-1')])
    })

    it('returns the page when the epoch moves on again between the list and the rows', async () => {
        const list = [{ id: 'a', hash: 'aaaaaaaaaaaa' }, { id: 'b', hash: 'ffffffffffff' }, { id: 'c', hash: 'cccccccccccc' }]
        const whole = [row('a', 'a', 'aaaaaaaaaaaa')]
        fetchMock
            .mockResolvedValueOnce(json(body([], { epoch: 4, rowHashes: list })))
            .mockResolvedValueOnce(json(body(whole, { epoch: 5 })))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        markReconcilePage('session-1', { epoch: 3, rows: held, seenEpoch: 4 })

        expect(await api.getMessages('session-1', { limit: 200 })).toEqual(body(whole, { epoch: 5 }))
        expect(urls()).toEqual([
            listUrl('session-1', 3),
            '/api/sessions/session-1/messages?limit=200&knownEpoch=4&withRowHashes=1&ids=b'
        ])
    })

    it('leaves the first page alone: each prefetched request answers only its own shape', async () => {
        const first = body([row('a', 'a', 'aaaaaaaaaaaa')], { limit: 20 })
        fetchMock.mockImplementation(() => Promise.resolve(json(first)))
        const api = new ApiClient('test-token')
        api.prefetchMessages('session-1', { limit: 20 })
        api.prefetchReconcileManifest('session-1', 3)
        expect(urls()).toEqual([
            '/api/sessions/session-1/messages?limit=20&minConversation=1&withRowHashes=1',
            listUrl('session-1', 3)
        ])
        // The first page's request consumes only the first page.
        await api.getMessages('session-1', { limit: 20 })
        expect(urls()).toHaveLength(2)
        // The reconcile's list waits for the reconcile; a plain full page does not take it.
        await api.getMessages('session-1', { limit: 200 })
        expect(urls()).toHaveLength(3)
        expect(urls()[2]).toBe(pageUrl('session-1'))
    })

    it('the lists of two sessions are each their own', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(json(body([], { rowHashes: [
            { id: 'a', hash: 'aaaaaaaaaaaa' }, { id: 'b', hash: 'bbbbbbbbbbbb' }, { id: 'c', hash: 'cccccccccccc' }
        ] }))))
        const api = new ApiClient('test-token')
        api.prefetchReconcileManifest('session-1', 3)
        api.prefetchReconcileManifest('session-2', 3)
        markReconcilePage('session-1', { epoch: 3, rows: held })
        await api.getMessages('session-1', { limit: 200 })
        // No request for session-1's reconcile beyond the list started on its tap.
        expect(urls()).toHaveLength(2)
        markReconcilePage('session-2', { epoch: 3, rows: held })
        await api.getMessages('session-2', { limit: 200 })
        expect(urls()).toHaveLength(2)
    })
})

describe('reconcile list queries', () => {
    it('is the fingerprint list of the newest page for one epoch', () => {
        expect(reconcileManifestQuery(12)).toBe('limit=200&knownEpoch=12&withRowHashes=1&rowHashes=1&manifestAnyEpoch=1')
        expect(isReconcileManifestQuery(reconcileManifestQuery(12))).toBe(true)
    })

    it('tells the list from the first page, the plain page, and the row request', () => {
        expect(isReconcileManifestQuery('limit=20&minConversation=1&withRowHashes=1')).toBe(false)
        expect(isReconcileManifestQuery('limit=200&withRowHashes=1')).toBe(false)
        expect(isReconcileManifestQuery('limit=200&knownEpoch=12&withRowHashes=1&ids=a,b')).toBe(false)
        expect(isReconcileManifestQuery('limit=200&knownEpoch=12&withRowHashes=1')).toBe(false)
    })
})

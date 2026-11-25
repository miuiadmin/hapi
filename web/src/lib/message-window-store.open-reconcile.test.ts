import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { RECONCILE_MAX_IDS, RECONCILE_MIN_LABELLED_ROWS, resetReconcilePageForTests, takeReconcilePageMark, type ReconcileMark } from '@/api/reconcilePage'
import {
    INITIAL_PAGE_SIZE,
    activateMessageWindow,
    clearMessageWindow,
    getReconcileManifestEpoch,
    getMessageWindowState,
    ingestIncomingMessages,
    syncTailMessages,
    windowNeedsReconcile,
} from '@/lib/message-window-store'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

/** An open's reconcile: the session page activates its window with
 * `reconcileAfterFirstPage`, and once the first page has landed the reconcile
 * runs as the very next sync instead of waiting for the session's event
 * stream to connect and report a gap. */

const touched = new Set<string>()
function sessionId(name: string): string {
    const id = `open-reconcile-${name}`
    touched.add(id)
    return id
}

type Query = NonNullable<Parameters<ApiClient['getMessages']>[1]>

function agentMessage(id: string, seq: number, at: number, rowHash?: string, text = id): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: { type: 'codex', data: { type: 'reasoning', message: text, id: `stream-${id}` } }
        },
        createdAt: at,
        invokedAt: at,
        ...(rowHash ? { rowHash } : {})
    } as DecryptedMessage
}

/** Labelled rows `m<from>`…`m<to>`, ten time units apart, fingerprinted `h<seq>`. */
function rows(from: number, to: number): DecryptedMessage[] {
    return Array.from({ length: to - from + 1 }, (_, index) => {
        const seq = from + index
        return agentMessage(`m${seq}`, seq, seq * 10, `h${seq}`)
    })
}

function basePage(direction: 'latest' | 'after', epoch: number): MessagesResponse['page'] {
    return {
        direction,
        limit: 200,
        epoch,
        reset: false,
        nextBeforeAt: null,
        nextBeforeSeq: null,
        nextAfterAt: null,
        nextAfterSeq: null,
        snapshotHeadAt: null,
        snapshotHeadSeq: null,
        hasMore: false
    }
}

const latest = (messages: DecryptedMessage[], epoch: number, overrides: Partial<MessagesResponse['page']> = {}): MessagesResponse => (
    { messages, page: { ...basePage('latest', epoch), ...overrides } }
)
const after = (messages: DecryptedMessage[], epoch: number, overrides: Partial<MessagesResponse['page']> = {}): MessagesResponse => (
    { messages, page: { ...basePage('after', epoch), ...overrides } }
)

/** A persisted window holding `messages`, its tail at the newest row, read under `epoch`. */
function persistWindow(id: string, messages: DecryptedMessage[], epoch: number): void {
    const newest = messages.at(-1)!
    sessionStorage.setItem(`hapi:message-window:v3:${id}`, JSON.stringify({
        messages,
        hasMore: true,
        oldestPositionAt: messages[0]!.invokedAt,
        oldestPositionSeq: messages[0]!.seq,
        newestPositionAt: newest.invokedAt,
        newestPositionSeq: newest.seq,
        epoch,
        requiresLatestReset: false
    }))
}

function createApi(getMessages: ApiClient['getMessages']): ApiClient {
    return { getMessages, getMessageContext: async () => null } as unknown as ApiClient
}

/**
 * Run an open to the end: the first page's sync arms the reconcile, which runs
 * as the sync right after it; a sync asked for meanwhile joins it.
 */
async function openWindow(api: ApiClient, id: string): Promise<void> {
    await syncTailMessages(api, id)
    await syncTailMessages(api, id)
}

const idsOf = (id: string) => getMessageWindowState(id).messages.map((message) => message.id)

/** `m<seq>` ids in a row with no position missing between them. */
function contiguous(ids: string[]): boolean {
    const seqs = ids.map((id) => Number(id.slice(1)))
    return seqs.every((seq, index) => index === 0 || seq === seqs[index - 1]! + 1)
}

beforeEach(() => {
    resetReconcilePageForTests()
    sessionStorage.clear()
})

afterEach(() => {
    for (const id of touched) clearMessageWindow(id)
    touched.clear()
    sessionStorage.clear()
    resetReconcilePageForTests()
})

describe('an open reconciles as soon as its first page has landed', () => {
    it('asks for the first page, then the reconcile page at once: no catch-up when the head is where the cached window ended', async () => {
        const id = sessionId('same-head')
        const cached = rows(31, 100)
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        const queries: Query[] = []
        const marks: Array<ReconcileMark | null> = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.afterAt !== undefined) throw new Error('the catch-up is skipped: nothing is newer than the first page')
            if (query.limit === INITIAL_PAGE_SIZE) {
                return latest(cached.slice(-20), 1, { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: true, nextBeforeAt: 810, nextBeforeSeq: 81 })
            }
            // The transport narrows this request to the fingerprint list (see ApiClient); here the mark is what matters.
            marks.push(takeReconcilePageMark(id))
            return latest([], 1, { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: true, nextBeforeAt: 310, nextBeforeSeq: 31 })
        })

        await openWindow(api, id)

        expect(queries).toEqual([{ limit: INITIAL_PAGE_SIZE }, { limit: 200 }])
        expect(marks).toHaveLength(1)
        expect(marks[0]!.epoch).toBe(1)
        expect(marks[0]!.rows.size).toBe(70)
        expect(marks[0]).not.toHaveProperty('seenEpoch')
        expect(getMessageWindowState(id)).toMatchObject({
            isSyncingTail: false,
            pendingGapRecovery: false,
            preferLatestOnActivation: false,
            warning: null,
            epoch: 1
        })
        expect(idsOf(id)).toEqual(cached.map((message) => message.id))
    })

    it('catches up from where the cached window ended when the first page does not reach it', async () => {
        const id = sessionId('head-moved')
        const cached = rows(31, 100)
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        const queries: Query[] = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.afterAt !== undefined) {
                return after(rows(101, 150), 1, { nextAfterAt: 1_500, nextAfterSeq: 150, snapshotHeadAt: 1_500, snapshotHeadSeq: 150 })
            }
            if (query.limit === INITIAL_PAGE_SIZE) {
                return latest(rows(131, 150), 1, { snapshotHeadAt: 1_500, snapshotHeadSeq: 150, hasMore: true, nextBeforeAt: 1_310, nextBeforeSeq: 131 })
            }
            return latest(rows(131, 150), 1, { snapshotHeadAt: 1_500, snapshotHeadSeq: 150, hasMore: true, nextBeforeAt: 1_310, nextBeforeSeq: 131 })
        })

        await openWindow(api, id)

        expect(queries).toHaveLength(3)
        // From the cached tail (m100), not from the first page's head: the fifty rows the first page does not reach are walked.
        expect(queries[1]).toMatchObject({ afterAt: 1_000, afterSeq: 100, epoch: 1, limit: 200 })
        expect(idsOf(id)).toEqual(rows(31, 150).map((message) => message.id))
        expect(getMessageWindowState(id)).toMatchObject({ pendingGapRecovery: false, warning: null, epoch: 1 })
    })

    // The server's rows `from`…`to` after a catch-up request, `hasMore` saying whether more follow.
    const caughtUp = (from: number, to: number, hasMore: boolean): MessagesResponse => (
        after(rows(from, to), 1, { nextAfterAt: to * 10, nextAfterSeq: to, snapshotHeadAt: 18_300, snapshotHeadSeq: 1_830, hasMore })
    )

    it('stops the catch-up at three pages when the window is far behind, and the newest page replaces the window (X3-4)', async () => {
        const id = sessionId('far-behind')
        // The cached window ended at m1030; the server has eight hundred rows more.
        persistWindow(id, rows(831, 1030), 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        const queries: Query[] = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.afterAt !== undefined) {
                const page = Math.floor((query.afterAt! - 10_300) / 2_000)
                return caughtUp(1_031 + page * 200, 1_230 + page * 200, true)
            }
            if (query.limit === INITIAL_PAGE_SIZE) {
                return latest(rows(1_811, 1_830), 1, { snapshotHeadAt: 18_300, snapshotHeadSeq: 1_830, hasMore: true, nextBeforeAt: 18_110, nextBeforeSeq: 1_811 })
            }
            return latest(rows(1_631, 1_830), 1, { snapshotHeadAt: 18_300, snapshotHeadSeq: 1_830, hasMore: true, nextBeforeAt: 16_310, nextBeforeSeq: 1_631 })
        })

        await openWindow(api, id)

        // The first page, three catch-up pages from the cached tail, then the page itself: no fourth catch-up, no reconcile.
        expect(queries).toHaveLength(5)
        expect(queries.slice(1, 4).map((query) => query.afterSeq)).toEqual([1_030, 1_230, 1_430])
        expect(queries[4]).toEqual({ limit: 200 })
        const ids = idsOf(id)
        expect(ids).toEqual(rows(1_631, 1_830).map((message) => message.id))
        expect(contiguous(ids)).toBe(true)
        expect(getMessageWindowState(id)).toMatchObject({ isSyncingTail: false, pendingGapRecovery: false, warning: null, epoch: 1, hasMore: true })
    })

    it('walks the whole way when the window is three pages behind: the third page is the last, nothing is replaced', async () => {
        const id = sessionId('three-pages-behind')
        // Six hundred rows more (m1031–m1630): exactly three pages, the last of them the end of it.
        persistWindow(id, rows(831, 1030), 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        const queries: Query[] = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.afterAt !== undefined) {
                const page = Math.floor((query.afterAt! - 10_300) / 2_000)
                return caughtUp(1_031 + page * 200, 1_230 + page * 200, page < 2)
            }
            if (query.limit === INITIAL_PAGE_SIZE) {
                return latest(rows(1_611, 1_630), 1, { snapshotHeadAt: 16_300, snapshotHeadSeq: 1_630, hasMore: true, nextBeforeAt: 16_110, nextBeforeSeq: 1_611 })
            }
            takeReconcilePageMark(id)
            return latest(rows(1_431, 1_630), 1, { snapshotHeadAt: 16_300, snapshotHeadSeq: 1_630, hasMore: true, nextBeforeAt: 14_310, nextBeforeSeq: 1_431 })
        })

        await openWindow(api, id)

        // The first page, the three catch-up pages from the cached tail, then the reconcile: no replacement.
        expect(queries.map((query) => query.afterSeq ?? query.limit)).toEqual([INITIAL_PAGE_SIZE, 1_030, 1_230, 1_430, 200])
        const ids = idsOf(id)
        expect(ids).toEqual(rows(1_231, 1_630).map((message) => message.id))
        expect(contiguous(ids)).toBe(true)
        expect(getMessageWindowState(id)).toMatchObject({ isSyncingTail: false, pendingGapRecovery: false, warning: null })
    })

    it('a cold open always reconciles: the first page, the catch-up, then the newest page', async () => {
        const id = sessionId('cold')
        activateMessageWindow(id, { reconcileAfterFirstPage: true })
        const queries: Query[] = []
        const marks: Array<ReconcileMark | null> = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.afterAt !== undefined) return after([], 1, { nextAfterAt: 200, nextAfterSeq: 20, snapshotHeadAt: 200, snapshotHeadSeq: 20 })
            // The mark describes the window; with too few labelled rows the transport asks for the page itself.
            if (query.limit === 200) marks.push(takeReconcilePageMark(id))
            return latest(rows(1, 20), 1, { snapshotHeadAt: 200, snapshotHeadSeq: 20 })
        })

        await openWindow(api, id)

        expect(queries).toHaveLength(3)
        expect(queries[0]).toEqual({ limit: INITIAL_PAGE_SIZE })
        expect(queries[1]).toMatchObject({ afterAt: 200, afterSeq: 20, epoch: 1, limit: 200 })
        expect(queries[2]).toEqual({ limit: 200 })
        expect(marks).toHaveLength(1)
        expect(marks[0]).toMatchObject({ epoch: 1 })
        expect(marks[0]!.rows.size).toBe(20)
        expect(marks[0]).not.toHaveProperty('seenEpoch')
        expect(idsOf(id)).toEqual(rows(1, 20).map((message) => message.id))
        expect(getMessageWindowState(id)).toMatchObject({ isSyncingTail: false, pendingGapRecovery: false, warning: null })
    })

    it('the sync that asked for the first page is done before the reconcile; the next one joins it', async () => {
        const id = sessionId('two-syncs')
        activateMessageWindow(id, { reconcileAfterFirstPage: true })
        const reconcile = new Promise<MessagesResponse>((resolve) => setTimeout(() => resolve(latest(rows(1, 5), 1, { snapshotHeadAt: 50, snapshotHeadSeq: 5 })), 20))
        const catchUp = new Promise<MessagesResponse>((resolve) => setTimeout(() => resolve(after([], 1, { nextAfterAt: 50, nextAfterSeq: 5, snapshotHeadAt: 50, snapshotHeadSeq: 5 })), 10))
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) return await catchUp
            return query.limit === INITIAL_PAGE_SIZE ? latest(rows(1, 5), 1, { snapshotHeadAt: 50, snapshotHeadSeq: 5 }) : await reconcile
        })

        await syncTailMessages(api, id)
        // First page applied and its sync finished; the reconcile it armed is the sync now running.
        expect(idsOf(id)).toEqual(rows(1, 5).map((message) => message.id))
        expect(getMessageWindowState(id)).toMatchObject({ isSyncingTail: true, pendingGapRecovery: true })

        const calls = vi.fn()
        void syncTailMessages(api, id).then(calls)
        await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1))
        expect(getMessageWindowState(id)).toMatchObject({ isSyncingTail: false, pendingGapRecovery: false })
    })
})

describe('an open that finds the session\'s epoch moved on keeps its window', () => {
    const cached = rows(31, 100)
    const PAGE = { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: true, nextBeforeAt: 310, nextBeforeSeq: 31 }
    const FIRST = { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: true, nextBeforeAt: 810, nextBeforeSeq: 81 }

    function edited(message: DecryptedMessage, rowHash: string): DecryptedMessage {
        return {
            ...message,
            rowHash,
            content: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'reasoning', message: `${message.id} edited`, id: `stream-${message.id}` } }
            }
        } as DecryptedMessage
    }

    /**
     * The reconcile's answer in one of its two shapes. `page`: the labelled
     * page itself, which a hub that does not know the list is wanted under any
     * epoch answers a stale list with (ApiClient.getReconcilePage hands it on).
     * `list`: the page's fingerprint list with `messages` narrowed to the rows
     * that differ, which the transport answers a hub that does know it with.
     */
    const answer = (shape: 'page' | 'list', listed: DecryptedMessage[], differing: DecryptedMessage[], overrides: Partial<MessagesResponse['page']> = {}): MessagesResponse => (
        shape === 'page'
            ? latest(listed, 2, overrides)
            : latest(differing, 2, { ...overrides, rowHashes: listed.map((message) => ({ id: message.id, hash: message.rowHash ?? '' })) })
    )
    const shapes: Array<'page' | 'list'> = ['page', 'list']
    const shapeName = (shape: 'page' | 'list') => (shape === 'page' ? 'the labelled page (a hub without the any-epoch list)' : 'the list and the rows that differ (a hub with it)')

    for (const shape of shapes) {
        it(`takes the changed row, drops nothing else, and moves to the new epoch — ${shapeName(shape)}`, async () => {
            const id = sessionId(`epoch-moved-${shape}`)
            persistWindow(id, cached, 1)
            activateMessageWindow(id, { reconcileAfterFirstPage: true })
            const hydrated = getMessageWindowState(id).messages

            const queries: Query[] = []
            const marks: Array<ReconcileMark | null> = []
            const page = cached.map((message) => (message.id === 'm60' ? edited(message, 'h60-edited') : message))
            const api = createApi(async (_sessionId, query) => {
                queries.push(query)
                if (query.afterAt !== undefined) throw new Error('no catch-up: the page carries every row the window lacks')
                if (query.limit === INITIAL_PAGE_SIZE) return latest(cached.slice(-20), 2, FIRST)
                marks.push(takeReconcilePageMark(id))
                return answer(shape, page, [page[29]!], PAGE)
            })

            await openWindow(api, id)

            expect(queries).toEqual([{ limit: INITIAL_PAGE_SIZE }, { limit: 200 }])
            expect(marks).toHaveLength(1)
            // The window's rows stay labelled with the old epoch until checked; the first page's epoch is what the list must be read under or after.
            expect(marks[0]).toMatchObject({ epoch: 1, seenEpoch: 2 })
            expect(marks[0]!.rows.get('m99')).toBe('h99')
            expect(idsOf(id)).toEqual(cached.map((message) => message.id))
            const state = getMessageWindowState(id)
            expect(state.messages).toHaveLength(70)
            expect(state.messages.find((message) => message.id === 'm60')?.rowHash).toBe('h60-edited')
            expect(state.messages.find((message) => message.id === 'm60')?.content).toEqual(page[29]!.content)
            // The rows that did not change are the very same objects the window was restored with.
            expect(state.messages.find((message) => message.id === 'm61')).toBe(hydrated.find((message) => message.id === 'm61'))
            expect(state).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null, isSyncingTail: false })
        })

        it(`drops a row the page no longer lists inside its range, keeps older rows and the client's own — ${shapeName(shape)}`, async () => {
            const id = sessionId(`epoch-removed-${shape}`)
            const queued = {
                id: 'local-1',
                localId: 'local-1',
                seq: null,
                createdAt: 995,
                invokedAt: null,
                status: 'queued',
                content: { role: 'user', content: { type: 'text', text: 'queued prompt' } }
            } as DecryptedMessage
            persistWindow(id, [...rows(21, 100), queued], 1)
            activateMessageWindow(id, { reconcileAfterFirstPage: true })

            // m60 was removed on the server; the page starts at m31, so m21–m30 are older than it.
            const page = rows(31, 100).filter((message) => message.id !== 'm60')
            const api = createApi(async (_sessionId, query) => {
                if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
                if (query.limit === INITIAL_PAGE_SIZE) return latest(rows(81, 100), 2, FIRST)
                takeReconcilePageMark(id)
                return answer(shape, page, [], PAGE)
            })

            await openWindow(api, id)

            // The queued prompt sits where its creation time puts it: between m99 and m100.
            expect(idsOf(id)).toEqual([
                ...rows(21, 99).map((message) => message.id).filter((id) => id !== 'm60'),
                'local-1',
                'm100'
            ])
            expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null })
        })

        it(`keeps a row that reached the window over the event stream while the first page was in flight — ${shapeName(shape)}`, async () => {
            // The list (or the page) was read by the hub on the tap. A row that
            // arrives after that — an answer settling while the open's first
            // page is still on the wire — reaches the window over the global
            // stream, is shown, and is not named by that page. It is newer
            // than the page, not removed: the reconcile must not drop it.
            const id = sessionId(`epoch-streamed-${shape}`)
            persistWindow(id, cached, 1)
            activateMessageWindow(id, { reconcileAfterFirstPage: true })
            const page = cached.filter((message) => message.id !== 'm60')
            const streamed = agentMessage('streamed', 101, 1_010)
            const api = createApi(async (_sessionId, query) => {
                if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
                if (query.limit === INITIAL_PAGE_SIZE) {
                    ingestIncomingMessages(id, [streamed])
                    return latest(cached.slice(-20), 2, FIRST)
                }
                takeReconcilePageMark(id)
                return answer(shape, page, [], PAGE)
            })

            await openWindow(api, id)

            expect(idsOf(id)).toEqual([...page.map((message) => message.id), 'streamed'])
            expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null, isSyncingTail: false })
        })

        it(`drops what a whole-session page no longer lists, wherever the row sat — ${shapeName(shape)}`, async () => {
            const id = sessionId(`epoch-shrunk-${shape}`)
            persistWindow(id, rows(21, 100), 1)
            activateMessageWindow(id, { reconcileAfterFirstPage: true })

            // Rows m21–m24 were removed; m60 changed in place. The session is small enough for the page to be all of it.
            const page = rows(25, 100).map((message) => (message.id === 'm60' ? edited(message, 'h60-edited') : message))
            const whole = { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: false, nextBeforeAt: 250, nextBeforeSeq: 25 }
            const api = createApi(async (_sessionId, query) => {
                if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
                if (query.limit === INITIAL_PAGE_SIZE) return latest(page.slice(-20), 2, whole)
                takeReconcilePageMark(id)
                return answer(shape, page, [page[35]!], whole)
            })

            await openWindow(api, id)

            expect(idsOf(id)).toEqual(page.map((message) => message.id))
            expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, hasMore: false, pendingGapRecovery: false, warning: null })
        })
    }

    it('replaces the window with the page when its tail when the open began is older than the page\'s range: no silent hole between them', async () => {
        // The cached window ended at m1030 under epoch 1; the server went on to m1280 and moved the epoch to 2.
        // The newest page (m1081–m1280) does not reach the window, so the rows m1031–m1080 are in neither.
        // The list names the page and differs in ten rows only — a patch would leave the hole for good.
        const id = sessionId('epoch-moved-hole')
        persistWindow(id, rows(831, 1030), 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        const queries: Query[] = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
            if (query.limit === INITIAL_PAGE_SIZE) {
                return latest(rows(1_261, 1_280), 2, { snapshotHeadAt: 12_800, snapshotHeadSeq: 1_280, hasMore: true, nextBeforeAt: 12_610, nextBeforeSeq: 1_261 })
            }
            if (takeReconcilePageMark(id) !== null) {
                const page = rows(1_081, 1_280)
                return latest(page.slice(0, 10), 2, {
                    snapshotHeadAt: 12_800, snapshotHeadSeq: 1_280, hasMore: true, nextBeforeAt: 10_810, nextBeforeSeq: 1_081,
                    rowHashes: page.map((message) => ({ id: message.id, hash: message.rowHash ?? '' }))
                })
            }
            return latest(rows(1_081, 1_280), 2, { snapshotHeadAt: 12_800, snapshotHeadSeq: 1_280, hasMore: true, nextBeforeAt: 10_810, nextBeforeSeq: 1_081 })
        })

        await openWindow(api, id)

        // The first page, the list, then the page itself: the window is the page, as a cold open's would be.
        expect(queries).toEqual([{ limit: INITIAL_PAGE_SIZE }, { limit: 200 }, { limit: 200 }])
        const ids = idsOf(id)
        expect(ids).toEqual(rows(1_081, 1_280).map((message) => message.id))
        expect(contiguous(ids)).toBe(true)
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null, isSyncingTail: false })
    })

    it(`replaces the window with the labelled page when more than ${RECONCILE_MAX_IDS} rows of it differ (a hub without the any-epoch list)`, async () => {
        const id = sessionId('epoch-rewind-page')
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        // A rewind: nothing the window holds is on the server any more, and
        // the session now holds seventy rows the window never saw. The page
        // is the whole session.
        const page = rows(201, 270).map((message) => ({ ...message, rowHash: `h${message.seq}` }))
        const whole = { snapshotHeadAt: 2_700, snapshotHeadSeq: 270, hasMore: false, nextBeforeAt: 2_010, nextBeforeSeq: 201 }
        const queries: Query[] = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
            if (query.limit === INITIAL_PAGE_SIZE) return latest(page.slice(-20), 2, whole)
            takeReconcilePageMark(id)
            return answer('page', page, page, whole)
        })

        await openWindow(api, id)

        expect(queries).toEqual([{ limit: INITIAL_PAGE_SIZE }, { limit: 200 }])
        expect(idsOf(id)).toEqual(page.map((message) => message.id))
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null })
    })

    it(`keeps a row that reached the window over the event stream while the first page was in flight, when a page too different to patch replaces the window`, async () => {
        const id = sessionId('epoch-streamed-rewind')
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })
        const page = rows(201, 270).map((message) => ({ ...message, rowHash: `h${message.seq}` }))
        const whole = { snapshotHeadAt: 2_700, snapshotHeadSeq: 270, hasMore: false, nextBeforeAt: 2_010, nextBeforeSeq: 201 }
        const streamed = agentMessage('streamed', 271, 2_710)
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
            if (query.limit === INITIAL_PAGE_SIZE) {
                ingestIncomingMessages(id, [streamed])
                return latest(page.slice(-20), 2, whole)
            }
            takeReconcilePageMark(id)
            return answer('page', page, page, whole)
        })

        await openWindow(api, id)

        expect(idsOf(id)).toEqual([...page.map((message) => message.id), 'streamed'])
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null })
    })

    it(`asks for the page itself when the list leaves more than ${RECONCILE_MAX_IDS} rows of the window to drop, and replaces the window with it`, async () => {
        const id = sessionId('epoch-list-rewind')
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        // A rewind to m30, then five new rows: every row the window held from
        // m31 to m95 is gone (65), and the fifteen rows before them are new
        // to the window. The list has nothing to fetch beyond those fifteen,
        // but too much to drop for a patch: the page is asked for as well.
        const page = [...rows(16, 30), ...rows(96, 100)]
        const whole = { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: false, nextBeforeAt: 160, nextBeforeSeq: 16 }
        const queries: Query[] = []
        const answers: MessagesResponse[] = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
            if (query.limit === INITIAL_PAGE_SIZE) return latest(rows(96, 100), 2, whole)
            takeReconcilePageMark(id)
            // The first full page asked for is the list and its rows; the second is the page itself.
            const response = answers.length === 0
                ? latest(rows(16, 30), 2, { ...whole, rowHashes: page.map((message) => ({ id: message.id, hash: message.rowHash ?? '' })) })
                : latest(page, 2, whole)
            answers.push(response)
            return response
        })

        await openWindow(api, id)

        expect(queries).toEqual([{ limit: INITIAL_PAGE_SIZE }, { limit: 200 }, { limit: 200 }])
        expect(idsOf(id)).toEqual(page.map((message) => message.id))
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, hasMore: false, pendingGapRecovery: false, warning: null, isSyncingTail: false })
    })

    it('keeps a row the list still names with the fingerprint the window holds when the rows asked for after it are fewer', async () => {
        // The list names seventy rows, three of which differ; the rows that
        // came back are those three. Nothing else is taken or dropped.
        const id = sessionId('epoch-list-partial')
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })
        const page = cached.map((message) => (['m40', 'm60', 'm80'].includes(message.id) ? edited(message, `${message.rowHash}-edited`) : message))
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) throw new Error('no catch-up after an epoch change')
            if (query.limit === INITIAL_PAGE_SIZE) return latest(cached.slice(-20), 2, FIRST)
            takeReconcilePageMark(id)
            return latest([page[9]!, page[29]!, page[49]!], 2, { ...PAGE, rowHashes: page.map((message) => ({ id: message.id, hash: message.rowHash ?? '' })) })
        })

        await openWindow(api, id)

        const state = getMessageWindowState(id)
        expect(idsOf(id)).toEqual(cached.map((message) => message.id))
        expect(state.messages.filter((message) => message.rowHash?.endsWith('-edited')).map((message) => message.id)).toEqual(['m40', 'm60', 'm80'])
        expect(state).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null })
    })

    it('checks the window against a list the hub read under a newer epoch than the first page, when the first page found nothing moved', async () => {
        // The first page was read under the window's epoch; the epoch moved on
        // before the list was read (ApiClient.getReconcilePage takes such a
        // list: it is newer than everything the window has read).
        const id = sessionId('epoch-list-newer')
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })
        const page = cached.filter((message) => message.id !== 'm60')
        const queries: Query[] = []
        const marks: Array<ReconcileMark | null> = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.afterAt !== undefined) throw new Error('no catch-up: the head did not move')
            if (query.limit === INITIAL_PAGE_SIZE) return latest(cached.slice(-20), 1, FIRST)
            marks.push(takeReconcilePageMark(id))
            return latest([], 2, { ...PAGE, rowHashes: page.map((message) => ({ id: message.id, hash: message.rowHash ?? '' })) })
        })

        await openWindow(api, id)

        expect(queries).toEqual([{ limit: INITIAL_PAGE_SIZE }, { limit: 200 }])
        expect(marks[0]).toMatchObject({ epoch: 1 })
        expect(marks[0]).not.toHaveProperty('seenEpoch')
        expect(idsOf(id)).toEqual(page.map((message) => message.id))
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null })
    })

    it('a list under the window\'s own epoch is an upsert, as it always was: nothing is dropped', async () => {
        const id = sessionId('epoch-list-same')
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })
        // The hub no longer lists m60 but did not move the epoch: not a removal the window acts on.
        const page = cached.filter((message) => message.id !== 'm60')
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) throw new Error('no catch-up: the head did not move')
            if (query.limit === INITIAL_PAGE_SIZE) return latest(cached.slice(-20), 1, FIRST)
            takeReconcilePageMark(id)
            return latest([], 1, { ...PAGE, rowHashes: page.map((message) => ({ id: message.id, hash: message.rowHash ?? '' })) })
        })

        await openWindow(api, id)

        expect(idsOf(id)).toEqual(cached.map((message) => message.id))
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 1, pendingGapRecovery: false, warning: null })
    })

    it('keeps the old epoch label until the page has been checked, so a failed check is still answered with a reset', async () => {
        const id = sessionId('epoch-failed-check')
        persistWindow(id, cached, 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })

        const queries: Query[] = []
        let fail = true
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            if (query.limit === INITIAL_PAGE_SIZE) {
                return latest(cached.slice(-20), 2, FIRST)
            }
            if (fail) throw new Error('page unavailable')
            // The next plain sync asks with the epoch the window still claims; the hub answers the page with a reset verdict.
            return latest(rows(201, 270), 2, { reset: true, snapshotHeadAt: 2_700, snapshotHeadSeq: 270 })
        })

        await openWindow(api, id)

        // The first page is applied (its rows read under epoch 2), the check failed: the window keeps its rows, its old label, and the pending reconcile.
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 1, pendingGapRecovery: true, warning: 'page unavailable', isSyncingTail: false })
        expect(idsOf(id)).toEqual(cached.map((message) => message.id))

        fail = false
        await syncTailMessages(api, id)

        expect(queries[2]).toMatchObject({ afterAt: 1_000, afterSeq: 100, epoch: 1, limit: 200 })
        expect(idsOf(id)).toEqual(rows(201, 270).map((message) => message.id))
        expect(getMessageWindowState(id)).toMatchObject({ epoch: 2, pendingGapRecovery: false, warning: null })
    })
})

describe('what an open leaves to the session stream\'s first connection', () => {
    it('the fingerprint list is prefetched only for a window the list pays for', () => {
        const cold = sessionId('hint-cold')
        expect(getReconcileManifestEpoch(cold)).toBeNull()

        const few = sessionId('hint-few')
        persistWindow(few, rows(1, RECONCILE_MIN_LABELLED_ROWS - 1).map((message) => ({ ...message, rowHash: `h${message.seq}` })), 3)
        expect(getReconcileManifestEpoch(few)).toBeNull()

        const unlabelled = sessionId('hint-unlabelled')
        // A window saved before the hub labelled pages: its rows carry no fingerprint.
        persistWindow(unlabelled, rows(1, 100).map(({ rowHash: _rowHash, ...message }) => message as DecryptedMessage), 3)
        expect(getMessageWindowState(unlabelled).messages.every((message) => message.rowHash === undefined)).toBe(true)
        expect(getReconcileManifestEpoch(unlabelled)).toBeNull()

        const enough = sessionId('hint-enough')
        persistWindow(enough, rows(1, RECONCILE_MIN_LABELLED_ROWS).map((message) => ({ ...message, rowHash: `h${message.seq}` })), 7)
        expect(getReconcileManifestEpoch(enough)).toBe(7)
        // Reading the hint hydrates the window, nothing more: it is still a cached re-entry.
        expect(getMessageWindowState(enough)).toMatchObject({ preferLatestOnActivation: false, isSyncingTail: false })
    })

    it('a reconcile is left to the stream only when the open\'s own did not run or did not finish', async () => {
        const id = sessionId('needs')
        // Nothing read yet: a cold open whose first page has not landed.
        expect(windowNeedsReconcile(id)).toBe(true)

        activateMessageWindow(id, { reconcileAfterFirstPage: true })
        const api = createApi(async (_sessionId, query) => (
            query.afterAt !== undefined
                ? after([], 1, { nextAfterAt: 50, nextAfterSeq: 5, snapshotHeadAt: 50, snapshotHeadSeq: 5 })
                : latest(rows(1, 5), 1, { snapshotHeadAt: 50, snapshotHeadSeq: 5 })
        ))
        await openWindow(api, id)
        // Reconciled by the open itself.
        expect(windowNeedsReconcile(id)).toBe(false)

        const failed = sessionId('needs-failed')
        persistWindow(failed, rows(1, 100).map((message) => ({ ...message, rowHash: `h${message.seq}` })), 1)
        activateMessageWindow(failed)
        const failing = createApi(async () => {
            throw new Error('offline')
        })
        await syncTailMessages(failing, failed)
        // The first page failed: the stream's gap must still recover it.
        expect(windowNeedsReconcile(failed)).toBe(true)
    })

    it('a cached window whose first page is still out is left to its own sync', () => {
        const id = sessionId('needs-in-flight')
        persistWindow(id, rows(1, 100).map((message) => ({ ...message, rowHash: `h${message.seq}` })), 1)
        activateMessageWindow(id, { reconcileAfterFirstPage: true })
        let release: (response: MessagesResponse) => void = () => {}
        const firstPage = new Promise<MessagesResponse>((resolve) => { release = resolve })
        void syncTailMessages(createApi(() => firstPage), id)
        expect(getMessageWindowState(id).isSyncingTail).toBe(true)
        expect(windowNeedsReconcile(id)).toBe(false)
        release(latest(rows(1, 100), 1, { snapshotHeadAt: 1_000, snapshotHeadSeq: 100 }))
    })

    it('a window activated without the request keeps the bare choreography: the first page alone', async () => {
        const id = sessionId('bare')
        const cached = rows(31, 100)
        persistWindow(id, cached, 1)
        activateMessageWindow(id)
        const queries: Query[] = []
        const api = createApi(async (_sessionId, query) => {
            queries.push(query)
            return latest(cached.slice(-20), 1, { snapshotHeadAt: 1_000, snapshotHeadSeq: 100, hasMore: true, nextBeforeAt: 810, nextBeforeSeq: 81 })
        })

        await openWindow(api, id)

        // The second `syncTailMessages` found nothing running: it was a plain
        // cursor sync of its own (the catch-up), not a reconcile the open armed.
        expect(queries.map((query) => query.limit)).toEqual([INITIAL_PAGE_SIZE, 200])
        expect(queries[1]!.afterAt).toBe(1_000)
        expect(getMessageWindowState(id)).toMatchObject({ pendingGapRecovery: false, isSyncingTail: false })
    })
})

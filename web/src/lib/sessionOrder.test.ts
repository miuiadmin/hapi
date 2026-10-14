import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { compareSessionsByOrderKeyDesc, getSessionOrderKey } from './sessionOrder'

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('getSessionOrderKey', () => {
    it('prefers createdAt when present', () => {
        expect(getSessionOrderKey(makeSummary({ id: 'a', createdAt: 5_000, updatedAt: 9_000 }))).toBe(5_000)
    })

    it('falls back to updatedAt for summaries from an older hub', () => {
        expect(getSessionOrderKey(makeSummary({ id: 'a', updatedAt: 9_000 }))).toBe(9_000)
    })
})

describe('compareSessionsByOrderKeyDesc', () => {
    it('sorts newest-created first', () => {
        const older = makeSummary({ id: 'older', createdAt: 1_000 })
        const newer = makeSummary({ id: 'newer', createdAt: 2_000 })
        expect(compareSessionsByOrderKeyDesc(older, newer)).toBeGreaterThan(0)
        expect(compareSessionsByOrderKeyDesc(newer, older)).toBeLessThan(0)
        expect(compareSessionsByOrderKeyDesc(newer, newer)).toBe(0)
    })

    it('ignores updatedAt entirely', () => {
        const stale = makeSummary({ id: 'stale', createdAt: 2_000, updatedAt: 1 })
        const busy = makeSummary({ id: 'busy', createdAt: 1_000, updatedAt: 9_999 })
        // busy is far more recently updated, but older-created: sorts last.
        expect(compareSessionsByOrderKeyDesc(stale, busy)).toBeLessThan(0)
    })
})

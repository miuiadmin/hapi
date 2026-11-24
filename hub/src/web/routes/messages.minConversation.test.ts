import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { MessageContextResponse, MessagesResponse } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import { EventPublisher } from '../../sync/eventPublisher'
import { countConversationRows, isConversationRow } from '../../sync/conversationRows'
import { MessageService } from '../../sync/messageService'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

/** A Claude Code transcript row carrying the given content blocks. */
function agentOutput(dataType: string, blocks: unknown[]): unknown {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: dataType,
                message: { role: dataType, content: blocks }
            }
        }
    }
}

function toolUse(id: string): unknown {
    return agentOutput('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }])
}

function toolResult(id: string): unknown {
    return agentOutput('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }])
}

function assistantText(id: string): unknown {
    return agentOutput('assistant', [{ type: 'text', text: `answer ${id}` }])
}

function userPrompt(id: string): unknown {
    return { role: 'user', content: { type: 'text', text: `question ${id}` } }
}

describe('isConversationRow', () => {
    it('treats prompts, assistant text and anything unfamiliar as conversation', () => {
        expect(isConversationRow({ content: userPrompt('u1') as never })).toBe(true)
        expect(isConversationRow({ content: assistantText('a1') as never })).toBe(true)
        // Reasoning is a visible block, not part of the collapsed tool card.
        const reasoning = agentOutput('assistant', [{ type: 'thinking', thinking: 'hmm' }])
        expect(isConversationRow({ content: reasoning as never })).toBe(true)
        // Other flavours and unknown shapes: never claimed as tool activity.
        const codex = { role: 'agent', content: { type: 'codex', data: { type: 'reasoning' } } }
        expect(isConversationRow({ content: codex as never })).toBe(true)
        expect(isConversationRow({ content: 'plain' as never })).toBe(true)
        expect(isConversationRow({ content: null as never })).toBe(true)
    })

    it('recognises pure tool calls and results, and skips bookkeeping rows', () => {
        expect(isConversationRow({ content: toolUse('t1') as never })).toBe(false)
        expect(isConversationRow({ content: toolResult('t1') as never })).toBe(false)
        const bookkeeping = { role: 'agent', content: { type: 'output', data: { type: 'system', subtype: 'compact_boundary' } } }
        expect(isConversationRow({ content: bookkeeping as never })).toBe(false)
        // A tool call next to text is a conversation row.
        const mixed = agentOutput('assistant', [
            { type: 'tool_use', id: 't', name: 'Bash', input: {} },
            { type: 'text', text: 'done' }
        ])
        expect(isConversationRow({ content: mixed as never })).toBe(true)
    })

    it('counts only conversation rows', () => {
        const rows = [
            { content: toolUse('a') as never },
            { content: userPrompt('q') as never },
            { content: toolResult('a') as never }
        ]
        expect(countConversationRows(rows)).toBe(1)
    })
})

describe('GET /api/sessions/:id/messages?minConversation', () => {
    function createApp(store: Store): Hono<WebAppEnv> {
        const service = new MessageService(
            store,
            { sockets: new Map(), except: () => {} } as never,
            { emit() {} } as unknown as EventPublisher
        )
        const engine = {
            resolveSessionAccess: (sessionId: string) => (
                { ok: true, sessionId, session: { id: sessionId, active: true } as never }
            ),
            getMessagesPage: (sessionId: string, options: Parameters<SyncEngine['getMessagesPage']>[1]) => (
                service.getMessagesPage(sessionId, options as never)
            )
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => engine))
        return app
    }

    function seed(store: Store, sessionId: string, content: unknown, at: number): void {
        store.messages.addMessage(sessionId, content, undefined, null, at)
    }

    function newSession(store: Store, tag: string): string {
        return store.sessions.getOrCreateSession(tag, { path: '/p', machineId: 'm', flavor: 'claude' }, null, 'default').id
    }

    it('answers a tool-only tail with the full page instead of the short one', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'open-fast')
        // The newest 20 rows are pure tool activity; the one before is the prompt.
        seed(store, sessionId, userPrompt('q'), 1000)
        for (let i = 1; i <= 21; i++) {
            seed(store, sessionId, i % 2 === 0 ? toolUse(`t${i}`) : toolResult(`t${i - 1}`), 1000 + i)
        }
        const app = createApp(store)

        const plain = await (await app.request(`/api/sessions/${sessionId}/messages?limit=20`)).json() as MessagesResponse
        expect(plain.messages).toHaveLength(20)
        expect(countConversationRows(plain.messages)).toBe(0)
        expect(plain.page.limit).toBe(20)

        const response = await app.request(`/api/sessions/${sessionId}/messages?limit=20&minConversation=1`)
        expect(response.status).toBe(200)
        const page = await response.json() as MessagesResponse
        expect(page.page.limit).toBe(200)
        expect(page.page.direction).toBe('latest')
        expect(page.messages).toHaveLength(22)
        expect(countConversationRows(page.messages)).toBe(1)
        expect(page.page.hasMore).toBe(false)
    })

    it('leaves a tail that already carries conversation at the requested size', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'open-plain')
        seed(store, sessionId, assistantText('a0'), 500)
        for (let i = 1; i <= 30; i++) {
            seed(store, sessionId, i % 5 === 0 ? assistantText(`a${i}`) : toolUse(`t${i}`), 1000 + i)
        }
        const app = createApp(store)

        const page = await (await app.request(`/api/sessions/${sessionId}/messages?limit=20&minConversation=1`)).json() as MessagesResponse
        expect(page.messages).toHaveLength(20)
        expect(page.page.limit).toBe(20)
        expect(countConversationRows(page.messages)).toBeGreaterThanOrEqual(1)
    })

    it('never extends a page that has nothing older, and rejects the flag on cursor pages', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'open-small')
        for (let i = 1; i <= 5; i++) {
            seed(store, sessionId, toolUse(`t${i}`), 1000 + i)
        }
        const app = createApp(store)

        const small = await (await app.request(`/api/sessions/${sessionId}/messages?limit=20&minConversation=1`)).json() as MessagesResponse
        expect(small.messages).toHaveLength(5)
        expect(small.page.limit).toBe(20)
        expect(small.page.hasMore).toBe(false)

        const before = await app.request(`/api/sessions/${sessionId}/messages?limit=2&beforeAt=1003&beforeSeq=3&minConversation=1`)
        expect(before.status).toBe(400)
        const after = await app.request(`/api/sessions/${sessionId}/messages?afterAt=1001&afterSeq=1&minConversation=1`)
        expect(after.status).toBe(400)
        const zero = await app.request(`/api/sessions/${sessionId}/messages?limit=20&minConversation=0`)
        expect(zero.status).toBe(400)
    })

    it('keeps serving context pages regardless of the flag', async () => {
        const store = new Store(':memory:')
        const sessionId = newSession(store, 'open-ctx')
        seed(store, sessionId, userPrompt('q'), 1000)
        const engine = {
            resolveSessionAccess: (sessionId: string) => (
                { ok: true, sessionId, session: { id: sessionId, active: true } as never }
            ),
            getMessageContext: (): MessageContextResponse | null => ({
                messages: [
                    { id: 'message-shot', seq: 1, localId: null, content: userPrompt('q'), createdAt: 1000 }
                ] as never,
                targetMessageId: 'message-shot',
                page: { epoch: 1, nextBeforeSeq: null, nextBeforeAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false }
            })
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => engine))

        const response = await app.request(`/api/sessions/${sessionId}/messages/message-shot/context`)
        expect(response.status).toBe(200)
    })
})

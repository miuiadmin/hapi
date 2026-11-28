import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SEND_ORDERING_GRACE_MS, useSendMessage, type SendMessageAcceptance } from './useSendMessage'
import { ApiError, type ApiClient } from '@/api/client'

/** What the tests let the hook see of its message window: the rows it holds, and who is watching them. */
const window = vi.hoisted(() => ({
    messages: [] as Array<{ localId: string; invokedAt: number | null; status?: string }>,
    listeners: new Set<() => void>(),
}))

vi.mock('@/lib/message-window-store', () => ({
    appendOptimisticMessage: vi.fn(),
    getMessageWindowState: vi.fn(() => ({ messages: window.messages })),
    updateMessageStatus: vi.fn(),
    removeOptimisticMessage: vi.fn(),
    subscribeMessageWindow: vi.fn((_sessionId: string, listener: () => void) => {
        window.listeners.add(listener)
        return () => {
            window.listeners.delete(listener)
        }
    }),
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: { notification: vi.fn() },
    }),
}))

vi.mock('@/lib/messages', () => ({
    makeClientSideId: vi.fn(() => 'local-id-1'),
}))

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createMockApi(sendMessage: (...args: unknown[]) => Promise<void> = async () => {}): ApiClient {
    return { sendMessage } as unknown as ApiClient
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((res) => {
        resolve = res
    })
    return { promise, resolve }
}

describe('useSendMessage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('calls onSuccess with the session ID that was sent', async () => {
        const onSuccess = vi.fn()
        const api = createMockApi()

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { onSuccess }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        await waitFor(() => {
            expect(onSuccess).toHaveBeenCalledWith('session-A')
        })
    })

    it('keeps a thinking-session send in flight until the POST confirms it is queued', async () => {
        const request = deferred<void>()
        const api = createMockApi(() => request.promise)
        const { appendOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
        const appendMock = vi.mocked(appendOptimisticMessage)
        const updateMock = vi.mocked(updateMessageStatus)

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { isSessionThinking: true }),
            { wrapper: createWrapper() },
        )

        act(() => {
            void result.current.sendMessage('queue this')
        })

        await waitFor(() => {
            expect(appendMock).toHaveBeenCalledWith(
                'session-A',
                expect.objectContaining({
                    localId: 'local-id-1',
                    status: 'sending',
                }),
            )
        })
        expect(updateMock).not.toHaveBeenCalledWith('session-A', 'local-id-1', 'queued')

        await act(async () => {
            request.resolve()
            await request.promise
        })

        await waitFor(() => {
            expect(updateMock).toHaveBeenCalledWith('session-A', 'local-id-1', 'queued')
        })
    })

    it('forwards delivery mode and retains it on the optimistic message', async () => {
        const sendMock = vi.fn(async () => {})
        const api = createMockApi(sendMock)
        const { appendOptimisticMessage } = await import('@/lib/message-window-store')

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A'),
            { wrapper: createWrapper() },
        )

        act(() => {
            void result.current.sendMessage('steer this', undefined, null, 'steer')
        })

        await waitFor(() => {
            expect(sendMock).toHaveBeenCalledWith(
                'session-A',
                'steer this',
                'local-id-1',
                undefined,
                null,
                'steer',
                // The request can still be stopped by the user; nothing else rides on it.
                { signal: expect.any(AbortSignal) },
            )
        })
        expect(appendOptimisticMessage).toHaveBeenCalledWith(
            'session-A',
            expect.objectContaining({
                content: expect.objectContaining({
                    meta: { deliveryMode: 'steer' },
                }),
            }),
        )
    })

    it('calls onSuccess with resolved session ID, not the original', async () => {
        const onSuccess = vi.fn()
        const api = createMockApi()

        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                onSuccess,
                resolveSessionId: async () => ({ sessionId: 'session-resolved', resumed: true }),
                onSessionResolved: vi.fn(),
            }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        await waitFor(() => {
            expect(onSuccess).toHaveBeenCalledWith('session-resolved')
        })
    })

    it('does not call onSuccess when send fails', async () => {
        const onSuccess = vi.fn()
        const api = createMockApi(async () => {
            throw new Error('network error')
        })

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { onSuccess }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        await waitFor(() => {
            expect(result.current.isSending).toBe(false)
        })

        expect(onSuccess).not.toHaveBeenCalled()
    })

    // assistant-ui clears the composer eagerly when send is invoked, so to
    // retain the typed text on failure we hand the original input back
    // through the `onError` callback.  The three branches below cover the
    // acceptance criteria: 5xx/network, 4xx, and 2xx.
    describe('composer text retention on send failure', () => {
        it('5xx/network: onError fires with the original text so the composer can restore it', async () => {
            const onError = vi.fn()
            const onSuccess = vi.fn()
            const api = createMockApi(async () => {
                // request<T>() throws plain Error for 5xx with this shape.
                throw new Error('HTTP 503 Service Unavailable: hub down')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError, onSuccess }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('keep this text on 503')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown; mutationStarted: boolean }
            expect(info.text).toBe('keep this text on 503')
            expect(info.mutationStarted).toBe(true)
            expect(info.error).toBeInstanceOf(Error)
            expect((info.error as Error).message).toContain('503')
            expect(onSuccess).not.toHaveBeenCalled()
        })

        it('keeps a failed send\'s delivery mode for error restoration', async () => {
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('HTTP 503 Service Unavailable: hub down')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                void result.current.sendMessage('restore the explicit queue', undefined, null, 'queue')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            expect(onError.mock.calls[0]?.[0]).toMatchObject({
                text: 'restore the explicit queue',
                deliveryMode: 'queue',
                mutationStarted: true,
            })
        })

        it('network: onError fires with the original text on a fetch-level rejection', async () => {
            const onError = vi.fn()
            // Simulates a TypeError surfaced by fetch() when the hub socket
            // dies mid-request (e.g. daily-rebuild restart blip).
            const api = createMockApi(async () => {
                throw new TypeError('Failed to fetch')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('keep this on a dropped fetch')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown; mutationStarted: boolean }
            expect(info.text).toBe('keep this on a dropped fetch')
            expect(info.mutationStarted).toBe(true)
            expect(info.error).toBeInstanceOf(TypeError)
        })

        it('4xx: onError fires with the original text so the inline affordance can render', async () => {
            const onError = vi.fn()
            const api = createMockApi(async () => {
                // request<T>() throws plain Error for 4xx (e.g. 400/403).
                throw new Error('HTTP 400 Bad Request: invalid payload')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('keep this text on 400')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown }
            expect(info.text).toBe('keep this text on 400')
            expect((info.error as Error).message).toContain('400')
        })

        it('2xx: onError is not called and onSuccess fires (composer clears as today)', async () => {
            const onError = vi.fn()
            const onSuccess = vi.fn()
            const api = createMockApi()

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError, onSuccess }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('clean send')
            })

            await waitFor(() => {
                expect(onSuccess).toHaveBeenCalledWith('session-A')
            })
            expect(onError).not.toHaveBeenCalled()
        })

        it('non-Error throws still surface text; the consumer falls back to its default message', async () => {
            const onError = vi.fn()
            const api = createMockApi(async () => {
                // Defensive case — some providers throw bare strings/objects.
                // We must not swallow these or the composer would silently
                // eat the user's text again.
                throw 'opaque failure'
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('keep this on opaque failure')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown; scheduledAt: number | null }
            expect(info.text).toBe('keep this on opaque failure')
            expect(info.error).toBe('opaque failure')
            expect(info.scheduledAt).toBeNull()
        })

        it('carries scheduledAt through onError so the composer can restore a failed scheduled send as scheduled', async () => {
            // Without this, SessionChat clears pendingSchedule on accept and the
            // subsequent failure's restore would silently downgrade a scheduled
            // send to immediate -- the operator hits send again and the message
            // dispatches now instead of at the chosen time.
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('HTTP 503 Service Unavailable')
            })
            const scheduledAt = Date.now() + 5 * 60 * 1000

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('see you in 5', undefined, scheduledAt)
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; scheduledAt: number | null }
            expect(info.text).toBe('see you in 5')
            expect(info.scheduledAt).toBe(scheduledAt)
        })

        it('immediate send: scheduledAt is null in onError', async () => {
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('boom')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('immediate')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { scheduledAt: number | null }
            expect(info.scheduledAt).toBeNull()
        })

        it('removes the optimistic row on failure so the composer-restore path is the single retry surface', async () => {
            // Without this, the thread keeps a stale `failed` bubble next to
            // the restored composer text, and the operator can stack a
            // duplicate by retrying from either surface.
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('HTTP 503')
            })

            const { removeOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
            const removeMock = vi.mocked(removeOptimisticMessage)
            const updateMock = vi.mocked(updateMessageStatus)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hello')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            // The optimistic row is removed instead of being kept as failed.
            expect(removeMock).toHaveBeenCalledWith('session-A', 'local-id-1')
            // Defensive: nothing else should have transitioned the row to
            // 'failed' on this path -- we removed it outright.
            expect(updateMock.mock.calls.some((call) => call[2] === 'failed')).toBe(false)
        })

        it('carries sessionId through onError so a resumed-session POST that fails restores into the right composer', async () => {
            // Inactive-session resume: useSendMessage resolves a target id,
            // kicks off async navigation, and then the POST can fail.  The
            // route component keys sendError state by sessionId so the
            // restore lands on the resumed session, not the old one whose
            // composer the operator has already navigated away from.
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('HTTP 500')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-original', {
                    onError,
                    resolveSessionId: async () => ({ sessionId: 'session-resolved', resumed: true }),
                    onSessionResolved: vi.fn(),
                }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hi from resumed')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { sessionId: string; text: string }
            expect(info.sessionId).toBe('session-resolved')
            expect(info.text).toBe('hi from resumed')
        })

        it('attachment send: keeps the failed row in the thread and skips composer-restore', async () => {
            // The composer-restore path can't reinstate uploaded attachment
            // metadata, so for sends with attachments we fall back to the
            // legacy failed-bubble UX (operator retries via the in-thread
            // retry button, which re-fires the send WITH attachments).
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('HTTP 503')
            })

            const { removeOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
            const removeMock = vi.mocked(removeOptimisticMessage)
            const updateMock = vi.mocked(updateMessageStatus)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('see this image', [
                    { id: 'att-1', filename: 'x.png', mimeType: 'image/png', size: 1, path: '/x.png' }
                ])
            })

            await waitFor(() => {
                expect(updateMock).toHaveBeenCalledWith('session-A', 'local-id-1', 'failed')
            })
            // No composer-restore: onError is NOT fired and the optimistic
            // row is NOT removed -- both would destroy the attachment UX.
            expect(onError).not.toHaveBeenCalled()
            expect(removeMock).not.toHaveBeenCalled()
        })

        it('retryMessage: passes attachments through so failed-bubble retry of an attachment send keeps its files', async () => {
            // Without this, the failed-bubble retry path silently drops the
            // attachments and re-fires as a text-only send.
            const sendMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
            const api = { sendMessage: sendMock } as unknown as ApiClient

            const { getMessageWindowState } = await import('@/lib/message-window-store')
            const stateMock = vi.mocked(getMessageWindowState)
            const failedAttachmentMessage = {
                id: 'local-att-1',
                seq: null,
                localId: 'local-att-1',
                content: {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: 'photo + text',
                        attachments: [
                            { id: 'att-1', filename: 'x.png', mimeType: 'image/png', size: 1, path: '/x.png' }
                        ]
                    }
                },
                createdAt: 1000,
                invokedAt: null,
                scheduledAt: null,
                status: 'failed' as const,
                originalText: 'photo + text',
            }
            stateMock.mockReturnValue({
                messages: [failedAttachmentMessage]
            } as unknown as ReturnType<typeof getMessageWindowState>)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A'),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.retryMessage('local-att-1')
            })

            await waitFor(() => {
                expect(sendMock).toHaveBeenCalled()
            })
            const args = sendMock.mock.calls[0]
            expect(args[0]).toBe('session-A')
            expect(args[1]).toBe('photo + text')
            expect(args[2]).toBe('local-att-1')
            expect(args[3]).toEqual([
                { id: 'att-1', filename: 'x.png', mimeType: 'image/png', size: 1, path: '/x.png' }
            ])
        })

        it('retryMessage: puts back an image preview the message page left out before re-sending', async () => {
            // Message pages drop large inline previews (hasPreview marker); the
            // CLI rebuilds the file from previewUrl, so a retried send has to
            // carry it again or the screenshot would silently disappear.
            const sendMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
            const previewMock = vi.fn(async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }))
            const api = { sendMessage: sendMock, fetchMessageAttachmentPreviewBlob: previewMock } as unknown as ApiClient

            const { getMessageWindowState } = await import('@/lib/message-window-store')
            const stateMock = vi.mocked(getMessageWindowState)
            const failedShotMessage = {
                id: 'message-shot',
                seq: 41,
                localId: 'local-shot',
                content: {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: 'see the black blocks',
                        attachments: [
                            { id: 'att-shot', filename: '15071.jpg', mimeType: 'image/jpeg', size: 551943, path: '/tmp/15071.jpg', hasPreview: true }
                        ]
                    }
                },
                createdAt: 1000,
                invokedAt: null,
                scheduledAt: null,
                status: 'failed' as const,
                originalText: 'see the black blocks',
            }
            stateMock.mockReturnValue({
                messages: [failedShotMessage]
            } as unknown as ReturnType<typeof getMessageWindowState>)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A'),
                { wrapper: createWrapper() },
            )

            let accepted = false
            act(() => {
                accepted = result.current.retryMessage('local-shot')
            })
            expect(accepted).toBe(true)
            // The send waits for the preview; a second tap meanwhile is ignored.
            expect(sendMock).not.toHaveBeenCalled()
            expect(result.current.retryMessage('local-shot')).toBe(false)

            await waitFor(() => {
                expect(sendMock).toHaveBeenCalledTimes(1)
            })
            expect(previewMock).toHaveBeenCalledWith('session-A', 'message-shot', 'att-shot')
            const attachments = sendMock.mock.calls[0][3] as Array<{ id: string; previewUrl?: string; hasPreview?: boolean }>
            expect(attachments).toHaveLength(1)
            expect(attachments[0]).toMatchObject({ id: 'att-shot', filename: '15071.jpg', size: 551943 })
            expect(attachments[0]?.previewUrl).toMatch(/^data:image\/jpeg;base64,/)
        })
    })

    it('does not call onSuccess when blocked', () => {
        const onSuccess = vi.fn()
        const onBlocked = vi.fn()

        const { result } = renderHook(
            () => useSendMessage(null, 'session-A', { onSuccess, onBlocked }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        expect(onBlocked).toHaveBeenCalledWith('no-api')
        expect(onSuccess).not.toHaveBeenCalled()
    })

    it('returns the attempt id when the send is accepted', async () => {
        const api = createMockApi()
        const { result } = renderHook(
            () => useSendMessage(api, 'session-A'),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<SendMessageAcceptance | false> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toEqual({ attemptId: 'local-id-1' })
    })

    it('resolves false when blocked (no api) so the caller can preserve schedule state', async () => {
        const onBlocked = vi.fn()
        const { result } = renderHook(
            () => useSendMessage(null, 'session-A', { onBlocked }),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<SendMessageAcceptance | false> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(false)
        expect(onBlocked).toHaveBeenCalledWith('no-api')
    })

    it('resolves false when blocked (no session)', async () => {
        const api = createMockApi()
        const { result } = renderHook(
            () => useSendMessage(api, null),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<SendMessageAcceptance | false> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(false)
    })

    it('resolves false when resolveSessionId throws (inactive-session resume failure)', async () => {
        const api = createMockApi()
        const resumeError = new Error('resume failed')
        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', {
                resolveSessionId: async () => { throw resumeError },
                onSessionResolved: vi.fn(),
            }),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<SendMessageAcceptance | false> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(false)
    })

    it('returns the attempt id after async resolveSessionId succeeds and mutation starts', async () => {
        const api = createMockApi()
        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                resolveSessionId: async () => ({ sessionId: 'session-resolved', resumed: true }),
                onSessionResolved: vi.fn(),
            }),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<SendMessageAcceptance | false> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toEqual({ attemptId: 'local-id-1' })
    })

    it('awaits onSessionResolved before starting the send mutation', async () => {
        const order: string[] = []
        const gate = deferred<void>()
        const sendMessage = vi.fn(async () => {
            order.push('mutate')
        })
        const api = createMockApi(sendMessage)
        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                resolveSessionId: async () => ({ sessionId: 'session-resolved', resumed: true }),
                onSessionResolved: async (_id, context) => {
                    expect(context).toEqual({ text: 'hello with draft', attachments: undefined })
                    order.push('resolved')
                    await gate.promise
                    order.push('resolved-done')
                },
            }),
            { wrapper: createWrapper() },
        )

        act(() => {
            void result.current.sendMessage('hello with draft')
        })

        await waitFor(() => {
            expect(order).toEqual(['resolved'])
        })
        expect(sendMessage).not.toHaveBeenCalled()

        await act(async () => {
            gate.resolve()
        })

        await waitFor(() => {
            expect(order).toEqual(['resolved', 'resolved-done', 'mutate'])
        })
        expect(sendMessage).toHaveBeenCalled()
    })

    it('does not mutate when onSessionResolved defers for draft hydration', async () => {
        const sendMessage = vi.fn(async () => {})
        const api = createMockApi(sendMessage)
        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                resolveSessionId: async () => ({ sessionId: 'session-resolved', resumed: true }),
                onSessionResolved: async () => ({ deferUntilDraftHydrated: true }),
            }),
            { wrapper: createWrapper() },
        )

        let accepted: Awaited<ReturnType<typeof result.current.sendMessage>> | undefined
        await act(async () => {
            accepted = await result.current.sendMessage('hello with hidden file')
        })

        expect(accepted).toBe(false)
        expect(sendMessage).not.toHaveBeenCalled()
    })

    it('defers after a same-id resume when onSessionResolved asks to wait', async () => {
        const sendMessage = vi.fn(async () => {})
        const api = createMockApi(sendMessage)
        const onSessionResolved = vi.fn(async () => ({ deferUntilDraftHydrated: true as const }))
        const { result } = renderHook(
            () => useSendMessage(api, 'session-same', {
                resolveSessionId: async () => ({ sessionId: 'session-same', resumed: true }),
                onSessionResolved,
            }),
            { wrapper: createWrapper() },
        )

        let accepted: Awaited<ReturnType<typeof result.current.sendMessage>> | undefined
        await act(async () => {
            accepted = await result.current.sendMessage('same-id with hidden file')
        })

        expect(onSessionResolved).toHaveBeenCalledWith('session-same', {
            text: 'same-id with hidden file',
            attachments: undefined,
        })
        expect(accepted).toBe(false)
        expect(sendMessage).not.toHaveBeenCalled()
    })

    it('does not call onSessionResolved when the session was already active', async () => {
        const sendMessage = vi.fn(async () => {})
        const api = createMockApi(sendMessage)
        const onSessionResolved = vi.fn()
        const { result } = renderHook(
            () => useSendMessage(api, 'session-active', {
                resolveSessionId: async () => ({ sessionId: 'session-active', resumed: false }),
                onSessionResolved,
            }),
            { wrapper: createWrapper() },
        )

        await act(async () => {
            await result.current.sendMessage('already active')
        })

        expect(onSessionResolved).not.toHaveBeenCalled()
        expect(sendMessage).toHaveBeenCalled()
    })

    // #918: the inactive-session 409 path
    describe('inactive-session 409 (issue #918)', () => {
        it('fires onError with the ApiError so the consumer can render a session_inactive affordance', async () => {
            // Hub returns 409 with code: 'session_inactive' (guards.ts).
            // The api client throws ApiError(status=409, code='session_inactive').
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new ApiError(
                    'HTTP 409 Conflict: {"error":"Session is inactive","code":"session_inactive"}',
                    409,
                    'session_inactive',
                    '{"error":"Session is inactive","code":"session_inactive"}'
                )
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hello inactive')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown; sessionId: string; mutationStarted: boolean }
            expect(info.text).toBe('hello inactive')
            expect(info.mutationStarted).toBe(true)
            expect(info.sessionId).toBe('session-A')
            expect(info.error).toBeInstanceOf(ApiError)
            const apiErr = info.error as ApiError
            expect(apiErr.status).toBe(409)
            expect(apiErr.code).toBe('session_inactive')
        })

        it('fires onError when resolveSessionId rejects (pre-mutation inactive-session failure)', async () => {
            // Pre-mutation: the route's resolveSessionId throws when
            // inactiveSessionCanResume returns false OR api.resumeSession
            // fails.  Prior to #918 this dropped the typed text into the
            // void with only a console.error; the operator saw nothing.
            // The hook must surface this through onError too.
            const onError = vi.fn()
            const api = createMockApi()
            const resumeError = new ApiError('Session is inactive', 409, 'session_inactive')

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', {
                    onError,
                    resolveSessionId: async () => { throw resumeError },
                    onSessionResolved: vi.fn(),
                }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hello pre-mutation')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown; sessionId: string; mutationStarted: boolean }
            expect(info.text).toBe('hello pre-mutation')
            expect(info.mutationStarted).toBe(false)
            // Keyed by the ORIGINAL sessionId: pre-mutation never navigated.
            expect(info.sessionId).toBe('session-A')
            expect(info.error).toBe(resumeError)
        })

        it('5xx still uses the legacy text-restore path (#918 must not regress transient-failure UX)', async () => {
            // Acceptance criterion: a real transient 500/network failure
            // must keep the original behavior (remove optimistic row,
            // onError fires with the plain message), not adopt the
            // session_inactive affordance.
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new ApiError(
                    'HTTP 500 Internal Server Error',
                    500,
                    undefined,
                    undefined
                )
            })

            const { removeOptimisticMessage } = await import('@/lib/message-window-store')
            const removeMock = vi.mocked(removeOptimisticMessage)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hello transient')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            expect(removeMock).toHaveBeenCalledWith('session-A', 'local-id-1')
            const info = onError.mock.calls[0][0] as { error: unknown }
            // No session_inactive code -> consumer renders fallback
            // message, no Reopen action attached.
            expect((info.error as ApiError).code).toBeUndefined()
            expect((info.error as ApiError).status).toBe(500)
        })
    })

    it('preserves scheduledAt when retrying a failed scheduled message', async () => {
        const sendMock = vi.fn(async () => {})
        const api = createMockApi(sendMock)
        const scheduledAt = Date.now() + 5 * 60_000

        const { getMessageWindowState } = await import('@/lib/message-window-store')
        vi.mocked(getMessageWindowState).mockReturnValueOnce({
            messages: [{
                id: 'local-retry-1',
                seq: null,
                localId: 'local-retry-1',
                content: { role: 'user', content: { type: 'text', text: 'hi later' } },
                createdAt: 1_000,
                invokedAt: null,
                scheduledAt,
                status: 'failed',
                originalText: 'hi later',
            } as never],
        } as never)

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A'),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.retryMessage('local-retry-1')
        })

        await waitFor(() => {
            expect(sendMock).toHaveBeenCalled()
        })

        // api.sendMessage(sessionId, text, localId, attachments, scheduledAt, deliveryMode, { signal })
        expect(sendMock).toHaveBeenCalledWith(
            'session-A',
            'hi later',
            'local-retry-1',
            undefined,
            scheduledAt,
            'queue',
            { signal: expect.any(AbortSignal) },
        )
    })

    it('downgrades a failed steer to queue when retrying the message', async () => {
        const sendMock = vi.fn(async () => {})
        const api = createMockApi(sendMock)
        const { getMessageWindowState } = await import('@/lib/message-window-store')
        vi.mocked(getMessageWindowState).mockReturnValueOnce({
            messages: [{
                id: 'local-steer-1',
                seq: null,
                localId: 'local-steer-1',
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'keep steering' },
                    meta: { deliveryMode: 'steer' },
                },
                createdAt: 1_000,
                invokedAt: null,
                scheduledAt: null,
                status: 'failed',
                originalText: 'keep steering',
            } as never],
        } as never)

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A'),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.retryMessage('local-steer-1')
        })

        await waitFor(() => {
            expect(sendMock).toHaveBeenCalledWith(
                'session-A',
                'keep steering',
                'local-steer-1',
                undefined,
                null,
                'queue',
                { signal: expect.any(AbortSignal) },
            )
        })
    })
})

describe('a live session', () => {
    beforeEach(async () => {
        vi.clearAllMocks()
        window.messages = []
        window.listeners.clear()
        // A send one test cancelled in flight must not read as cancelled in the next.
        const { resetAbortedSends } = await import('@/lib/abortedSends')
        resetAbortedSends()
        // A test above may have pinned what the window holds for the rest of the file; here the
        // window is the one this test filled.
        const { getMessageWindowState } = await import('@/lib/message-window-store')
        vi.mocked(getMessageWindowState).mockImplementation(() => ({ messages: window.messages }) as never)
    })

    /** Says to whoever is watching the window that a row changed. */
    const windowChanged = () => {
        for (const listener of [...window.listeners]) listener()
    }
    /** The agent takes a row: that is the window's own news, not this device's. */
    const takenByAgent = (localId: string) => {
        const row = window.messages.find((message) => message.localId === localId)
        if (row) row.invokedAt = 9_000
        windowChanged()
    }
    /** The hub drops a row (a cancel), and the window says so. */
    const droppedByHub = (localId: string) => {
        window.messages = window.messages.filter((message) => message.localId !== localId)
        windowChanged()
    }

    type Post = { signal: AbortSignal; abortedWhenAsked: boolean; resolve: () => void; reject: (error: unknown) => void }

    /** An api whose POSTs wait to be settled one by one, in the order they arrive. */
    function holdingApi() {
        const posts: Post[] = []
        const sendMessage = vi.fn((_sessionId: string, _text: string, _localId: string, _a: unknown, _s: unknown, _d: unknown, options?: { signal?: AbortSignal }) =>
            new Promise<void>((resolve, reject) => {
                posts.push({ signal: options!.signal!, abortedWhenAsked: options!.signal!.aborted, resolve, reject })
            }))
        return { posts, api: { sendMessage } as unknown as ApiClient, sendMessage }
    }

    /** Two sends of one live session, each waiting for its POST. */
    async function sendTwo(api: ApiClient) {
        const { makeClientSideId } = await import('@/lib/messages')
        // From a clean slate: an id another test queued and never used would be handed out first.
        vi.mocked(makeClientSideId).mockReset().mockReturnValueOnce('local-a').mockReturnValueOnce('local-b')
        const { result, unmount } = renderHook(
            () => useSendMessage(api, 'session-A', { isActive: true }),
            { wrapper: createWrapper() },
        )
        let first!: SendMessageAcceptance | false
        let second!: SendMessageAcceptance | false
        await act(async () => {
            first = await result.current.sendMessage('first')
            second = await result.current.sendMessage('second')
        })
        return { result, unmount, first, second }
    }

    it('posts one at a time, in the order typed, while every row goes up at once', async () => {
        const { posts, api } = holdingApi()
        const { appendOptimisticMessage } = await import('@/lib/message-window-store')
        const appendMock = vi.mocked(appendOptimisticMessage)
        const { first, second } = await sendTwo(api)

        expect(first).toEqual({ attemptId: 'local-a' })
        // The second message is not refused for arriving while the first is still posting.
        expect(second).toEqual({ attemptId: 'local-b' })
        expect(appendMock.mock.calls.map((call) => (call[1] as { localId: string }).localId)).toEqual(['local-a', 'local-b'])
        expect(appendMock).toHaveBeenLastCalledWith('session-A', expect.objectContaining({ localId: 'local-b', status: 'sending' }))
        expect(posts).toHaveLength(1)

        await act(async () => { posts[0]!.resolve() })
        // The first reached the hub, and nothing waits on it (the window here holds no such row).
        await waitFor(() => expect(posts).toHaveLength(2))
        const { updateMessageStatus } = await import('@/lib/message-window-store')
        expect(vi.mocked(updateMessageStatus)).toHaveBeenCalledWith('session-A', 'local-a', 'sent')

        await act(async () => { posts[1]!.resolve() })
        await waitFor(() => expect(vi.mocked(updateMessageStatus)).toHaveBeenCalledWith('session-A', 'local-b', 'sent'))
    })

    it('keeps the message typed behind another on this device until the agent has taken the first', async () => {
        const { posts, api, sendMessage } = holdingApi()
        const { result } = await sendTwo(api)
        window.messages.push({ localId: 'local-a', invokedAt: null, status: 'sent' })
        expect(posts).toHaveLength(1)

        await act(async () => { posts[0]!.resolve() })
        await act(async () => { await Promise.resolve() })
        // The first is the hub's now and still not the agent's: the second has not left, and nothing is on the wire.
        expect(posts).toHaveLength(1)
        expect(result.current.isSending).toBe(false)
        expect(window.listeners.size).toBeGreaterThan(0)

        act(() => { takenByAgent('local-a') })
        await waitFor(() => expect(posts).toHaveLength(2))
        expect(sendMessage).toHaveBeenLastCalledWith('session-A', 'second', 'local-b', undefined, undefined, 'queue', { signal: expect.any(AbortSignal) })
        // Nothing is waited on any more.
        expect(window.listeners.size).toBe(0)
        await act(async () => { posts[1]!.resolve() })
    })

    it('does not make the message behind wait for ever: two seconds at most, then the hub holds it', async () => {
        const { posts, api } = holdingApi()
        await sendTwo(api)
        window.messages.push({ localId: 'local-a', invokedAt: null, status: 'queued' })
        await act(async () => { posts[0]!.resolve() })

        // The agent is busy and does not take the first in that time.
        await waitFor(() => expect(posts).toHaveLength(2), { timeout: SEND_ORDERING_GRACE_MS + 3_000 })
        expect(window.listeners.size).toBe(0)
        await act(async () => { posts[1]!.resolve() })
    })

    it('lets the message behind go as soon as the hub drops the first, as a cancel makes it', async () => {
        const { posts, api } = holdingApi()
        await sendTwo(api)
        window.messages.push({ localId: 'local-a', invokedAt: null, status: 'queued' })
        await act(async () => { posts[0]!.resolve() })
        expect(posts).toHaveLength(1)

        act(() => { droppedByHub('local-a') })
        await waitFor(() => expect(posts).toHaveLength(2))
        await act(async () => { posts[1]!.resolve() })
    })

    it('lets the message behind go at once when the first did not reach the agent', async () => {
        const { posts, api, sendMessage } = holdingApi()
        await sendTwo(api)
        window.messages.push({ localId: 'local-a', invokedAt: null, status: 'sending' })

        await act(async () => { posts[0]!.reject(new Error('HTTP 502 Bad Gateway')) })
        await waitFor(() => expect(posts).toHaveLength(2))
        expect(sendMessage).toHaveBeenCalledTimes(2)
        await act(async () => { posts[1]!.resolve() })
    })

    it('posts a message scheduled for later as soon as the wire is free: it is not waiting its turn behind anything', async () => {
        const { posts, api, sendMessage } = holdingApi()
        const { makeClientSideId } = await import('@/lib/messages')
        vi.mocked(makeClientSideId).mockReset().mockReturnValueOnce('local-a').mockReturnValueOnce('local-s')
        const { result, unmount } = renderHook(() => useSendMessage(api, 'session-A', { isActive: true }), { wrapper: createWrapper() })
        const later = Date.now() + 60 * 60_000
        await act(async () => {
            await result.current.sendMessage('now')
            await result.current.sendMessage('in an hour', undefined, later)
        })
        expect(posts).toHaveLength(1)
        window.messages.push({ localId: 'local-a', invokedAt: null, status: 'sent' })

        await act(async () => { posts[0]!.resolve() })
        // The first is still not the agent's, and that is none of the scheduled message's business.
        await waitFor(() => expect(posts).toHaveLength(2))
        expect(sendMessage).toHaveBeenLastCalledWith('session-A', 'in an hour', 'local-s', undefined, later, 'queue', { signal: expect.any(AbortSignal) })
        await act(async () => { posts[1]!.resolve() })
        // The only wait left is the first message's own; nothing waits on the scheduled one.
        expect(window.listeners.size).toBe(1)
        unmount()
        expect(window.listeners.size).toBe(0)
    })

    it('drops a message typed behind another while it is still waiting here, and posts nothing of it later', async () => {
        const { posts, api, sendMessage } = holdingApi()
        const { result } = await sendTwo(api)
        window.messages.push({ localId: 'local-a', invokedAt: null, status: 'queued' })
        await act(async () => { posts[0]!.resolve() })
        expect(posts).toHaveLength(1)

        let stopped: 'dropped' | 'aborted' | false = false
        act(() => { stopped = result.current.cancelSending('local-b') })
        expect(stopped).toBe('dropped')
        act(() => { takenByAgent('local-a') })
        await act(async () => { await Promise.resolve() })
        expect(sendMessage).toHaveBeenCalledTimes(1)
    })

    it('posts what was typed behind another when the page is left, even with the agent never taking the first', async () => {
        const { posts, api, sendMessage } = holdingApi()
        const { unmount } = await sendTwo(api)
        window.messages.push({ localId: 'local-a', invokedAt: null, status: 'queued' })
        await act(async () => { posts[0]!.resolve() })
        expect(posts).toHaveLength(1)

        unmount()
        expect(window.listeners.size).toBe(0)
        await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
        await act(async () => { posts[1]?.resolve() })
    })

    it('does not lock the composer while a POST is in flight', async () => {
        const { posts, api } = holdingApi()
        const { result } = await sendTwo(api)
        await waitFor(() => expect(result.current.isSending).toBe(true))
        expect(result.current.isComposerLocked).toBe(false)

        await act(async () => { posts[0]!.resolve() })
        await waitFor(() => expect(posts).toHaveLength(2))
        await act(async () => { posts[1]!.resolve() })
        await waitFor(() => expect(result.current.isSending).toBe(false))
    })

    it('still locks the composer for a session that is not live', async () => {
        const request = deferred<void>()
        const { result } = renderHook(
            () => useSendMessage(createMockApi(() => request.promise), 'session-A'),
            { wrapper: createWrapper() },
        )
        await act(async () => { void result.current.sendMessage('after a resume') })
        await waitFor(() => expect(result.current.isComposerLocked).toBe(true))
        await act(async () => { request.resolve() })
        await waitFor(() => expect(result.current.isComposerLocked).toBe(false))
    })

    it('stops a send that is on the wire: the row goes, the request is aborted, nothing is restored or failed', async () => {
        const { posts, api } = holdingApi()
        const onError = vi.fn()
        const { makeClientSideId } = await import('@/lib/messages')
        vi.mocked(makeClientSideId).mockReturnValueOnce('local-a')
        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { isActive: true, onError }),
            { wrapper: createWrapper() },
        )
        await act(async () => { await result.current.sendMessage('never mind') })

        let stopped: 'dropped' | 'aborted' | false = false
        act(() => { stopped = result.current.cancelSending('local-a') })
        expect(stopped).toBe('aborted')
        const { removeOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
        expect(removeOptimisticMessage).toHaveBeenCalledWith('session-A', 'local-a')
        expect(posts[0]!.signal.aborted).toBe(true)

        // The aborted request settles with an error, which is not the send failing.
        await act(async () => { posts[0]!.reject(new DOMException('The operation was aborted.', 'AbortError')) })
        expect(onError).not.toHaveBeenCalled()
        expect(vi.mocked(updateMessageStatus)).not.toHaveBeenCalledWith('session-A', 'local-a', 'failed')
        expect(result.current.isSending).toBe(false)
    })

    it('stopped in the ticks before its request starts, the request never leaves', async () => {
        const { posts, api } = holdingApi()
        const { makeClientSideId } = await import('@/lib/messages')
        vi.mocked(makeClientSideId).mockReturnValueOnce('local-a')
        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { isActive: true }),
            { wrapper: createWrapper() },
        )
        // No act between the two: the send was handed over and its cancel comes before anything else ran.
        await result.current.sendMessage('changed my mind')
        let stopped: 'dropped' | 'aborted' | false = false
        stopped = result.current.cancelSending('local-a')
        expect(stopped).toBe('aborted')

        // The request starts a few ticks later, and dead on arrival.
        await waitFor(() => expect(posts).toHaveLength(1))
        expect(posts[0]!.abortedWhenAsked).toBe(true)
        await act(async () => { posts[0]!.reject(new DOMException('The operation was aborted.', 'AbortError')) })
        await waitFor(() => expect(result.current.isSending).toBe(false))
    })

    it('drops a send that is still waiting behind another: it is never posted', async () => {
        const { posts, api, sendMessage } = holdingApi()
        const { result } = await sendTwo(api)
        const { removeOptimisticMessage } = await import('@/lib/message-window-store')
        expect(sendMessage).toHaveBeenCalledTimes(1)

        let stopped: 'dropped' | 'aborted' | false = false
        act(() => { stopped = result.current.cancelSending('local-b') })
        expect(stopped).toBe('dropped')
        expect(removeOptimisticMessage).toHaveBeenCalledWith('session-A', 'local-b')

        await act(async () => { posts[0]!.resolve() })
        await act(async () => { await Promise.resolve() })
        // The first send settled and let the queue drain; the dropped one was not in it.
        expect(sendMessage).toHaveBeenCalledTimes(1)
    })

    it('says no when there is no send of that id to stop', async () => {
        const { api } = holdingApi()
        const { result } = renderHook(() => useSendMessage(api, 'session-A', { isActive: true }), { wrapper: createWrapper() })
        expect(result.current.cancelSending('local-nobody')).toBe(false)
    })

    it('keeps a failed send in the thread as a failed row instead of handing its text back', async () => {
        const sendMessage = vi.fn(() => Promise.reject(new Error('HTTP 502 Bad Gateway')))
        const onError = vi.fn()
        const { makeClientSideId } = await import('@/lib/messages')
        vi.mocked(makeClientSideId).mockReturnValueOnce('local-a')
        const { result } = renderHook(
            () => useSendMessage({ sendMessage } as unknown as ApiClient, 'session-A', { isActive: true, onError }),
            { wrapper: createWrapper() },
        )
        await act(async () => { await result.current.sendMessage('this one fails') })

        const { removeOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
        await waitFor(() => expect(vi.mocked(updateMessageStatus)).toHaveBeenCalledWith('session-A', 'local-a', 'failed'))
        expect(removeOptimisticMessage).not.toHaveBeenCalled()
        expect(onError).not.toHaveBeenCalled()
        const { getSendFailure } = await import('@/lib/sendFailures')
        expect(getSendFailure('session-A', 'local-a')).toBe('HTTP 502 Bad Gateway')
    })

    it('hands the text back when the hub says the session is no longer live', async () => {
        const sendMessage = vi.fn(() => Promise.reject(new ApiError('archived', 409, 'session_inactive')))
        const onError = vi.fn()
        const { makeClientSideId } = await import('@/lib/messages')
        vi.mocked(makeClientSideId).mockReturnValueOnce('local-a')
        const { result } = renderHook(
            () => useSendMessage({ sendMessage } as unknown as ApiClient, 'session-A', { isActive: true, onError }),
            { wrapper: createWrapper() },
        )
        await act(async () => { await result.current.sendMessage('too late') })

        const { removeOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
        await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
        expect(removeOptimisticMessage).toHaveBeenCalledWith('session-A', 'local-a')
        expect(vi.mocked(updateMessageStatus)).not.toHaveBeenCalledWith('session-A', 'local-a', 'failed')
    })

    it('leaves how a session that is not live reports a failure as it was', async () => {
        const sendMessage = vi.fn(() => Promise.reject(new Error('offline')))
        const onError = vi.fn()
        const { makeClientSideId } = await import('@/lib/messages')
        vi.mocked(makeClientSideId).mockReturnValueOnce('local-a')
        const { result } = renderHook(
            () => useSendMessage({ sendMessage } as unknown as ApiClient, 'session-A', { onError }),
            { wrapper: createWrapper() },
        )
        await act(async () => { await result.current.sendMessage('draft comes back') })

        const { removeOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
        await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
        expect(removeOptimisticMessage).toHaveBeenCalledWith('session-A', 'local-a')
        expect(vi.mocked(updateMessageStatus)).not.toHaveBeenCalledWith('session-A', 'local-a', 'failed')
    })

    it('posts what was typed behind a slow send when the page is left', async () => {
        const { posts, api, sendMessage } = holdingApi()
        const { unmount } = await sendTwo(api)
        expect(sendMessage).toHaveBeenCalledTimes(1)
        unmount()
        await act(async () => { posts[0]!.resolve() })
        await act(async () => { posts[1]?.resolve() })
        await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
    })

    it('takes a retry of a failed row while another send is still posting', async () => {
        const { posts, api, sendMessage } = holdingApi()
        const { makeClientSideId } = await import('@/lib/messages')
        const { getMessageWindowState, updateMessageStatus } = await import('@/lib/message-window-store')
        vi.mocked(getMessageWindowState).mockReturnValue({
            messages: [{
                id: 'local-failed', seq: null, localId: 'local-failed',
                content: { role: 'user', content: { type: 'text', text: 'try me again' } },
                createdAt: 1_000, invokedAt: null, scheduledAt: null, status: 'failed', originalText: 'try me again',
            } as never],
        } as never)
        vi.mocked(makeClientSideId).mockReturnValueOnce('local-a')
        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { isActive: true }),
            { wrapper: createWrapper() },
        )
        await act(async () => { await result.current.sendMessage('still going') })
        let retried = false
        act(() => { retried = result.current.retryMessage('local-failed') })
        expect(retried).toBe(true)
        expect(vi.mocked(updateMessageStatus)).toHaveBeenCalledWith('session-A', 'local-failed', 'sending')
        expect(sendMessage).toHaveBeenCalledTimes(1)

        await act(async () => { posts[0]!.resolve() })
        await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
        expect(sendMessage).toHaveBeenLastCalledWith('session-A', 'try me again', 'local-failed', undefined, null, 'queue', { signal: expect.any(AbortSignal) })
        await act(async () => { posts[1]!.resolve() })
    })
})

describe('send watchdog', () => {
    it('flips an unsettled send to failed after 10s and a late success overwrites it', async () => {
        vi.useFakeTimers()
        try {
            const request = deferred<void>()
            const api = createMockApi(() => request.promise)
            const { appendOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
            const updateMock = vi.mocked(updateMessageStatus)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A'),
                { wrapper: createWrapper() },
            )

            await act(async () => {
                void result.current.sendMessage('wedged send')
            })

            await act(async () => { await vi.advanceTimersByTimeAsync(9_999) })
            expect(updateMock).not.toHaveBeenCalledWith('session-A', 'local-id-1', 'failed')

            await act(async () => { await vi.advanceTimersByTimeAsync(2) })
            expect(updateMessageStatus).toHaveBeenCalledWith('session-A', 'local-id-1', 'failed')

            // The mutation is still running; a late settlement overwrites.
            await act(async () => {
                request.resolve()
                await request.promise
                await vi.advanceTimersByTimeAsync(0)
            })
            expect(updateMessageStatus).toHaveBeenLastCalledWith('session-A', 'local-id-1', 'sent')
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('why a failed send failed', () => {
    it('is the hub\'s own words, without the status line and the envelope', async () => {
        const sendMessage = vi.fn(() => Promise.reject(new ApiError('HTTP 502 Bad Gateway: {"error":"Bad gateway"}', 502, undefined, '{"error":"Bad gateway"}')))
        const { makeClientSideId } = await import('@/lib/messages')
        vi.mocked(makeClientSideId).mockReturnValueOnce('local-a')
        const { getSendFailure, resetSendFailures } = await import('@/lib/sendFailures')
        resetSendFailures()
        const { result } = renderHook(
            () => useSendMessage({ sendMessage } as unknown as ApiClient, 'session-A', { isActive: true }),
            { wrapper: createWrapper() },
        )
        await act(async () => { await result.current.sendMessage('through the gateway') })
        await waitFor(() => expect(getSendFailure('session-A', 'local-a')).toBe('Bad gateway'))
    })
})

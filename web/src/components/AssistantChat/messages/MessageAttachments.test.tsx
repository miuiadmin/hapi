import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'

const fetchPreview = vi.hoisted(() => vi.fn<ApiClient['fetchMessageAttachmentPreviewBlob']>())
// One stable client object, as the chat context provides in the app: a fresh
// object per render would re-run the loader effect on every state change.
const api = vi.hoisted(() => ({ fetchMessageAttachmentPreviewBlob: fetchPreview }) as unknown as ApiClient)
vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ({ api, sessionId: 'session-1' }),
    useOptionalHappyChatContext: () => null
}))

import { MessageAttachments } from './MessageAttachments'

type Intersection = (entries: Array<{ isIntersecting: boolean }>) => void

let bringIntoView: (isIntersecting: boolean) => void = () => {}

function attachment(overrides: Partial<AttachmentMetadata>): AttachmentMetadata {
    return { id: 'att-1', filename: 'shot.jpg', mimeType: 'image/jpeg', size: 551943, path: '/tmp/shot.jpg', ...overrides }
}

beforeEach(() => {
    fetchPreview.mockReset().mockResolvedValue(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }))
    Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:preview-1'),
        revokeObjectURL: vi.fn()
    })
    // jsdom has no IntersectionObserver: one that only "sees" the image when
    // the test scrolls it into view.
    let callback: Intersection | null = null
    let element: Element | null = null
    bringIntoView = (isIntersecting) => {
        if (!callback || !element) return
        callback([{ isIntersecting }])
    }
    vi.stubGlobal('IntersectionObserver', class {
        constructor(cb: Intersection) { callback = cb }
        observe(el: Element) { element = el }
        unobserve() {}
        disconnect() { callback = null }
    })
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

describe('MessageAttachments image previews', () => {
    it('renders an inline preview straight away without touching the network', () => {
        render(<MessageAttachments attachments={[attachment({ previewUrl: 'data:image/jpeg;base64,/9j/' })]} messageId="message-1" />)

        expect(screen.getByAltText('shot.jpg')).toBeInTheDocument()
        expect(fetchPreview).not.toHaveBeenCalled()
    })

    it('lazy-loads a preview the hub left off the page once the message is in view', async () => {
        render(
            <MessageAttachments
                attachments={[attachment({ hasPreview: true })]}
                messageId="message-1"
            />
        )

        // File row as a placeholder; nothing is fetched while off-screen.
        expect(screen.queryByAltText('shot.jpg')).toBeNull()
        expect(screen.getByText('shot.jpg')).toBeInTheDocument()
        expect(screen.getByText('539.0 KB')).toBeInTheDocument()
        bringIntoView(false)
        expect(fetchPreview).not.toHaveBeenCalled()

        bringIntoView(true)
        await waitFor(() => expect(screen.getByAltText('shot.jpg')).toBeInTheDocument())
        expect(fetchPreview).toHaveBeenCalledTimes(1)
        expect(fetchPreview.mock.calls[0].slice(0, 3)).toEqual(['session-1', 'message-1', 'att-1'])
        // Seen once: re-entering the viewport does not fetch again.
        bringIntoView(true)
        expect(fetchPreview).toHaveBeenCalledTimes(1)
    })

    it('keeps the file row when the preview cannot be loaded', async () => {
        fetchPreview.mockRejectedValue(new Error('Failed to fetch'))
        render(<MessageAttachments attachments={[attachment({ hasPreview: true })]} messageId="message-1" />)

        act(() => bringIntoView(true))
        await act(async () => { await Promise.resolve() })

        expect(screen.queryByAltText('shot.jpg')).toBeNull()
        expect(screen.getByText('shot.jpg')).toBeInTheDocument()
    })

    it('shows an image without any preview as a plain file row and never fetches', () => {
        // No `hasPreview` (old hub, or the attachment never had a preview) or no
        // hub message id (a local, not-yet-acked message): nothing to fetch.
        const { unmount } = render(<MessageAttachments attachments={[attachment({})]} messageId="message-1" />)
        act(() => bringIntoView(true))
        expect(screen.queryByAltText('shot.jpg')).toBeNull()
        expect(screen.getByText('shot.jpg')).toBeInTheDocument()
        expect(fetchPreview).not.toHaveBeenCalled()
        unmount()

        render(<MessageAttachments attachments={[attachment({ hasPreview: true })]} />)
        act(() => bringIntoView(true))
        expect(screen.getByText('shot.jpg')).toBeInTheDocument()
        expect(fetchPreview).not.toHaveBeenCalled()
    })

    it('revokes the object URL when the message unmounts', async () => {
        const { unmount } = render(<MessageAttachments attachments={[attachment({ hasPreview: true })]} messageId="message-1" />)
        act(() => bringIntoView(true))
        await waitFor(() => expect(screen.getByAltText('shot.jpg')).toBeInTheDocument())

        unmount()

        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    })

    it('lists remaining files after the images in the original order', () => {
        const { container } = render(
            <MessageAttachments
                attachments={[
                    attachment({ id: 'f1', filename: 'log.txt', mimeType: 'text/plain', size: 12, path: '/tmp/log.txt' }),
                    attachment({ id: 'a1', previewUrl: 'data:image/jpeg;base64,/9j/' }),
                    attachment({ id: 'a2', hasPreview: true })
                ]}
                messageId="message-1"
            />
        )

        const grid = container.querySelector('.hapi-share-media-grid')
        expect(grid?.getAttribute('data-hapi-image-count')).toBe('2')
        // Inline one renders immediately; the stripped one is still a file row.
        expect(grid?.children).toHaveLength(2)
        expect(screen.getAllByAltText('shot.jpg')).toHaveLength(1)
        expect(screen.getByText('log.txt')).toBeInTheDocument()
        expect(screen.getByText('12 B')).toBeInTheDocument()
    })
})

import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { blobToDataUrl, rehydrateAttachmentPreviews } from './attachmentPreviews'

function attachment(overrides: Partial<AttachmentMetadata>): AttachmentMetadata {
    return { id: 'att-1', filename: 'shot.jpg', mimeType: 'image/jpeg', size: 3, path: '/tmp/shot.jpg', ...overrides }
}

describe('blobToDataUrl', () => {
    it('reads a blob back into the data URL form the CLI materialises files from', async () => {
        const url = await blobToDataUrl(new Blob(['abc'], { type: 'image/jpeg' }))
        expect(url).toBe(`data:image/jpeg;base64,${btoa('abc')}`)
    })
})

describe('rehydrateAttachmentPreviews', () => {
    it('returns the input untouched when no attachment needs a preview', async () => {
        const api = { fetchMessageAttachmentPreviewBlob: vi.fn() } as unknown as ApiClient
        const inline = [attachment({ previewUrl: 'data:image/jpeg;base64,/9j/' })]
        const plain = [attachment({})]
        const missingPreview = [attachment({ hasPreview: false })]

        expect(await rehydrateAttachmentPreviews(api, 's', 'm', undefined)).toBeUndefined()
        expect(await rehydrateAttachmentPreviews(api, 's', 'm', inline)).toBe(inline)
        expect(await rehydrateAttachmentPreviews(api, 's', 'm', plain)).toBe(plain)
        expect(await rehydrateAttachmentPreviews(api, 's', 'm', missingPreview)).toBe(missingPreview)
        expect(api.fetchMessageAttachmentPreviewBlob).not.toHaveBeenCalled()
    })

    it('fetches only the stripped previews and keeps every other field', async () => {
        const fetchPreview = vi.fn(async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }))
        const api = { fetchMessageAttachmentPreviewBlob: fetchPreview } as unknown as ApiClient
        const attachments = [
            attachment({ id: 'a-plain', filename: 'log.txt', mimeType: 'text/plain' }),
            attachment({ id: 'a-stripped', hasPreview: true }),
            attachment({ id: 'a-inline', previewUrl: 'data:image/png;base64,iVBOR' })
        ]

        const hydrated = await rehydrateAttachmentPreviews(api, 'session-1', 'message-1', attachments)

        expect(fetchPreview).toHaveBeenCalledTimes(1)
        expect(fetchPreview).toHaveBeenCalledWith('session-1', 'message-1', 'a-stripped')
        expect(hydrated).toEqual([
            attachments[0],
            { id: 'a-stripped', filename: 'shot.jpg', mimeType: 'image/jpeg', size: 3, path: '/tmp/shot.jpg', hasPreview: true, previewUrl: `data:image/jpeg;base64,${btoa('jpeg-bytes')}` },
            attachments[2]
        ])
        // The stored message object is not written to.
        expect(attachments[1]).not.toHaveProperty('previewUrl')
    })

    it('leaves attachments as they are when the preview cannot be fetched', async () => {
        const api = { fetchMessageAttachmentPreviewBlob: vi.fn().mockRejectedValue(new Error('Failed to fetch')) } as unknown as ApiClient
        const attachments = [attachment({ hasPreview: true })]

        expect(await rehydrateAttachmentPreviews(api, 's', 'm', attachments)).toBe(attachments)
    })
})

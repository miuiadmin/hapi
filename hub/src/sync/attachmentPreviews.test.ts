import { describe, expect, it } from 'bun:test'
import {
    INLINE_IMAGE_PREVIEW_MAX_BYTES,
    decodeInlineImagePreview,
    extractInlineImagePreview,
    stripLargeInlineImagePreviews
} from './attachmentPreviews'

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function largeImage(type = 'jpeg'): string {
    // Just over the inline limit; the payload itself need not be a real image.
    const payload = 'A'.repeat(INLINE_IMAGE_PREVIEW_MAX_BYTES)
    return `data:image/${type};base64,${payload}`
}

function userMessage(attachments: unknown[], extra: Record<string, unknown> = {}) {
    return {
        id: 'm1',
        content: { role: 'user', content: { type: 'text', text: 'see screenshot', attachments }, ...extra },
        seq: 1
    }
}

describe('stripLargeInlineImagePreviews', () => {
    it('drops a large inline preview and marks the attachment with hasPreview', () => {
        const message = userMessage([{ id: 'a1', filename: 'shot.jpg', mimeType: 'image/jpeg', size: 5, path: '/tmp/shot.jpg', previewUrl: largeImage() }])
        const [stripped] = stripLargeInlineImagePreviews([message])
        const content = stripped!.content as { role: string; content: { type: string; text: string; attachments: Array<Record<string, unknown>> } }
        expect(content.role).toBe('user')
        expect(content.content.type).toBe('text')
        expect(content.content.text).toBe('see screenshot')
        expect(content.content.attachments).toHaveLength(1)
        expect(content.content.attachments[0]).toEqual({ id: 'a1', filename: 'shot.jpg', mimeType: 'image/jpeg', size: 5, path: '/tmp/shot.jpg', hasPreview: true })
        expect(content.content.attachments[0]).not.toHaveProperty('previewUrl')
    })

    it('keeps small previews inline', () => {
        const message = userMessage([{ id: 'a1', filename: 'icon.png', mimeType: 'image/png', size: PIXEL.length, path: '/tmp/icon.png', previewUrl: PIXEL }])
        const stripped = stripLargeInlineImagePreviews([message])
        const attachments = (stripped[0]!.content as { content: { attachments: Array<Record<string, unknown>> } }).content.attachments
        expect(attachments[0]).toMatchObject({ id: 'a1', previewUrl: PIXEL })
        expect(attachments[0]).not.toHaveProperty('hasPreview')
    })

    it('leaves non-image data URLs and messages without attachments untouched', () => {
        const message = userMessage([
            { id: 'a1', filename: 'doc.pdf', mimeType: 'application/pdf', size: 9, path: '/tmp/doc.pdf', previewUrl: `data:application/pdf;base64,${'B'.repeat(INLINE_IMAGE_PREVIEW_MAX_BYTES + 1)}` },
            { id: 'a2', filename: 'notes.txt', mimeType: 'text/plain', size: 3, path: '/tmp/notes.txt' }
        ])
        const reply = { id: 'm2', content: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }
        const stripped = stripLargeInlineImagePreviews([message, reply])
        expect(stripped).toBe(stripped)
        expect(stripped[0]).toBe(message)
        expect(stripped[1]).toBe(reply)
    })

    it('never mutates the input and keeps the array identity when nothing qualifies', () => {
        const original = userMessage([{ id: 'a1', filename: 'shot.jpg', mimeType: 'image/jpeg', size: 5, path: '/tmp/shot.jpg', previewUrl: largeImage() }])
        const page = [original]
        const stripped = stripLargeInlineImagePreviews(page)
        expect(stripped).not.toBe(page)
        expect(stripped[0]).not.toBe(original)
        const inner = (original.content as { content: { attachments: Array<Record<string, unknown>> } }).content
        expect(inner.attachments[0]).toHaveProperty('previewUrl')
        expect(inner.attachments[0]).not.toHaveProperty('hasPreview')

        const clean = [userMessage([{ id: 'a1', filename: 'icon.png', mimeType: 'image/png', size: 1, path: '/tmp/icon.png', previewUrl: PIXEL }])]
        expect(stripLargeInlineImagePreviews(clean)).toBe(clean)
    })

    it('handles attachments carried directly on content', () => {
        const message = { id: 'm1', content: { role: 'user', attachments: [{ id: 'a1', previewUrl: largeImage('webp') }] } }
        const stripped = stripLargeInlineImagePreviews([message])
        const content = stripped[0]!.content as { attachments: Array<Record<string, unknown>> }
        expect(content.attachments[0]).toEqual({ id: 'a1', hasPreview: true })
    })
})

describe('decodeInlineImagePreview', () => {
    it('decodes base64 and percent-encoded image data URLs', () => {
        const b64 = decodeInlineImagePreview(PIXEL)
        expect(b64?.mimeType).toBe('image/png')
        expect(Array.from(b64?.data ?? []).slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47])

        const escaped = decodeInlineImagePreview('data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E')
        expect(escaped?.mimeType).toBe('image/svg+xml')
        expect(Buffer.from(escaped?.data ?? new Uint8Array()).toString()).toBe('<svg></svg>')
    })

    it('rejects non-image and malformed data URLs', () => {
        expect(decodeInlineImagePreview('data:text/html;base64,PGI%2B')).toBeNull()
        expect(decodeInlineImagePreview('https://example.com/a.png')).toBeNull()
        expect(decodeInlineImagePreview('data:image/png;base64,')).toBeNull()
        expect(decodeInlineImagePreview('data:image/png;base64')).toBeNull()
    })
})

describe('extractInlineImagePreview', () => {
    it('returns the stored preview of the matching attachment id', () => {
        const message = userMessage([
            { id: 'a1', previewUrl: PIXEL },
            { id: 'a2', previewUrl: largeImage() }
        ])
        expect(extractInlineImagePreview(message as never, 'a1')?.mimeType).toBe('image/png')
        expect(extractInlineImagePreview(message as never, 'a2')?.mimeType).toBe('image/jpeg')
        expect(extractInlineImagePreview(message as never, 'a3')).toBeNull()
        expect(extractInlineImagePreview(message as never, 'a1')?.data.byteLength).toBeGreaterThan(0)
    })

    it('yields null without a message, an attachment list, or a preview', () => {
        expect(extractInlineImagePreview(null, 'a1')).toBeNull()
        expect(extractInlineImagePreview({ content: { role: 'user', content: 'hello' } } as never, 'a1')).toBeNull()
        expect(extractInlineImagePreview(userMessage([{ id: 'a1' }]) as never, 'a1')).toBeNull()
    })
})

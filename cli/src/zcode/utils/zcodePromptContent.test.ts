import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentMetadata } from '@/api/types'
import type { AcpSdkBackend } from '@/agent/backends/acp'

const authState = vi.hoisted(() => ({
    withinUploadDir: true,
    authorized: true
}))

vi.mock('@/modules/common/handlers/uploads', () => ({
    isPathWithinUploadDir: () => authState.withinUploadDir,
    isAuthorizedUploadFile: () => authState.authorized
}))

import {
    buildZcodePromptContent,
    formatZcodeUserMessage,
    isInlineImageAttachment,
    zcodeImageAttachmentsFor,
    ZCODE_MAX_IMAGE_BYTES
} from './zcodePromptContent'

function fakeBackend(imagePrompts: boolean): AcpSdkBackend {
    return { supportsImagePrompts: () => imagePrompts } as unknown as AcpSdkBackend
}

function attachment(partial: Partial<AttachmentMetadata> & { path: string; mimeType: string }): AttachmentMetadata {
    return {
        id: 'attachment-1',
        filename: 'file',
        size: 10,
        ...partial
    }
}

describe('isInlineImageAttachment', () => {
    it('accepts the bridge inline image mime types (case-insensitive)', () => {
        // png/jpeg/webp/gif/bmp/svg are the formats zcode-acp-server's
        // prompt-content accepts; image/jpg is the unnormalized jpeg.
        for (const mimeType of [
            'image/png',
            'image/jpeg',
            'image/jpg',
            'image/webp',
            'image/gif',
            'image/bmp',
            'image/svg+xml',
            'IMAGE/BMP'
        ]) {
            expect(isInlineImageAttachment(attachment({ path: '/uploads/a', mimeType }))).toBe(true)
        }
    })

    it('rejects other attachments (documents, non-canonical images)', () => {
        for (const mimeType of ['text/plain', 'application/pdf', 'image/heic', 'image/tiff', '']) {
            expect(isInlineImageAttachment(attachment({ path: '/uploads/a', mimeType }))).toBe(false)
        }
    })
})

describe('formatZcodeUserMessage', () => {
    it('keeps non-image attachments as @path references', () => {
        expect(formatZcodeUserMessage('hello', [
            attachment({ path: '/uploads/notes.txt', mimeType: 'text/plain' })
        ])).toBe('@/uploads/notes.txt\n\nhello')
    })

    it('excludes inline-capable images from the text form', () => {
        expect(formatZcodeUserMessage('hello', [
            attachment({ path: '/uploads/shot.svg', mimeType: 'image/svg+xml' }),
            attachment({ path: '/uploads/notes.txt', mimeType: 'text/plain' })
        ])).toBe('@/uploads/notes.txt\n\nhello')
    })

    it('keeps non-canonical images (e.g. heic) in the text form', () => {
        expect(formatZcodeUserMessage('hello', [
            attachment({ path: '/uploads/photo.heic', mimeType: 'image/heic' })
        ])).toBe('@/uploads/photo.heic\n\nhello')
    })

    it('returns the bare text when no attachments apply', () => {
        expect(formatZcodeUserMessage('hello', undefined)).toBe('hello')
        expect(formatZcodeUserMessage('hello', [])).toBe('hello')
    })
})

describe('zcodeImageAttachmentsFor', () => {
    it('collects only the inline-capable image attachments', () => {
        expect(zcodeImageAttachmentsFor([
            attachment({ path: '/uploads/a.png', mimeType: 'image/png', filename: 'a.png' }),
            attachment({ path: '/uploads/b.pdf', mimeType: 'application/pdf' }),
            attachment({ path: '/uploads/c.bmp', mimeType: 'image/bmp' })
        ])).toEqual({
            imageAttachments: [
                { path: '/uploads/a.png', mimeType: 'image/png', filename: 'a.png' },
                { path: '/uploads/c.bmp', mimeType: 'image/bmp', filename: 'file' }
            ]
        })
    })

    it('omits the field entirely without images', () => {
        expect(zcodeImageAttachmentsFor(undefined)).toEqual({})
        expect(zcodeImageAttachmentsFor([
            attachment({ path: '/uploads/b.pdf', mimeType: 'application/pdf' })
        ])).toEqual({})
    })
})

describe('buildZcodePromptContent', () => {
    let uploadDir: string

    beforeEach(async () => {
        authState.withinUploadDir = true
        authState.authorized = true
        uploadDir = await mkdtemp(join(tmpdir(), 'zcode-prompt-'))
    })

    afterEach(async () => {
        await rm(uploadDir, { recursive: true, force: true })
    })

    it('returns a plain text block without image attachments', async () => {
        const prompt = await buildZcodePromptContent(fakeBackend(true), 'hello', undefined, {
            sessionId: 'session-1',
            onNotice: () => {}
        })
        expect(prompt).toEqual([{ type: 'text', text: 'hello' }])
    })

    it('falls back to the @path text form when the backend does not advertise image prompts', async () => {
        const prompt = await buildZcodePromptContent(fakeBackend(false), 'hello', [
            { path: '/uploads/a.svg', mimeType: 'image/svg+xml' }
        ], { sessionId: 'session-1', onNotice: () => {} })
        expect(prompt).toEqual([{ type: 'text', text: '@/uploads/a.svg\n\nhello' }])
    })

    it('reads authorized image files into base64 image blocks', async () => {
        const imagePath = join(uploadDir, 'shot.png')
        await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

        const prompt = await buildZcodePromptContent(fakeBackend(true), 'look', [
            { path: imagePath, mimeType: 'image/png', filename: 'shot.png' }
        ], { sessionId: 'session-1', onNotice: () => {} })

        expect(prompt).toEqual([
            { type: 'text', text: 'look' },
            { type: 'image', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' }
        ])
    })

    it('normalizes image/jpg to the canonical image/jpeg mimeType', async () => {
        const imagePath = join(uploadDir, 'photo.jpg')
        await writeFile(imagePath, Buffer.from('jpg'))

        const prompt = await buildZcodePromptContent(fakeBackend(true), 'look', [
            { path: imagePath, mimeType: 'image/jpg' }
        ], { sessionId: 'session-1', onNotice: () => {} })

        expect(prompt[1]).toEqual({ type: 'image', data: Buffer.from('jpg').toString('base64'), mimeType: 'image/jpeg' })
    })

    it('notifies and skips an image beyond the bridge per-image cap', async () => {
        // The bridge caps one inline image at 10 MiB (PROMPT_LIMITS.image);
        // a bigger file must degrade to a notice, not fail the turn.
        expect(ZCODE_MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024)
        const bigPath = join(uploadDir, 'huge.png')
        await writeFile(bigPath, Buffer.alloc(ZCODE_MAX_IMAGE_BYTES + 1, 1))
        const notices: string[] = []

        const prompt = await buildZcodePromptContent(fakeBackend(true), 'look', [
            { path: bigPath, mimeType: 'image/png', filename: 'huge.png' }
        ], { sessionId: 'session-1', onNotice: (message) => notices.push(message) })

        expect(prompt).toEqual([{ type: 'text', text: 'look' }])
        expect(notices).toHaveLength(1)
        expect(notices[0]).toContain('Could not attach image huge.png')
    })

    it('notifies and skips an image outside the session upload dir', async () => {
        authState.withinUploadDir = false
        const notices: string[] = []

        const prompt = await buildZcodePromptContent(fakeBackend(true), 'look', [
            { path: '/elsewhere/shot.png', mimeType: 'image/png', filename: 'shot.png' }
        ], { sessionId: 'session-1', onNotice: (message) => notices.push(message) })

        expect(prompt).toEqual([{ type: 'text', text: 'look' }])
        expect(notices).toEqual(['Could not attach image shot.png: invalid upload path'])
    })

    it('notifies and skips an unreadable image without failing the turn', async () => {
        const notices: string[] = []
        const prompt = await buildZcodePromptContent(fakeBackend(true), 'look', [
            { path: join(uploadDir, 'missing.png'), mimeType: 'image/png' }
        ], { sessionId: 'session-1', onNotice: (message) => notices.push(message) })

        expect(prompt).toEqual([{ type: 'text', text: 'look' }])
        expect(notices).toHaveLength(1)
        expect(notices[0]).toContain('Could not attach image')
    })
})

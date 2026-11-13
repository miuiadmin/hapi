import type { AttachmentMetadata } from '@/api/types'
import type { AcpSdkBackend } from '@/agent/backends/acp'
import type { PromptContent } from '@/agent/types'
import { MAX_UPLOAD_BYTES } from '@/modules/common/attachmentLimits'
import { readBoundedAttachmentFile } from '@/modules/common/attachmentFile'
import {
    isAuthorizedUploadFile,
    isPathWithinUploadDir,
    type UploadFileIdentity
} from '@/modules/common/handlers/uploads'
import type { ZcodeImageAttachment } from '../types'

/**
 * MIME types the zcode-acp-server bridge accepts as inline image content
 * blocks (PROMPT_LIMITS.image in the bridge source): png/jpeg/webp/gif/
 * bmp/svg, up to 10 MiB per image.
 */
const INLINE_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/svg+xml'
])

/** Per-image inline cap (bridge PROMPT_LIMITS.image). */
export const ZCODE_MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Whether the attachment can be upgraded to an ACP image content block
 * (png/jpeg/webp/gif/bmp/svg only — the formats zcode's prompt content
 * accepts; `image/jpg` is the unnormalized spelling of jpeg). Other
 * attachments keep the @path text form. */
export function isInlineImageAttachment(attachment: AttachmentMetadata): boolean {
    const mimeType = attachment.mimeType?.toLowerCase().trim()
    if (!mimeType) return false
    return INLINE_IMAGE_MIME_TYPES.has(mimeType) || mimeType === 'image/jpg'
}

function normalizeImageMimeType(mimeType: string): string {
    const normalized = mimeType.toLowerCase().trim()
    if (normalized === 'image/jpg') return 'image/jpeg'
    // Some upload paths record bare "svg"; the bridge expects the full
    // MIME form.
    if (normalized === 'image/svg') return 'image/svg+xml'
    return normalized
}

/** Extract the image attachments that should ride a queued turn's mode. */
export function zcodeImageAttachmentsFor(
    attachments: AttachmentMetadata[] | undefined
): { imageAttachments?: ZcodeImageAttachment[] } {
    const images = (attachments ?? [])
        .filter((attachment) => isInlineImageAttachment(attachment))
        .map((attachment) => ({
            path: attachment.path,
            mimeType: attachment.mimeType,
            ...(attachment.filename ? { filename: attachment.filename } : {})
        }))
    return images.length > 0 ? { imageAttachments: images } : {}
}

/**
 * Text form of a user turn: NON-image attachments keep the @path reference
 * form (the model can read them with its own file tools). Inline-capable
 * images are excluded here and travel as mode metadata instead, so they are
 * never duplicated as both a path reference and a content block.
 */
export function formatZcodeUserMessage(
    text: string,
    attachments: AttachmentMetadata[] | undefined
): string {
    const refs = (attachments ?? [])
        .filter((attachment) => !isInlineImageAttachment(attachment))
        .map((attachment) => `@${attachment.path}`)
        .join(' ')
    if (!refs) return text
    return text ? `${refs}\n\n${text}` : refs
}

/**
 * Build the ACP prompt content for one ZCode turn.
 *
 * Image attachments become `{type:'image', data, mimeType}` blocks —
 * gated on the backend's advertised `promptCapabilities.image` from its
 * initialize result (the dsh launcher is the in-tree pattern). Files are
 * read through the shared bounded reader with per-session upload
 * authorization and the bridge's 10 MiB per-image cap; an unreadable or
 * over-limit image degrades to a status notice instead of failing the
 * whole turn. When the capability is absent (pinned community wrappers)
 * the images fall back to the legacy @path text form so the model keeps a
 * reference it can read itself.
 */
export async function buildZcodePromptContent(
    backend: AcpSdkBackend,
    text: string,
    imageAttachments: ZcodeImageAttachment[] | undefined,
    opts: {
        sessionId: string | undefined
        onNotice: (message: string) => void
    }
): Promise<PromptContent[]> {
    const images = imageAttachments ?? []
    if (images.length === 0) {
        return [{ type: 'text', text }]
    }
    if (!backend.supportsImagePrompts()) {
        const refs = images.map((image) => `@${image.path}`).join(' ')
        return [{ type: 'text', text: text ? `${refs}\n\n${text}` : refs }]
    }

    const prompt: PromptContent[] = [{ type: 'text', text }]
    let totalImageBytes = 0
    for (const image of images) {
        try {
            if (!isPathWithinUploadDir(image.path, opts.sessionId)) {
                throw new Error('invalid upload path')
            }
            const data = await readBoundedAttachmentFile(
                image.path,
                Math.min(
                    ZCODE_MAX_IMAGE_BYTES,
                    MAX_UPLOAD_BYTES - totalImageBytes
                ),
                (identity: UploadFileIdentity) =>
                    isAuthorizedUploadFile(image.path, opts.sessionId, identity)
            )
            totalImageBytes += data.length
            prompt.push({
                type: 'image',
                data: data.toString('base64'),
                mimeType: normalizeImageMimeType(image.mimeType)
            })
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            opts.onNotice(`Could not attach image ${image.filename ?? image.path}: ${detail}`)
        }
    }
    return prompt
}

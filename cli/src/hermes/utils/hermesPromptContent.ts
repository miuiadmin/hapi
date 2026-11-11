import type { AttachmentMetadata } from '@/api/types'
import type { AcpSdkBackend } from '@/agent/backends/acp'
import type { PromptContent } from '@/agent/types'
import { readBoundedAttachmentFile } from '@/modules/common/attachmentFile'
import {
    isAuthorizedUploadFile,
    isPathWithinUploadDir,
    type UploadFileIdentity
} from '@/modules/common/handlers/uploads'
import type { HermesImageAttachment } from '../types'

/**
 * Prompt-content helpers for the Hermes ACP flavor — the dsh pattern
 * (utils/dshPromptContent) minimally copied into the hermes area, with the
 * hermes-specific inline size clamp below. Do not refactor dsh from here.
 */

/** MIME types Hermes's gateway admits as staged inline images
 * (gateway/session_ingress_media._IMAGE_EXT: png / jpeg / gif / webp). */
const INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Hermes's ACP resource cap (acp_adapter/content.py
 * `_MAX_ACP_RESOURCE_BYTES`). Images larger than this are never inlined —
 * they fall back to the `@path` text reference so the model can still read
 * the file itself instead of the turn tripping the agent's content limits.
 */
export const HERMES_INLINE_IMAGE_MAX_BYTES = 512 * 1024

/** Whether the attachment can be upgraded to an ACP image content block
 * (png/jpeg/webp/gif only — the formats Hermes's promptCapabilities.image
 * accepts; other attachments keep the @path text form). */
export function isInlineImageAttachment(attachment: AttachmentMetadata): boolean {
    const mimeType = attachment.mimeType?.toLowerCase().trim()
    if (!mimeType) return false
    return INLINE_IMAGE_MIME_TYPES.has(mimeType) || mimeType === 'image/jpg'
}

function normalizeImageMimeType(mimeType: string): string {
    const normalized = mimeType.toLowerCase().trim()
    return normalized === 'image/jpg' ? 'image/jpeg' : normalized
}

/** Extract the image attachments that should ride a queued turn's mode. */
export function hermesImageAttachmentsFor(
    attachments: AttachmentMetadata[] | undefined
): { imageAttachments?: HermesImageAttachment[] } {
    const images = (attachments ?? [])
        .filter((attachment) => isInlineImageAttachment(attachment))
        .map((attachment) => ({
            path: attachment.path,
            mimeType: attachment.mimeType,
            size: attachment.size,
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
export function formatHermesUserMessage(
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
 * Build the ACP prompt content for one Hermes turn.
 *
 * Image attachments become `{type:'image', data, mimeType}` blocks — gated
 * on the backend's advertised `promptCapabilities.image` from its initialize
 * result. Files are read through the shared bounded reader with per-session
 * upload authorization; an unreadable image degrades to a status notice
 * instead of failing the whole turn. Images over the 512 KiB Hermes inline
 * cap (and every image when the capability is absent) fall back to the
 * legacy `@path` text form so the model keeps a reference it can read
 * itself.
 */
export async function buildHermesPromptContent(
    backend: AcpSdkBackend,
    text: string,
    imageAttachments: HermesImageAttachment[] | undefined,
    opts: {
        sessionId: string | undefined
        onNotice: (message: string) => void
    }
): Promise<PromptContent[]> {
    const images = imageAttachments ?? []
    if (images.length === 0) {
        return [{ type: 'text', text }]
    }

    const fallbackRefs: string[] = []
    const noteFallback = (image: HermesImageAttachment, reason: string): void => {
        fallbackRefs.push(`@${image.path}`)
        opts.onNotice(
            `${reason} ${image.filename ?? image.path}; sending it as a file reference instead.`
        )
    }

    if (!backend.supportsImagePrompts()) {
        const refs = images.map((image) => `@${image.path}`).join(' ')
        return [{ type: 'text', text: text ? `${refs}\n\n${text}` : refs }]
    }

    const imageBlocks: PromptContent[] = []
    let totalImageBytes = 0
    for (const image of images) {
        const remainingBudget = HERMES_INLINE_IMAGE_MAX_BYTES - totalImageBytes
        if (image.size !== undefined && image.size > remainingBudget) {
            noteFallback(image, `Image exceeds the ${HERMES_INLINE_IMAGE_MAX_BYTES} byte inline cap.`)
            continue
        }
        try {
            if (!isPathWithinUploadDir(image.path, opts.sessionId)) {
                throw new Error('invalid upload path')
            }
            const data = await readBoundedAttachmentFile(
                image.path,
                remainingBudget,
                (identity: UploadFileIdentity) =>
                    isAuthorizedUploadFile(image.path, opts.sessionId, identity)
            )
            totalImageBytes += data.length
            imageBlocks.push({
                type: 'image',
                data: data.toString('base64'),
                mimeType: normalizeImageMimeType(image.mimeType)
            })
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            opts.onNotice(`Could not attach image ${image.filename ?? image.path}: ${detail}`)
        }
    }

    if (imageBlocks.length === 0) {
        // Nothing made it inline (all over-limit or unreadable): keep the
        // over-limit ones as text references in a single text block.
        const refs = fallbackRefs.join(' ')
        return [{ type: 'text', text: refs ? (text ? `${refs}\n\n${text}` : refs) : text }]
    }
    if (fallbackRefs.length > 0) {
        const refs = fallbackRefs.join(' ')
        return [{ type: 'text', text: `${refs}\n\n${text}` }, ...imageBlocks]
    }
    return [{ type: 'text', text }, ...imageBlocks]
}

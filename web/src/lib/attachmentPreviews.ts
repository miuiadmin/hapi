import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'

/**
 * Message pages leave large inline image previews out (the hub marks those
 * attachments `hasPreview`) so a pasted screenshot is not re-downloaded with
 * every page refetch. The CLI still materialises the file on the runner from
 * `previewUrl`, so anything that re-sends a stored message — the failed-bubble
 * retry — has to put the preview back first.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment preview'))
        reader.readAsDataURL(blob)
    })
}

export async function rehydrateAttachmentPreviews(
    api: Pick<ApiClient, 'fetchMessageAttachmentPreviewBlob'>,
    sessionId: string,
    messageId: string,
    attachments: AttachmentMetadata[] | undefined
): Promise<AttachmentMetadata[] | undefined> {
    if (!attachments) return undefined
    const stripped = attachments.filter((attachment) => attachment.hasPreview === true && !attachment.previewUrl)
    if (stripped.length === 0) return attachments

    const previews = new Map<string, string>()
    await Promise.all(stripped.map(async (attachment) => {
        try {
            const blob = await api.fetchMessageAttachmentPreviewBlob(sessionId, messageId, attachment.id)
            previews.set(attachment.id, await blobToDataUrl(blob))
        } catch {
            // Best effort: the attachment still goes out with its name and
            // size, as it would without a preview.
        }
    }))
    if (previews.size === 0) return attachments
    return attachments.map((attachment) => {
        const previewUrl = previews.get(attachment.id)
        return previewUrl ? { ...attachment, previewUrl } : attachment
    })
}

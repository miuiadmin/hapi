import { useEffect, useRef, useState } from 'react'
import type { AttachmentMetadata } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { isImageMimeType } from '@/lib/fileAttachments'
import { ImagePreview } from '@/components/ImagePreview'
import { useHappyChatContext } from '@/components/AssistantChat/context'

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const IMAGE_BUTTON_CLASS_NAME = 'relative overflow-hidden rounded-lg text-left cursor-zoom-in'
const IMAGE_CAPTION_CLASS_NAME = 'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5'

function ImageAttachment(props: { attachment: AttachmentMetadata; src: string }) {
    const { attachment, src } = props
    return (
        <ImagePreview
            src={src}
            fileName={attachment.filename}
            label={attachment.filename}
            fileSize={attachment.size}
            buttonClassName={IMAGE_BUTTON_CLASS_NAME}
            imageClassName="max-h-48 max-w-full object-contain"
            caption={(
                <div className={IMAGE_CAPTION_CLASS_NAME}>
                    <span className="text-xs text-white/90 line-clamp-1">
                        {attachment.filename}
                    </span>
                </div>
            )}
        />
    )
}

function FileAttachment(props: { attachment: AttachmentMetadata }) {
    const { attachment } = props
    return (
        <div className="flex items-center gap-2 rounded-lg bg-[var(--app-bg)] px-3 py-2">
            <FileIcon fileName={attachment.filename} size={24} />
            <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium text-[var(--app-fg)]">
                    {attachment.filename}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    {formatFileSize(attachment.size)}
                </div>
            </div>
        </div>
    )
}

/** Preload the image shortly before it scrolls into the viewport. */
const LAZY_PREVIEW_ROOT_MARGIN = '600px 0px'

/**
 * Image whose inline preview was too large to ride along on the message page
 * (the hub marks it `hasPreview`). The bytes are fetched once the message
 * approaches the viewport — a pasted phone screenshot is 0.7-0.9 MB of base64
 * and used to be re-downloaded with every page refetch of the session. Until
 * it arrives (and if it cannot be loaded) the plain file row is shown.
 */
export function LazyImageAttachment(props: { attachment: AttachmentMetadata; messageId: string }) {
    const { attachment, messageId } = props
    const { api, sessionId } = useHappyChatContext()
    const rootRef = useRef<HTMLDivElement>(null)
    const [objectUrl, setObjectUrl] = useState<string | null>(null)

    useEffect(() => {
        const root = rootRef.current
        if (!root) return
        let cancelled = false
        let observer: IntersectionObserver | null = null
        let createdUrl: string | null = null
        const controller = new AbortController()
        const load = () => {
            void api.fetchMessageAttachmentPreviewBlob(sessionId, messageId, attachment.id, controller.signal)
                .then((blob) => {
                    if (cancelled) return
                    createdUrl = URL.createObjectURL(blob)
                    setObjectUrl(createdUrl)
                })
                .catch(() => {
                    // Offline, stale message id, or an old hub without the
                    // route: the file row below stays in place.
                })
        }
        if (typeof IntersectionObserver === 'undefined') {
            load()
        } else {
            observer = new IntersectionObserver((entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return
                observer?.disconnect()
                load()
            }, { rootMargin: LAZY_PREVIEW_ROOT_MARGIN })
            observer.observe(root)
        }
        return () => {
            cancelled = true
            observer?.disconnect()
            controller.abort()
            if (createdUrl) URL.revokeObjectURL(createdUrl)
        }
    }, [api, sessionId, messageId, attachment.id])

    return (
        <div ref={rootRef}>
            {objectUrl
                ? <ImageAttachment attachment={attachment} src={objectUrl} />
                : <FileAttachment attachment={attachment} />}
        </div>
    )
}

export function MessageAttachments(props: { attachments: AttachmentMetadata[]; messageId?: string }) {
    const { attachments, messageId } = props
    if (!attachments || attachments.length === 0) return null

    const isInlineImage = (a: AttachmentMetadata) => isImageMimeType(a.mimeType) && Boolean(a.previewUrl)
    const isLazyImage = (a: AttachmentMetadata) =>
        isImageMimeType(a.mimeType) && !a.previewUrl && a.hasPreview === true && Boolean(messageId)

    // One grid in the original attachment order; file rows follow the images.
    const media = attachments.filter(a => isInlineImage(a) || isLazyImage(a))
    const files = attachments.filter(a => !isInlineImage(a) && !isLazyImage(a))

    return (
        <div className="mt-2 flex flex-col gap-2">
            {media.length > 0 && (
                <div
                    className="hapi-share-media-grid flex flex-wrap gap-2"
                    data-hapi-image-count={media.length}
                >
                    {media.map(attachment => (
                        isInlineImage(attachment)
                            ? <ImageAttachment key={attachment.id} attachment={attachment} src={attachment.previewUrl!} />
                            : <LazyImageAttachment key={attachment.id} attachment={attachment} messageId={messageId!} />
                    ))}
                </div>
            )}
            {files.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    {files.map(attachment => (
                        <FileAttachment key={attachment.id} attachment={attachment} />
                    ))}
                </div>
            )}
        </div>
    )
}

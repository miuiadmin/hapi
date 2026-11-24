import type { DecryptedMessage } from '@hapi/protocol'

/**
 * Inline image previews on message pages.
 *
 * A pasted screenshot travels inside the message as a base64 data URL
 * (`attachments[].previewUrl`); the CLI materialises the file on the runner
 * machine from it, so the hub stores it verbatim. It must not ride along on
 * every message page the web client pulls, though. One phone screenshot is
 * 0.7-0.9 MB of base64 that gzip cannot touch, and a tool-heavy session
 * refetches its 200-row context page on every cold open — measured as 577 KB
 * on the wire per open for a single screenshot, ~20 refetches in an afternoon.
 *
 * Message pages therefore drop large inline previews and mark the attachment
 * with `hasPreview`; the web loads the bytes on demand from
 * GET /sessions/:id/messages/:messageId/attachments/:attachmentId/preview.
 * Small previews (thumbnails, icons) stay inline.
 */
export const INLINE_IMAGE_PREVIEW_MAX_BYTES = 24 * 1024

const DATA_IMAGE_PREFIX = 'data:image/'

type JsonObject = Record<string, unknown>
type MessageLike = { content: unknown }

/** `content.content.attachments` (user text blocks) and/or `content.attachments`. */
function attachmentLists(message: MessageLike): JsonObject[][] {
    const outer = message.content
    if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return []
    const outerRecord = outer as JsonObject
    const inner = outerRecord.content
    const holders: JsonObject[] = []
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) holders.push(inner as JsonObject)
    holders.push(outerRecord)
    return holders
        .map((holder) => holder.attachments)
        .filter((list): list is JsonObject[] => Array.isArray(list))
}

function isStrippedCandidate(item: unknown): item is JsonObject {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const url = (item as JsonObject).previewUrl
    return typeof url === 'string'
        && url.length > INLINE_IMAGE_PREVIEW_MAX_BYTES
        && url.startsWith(DATA_IMAGE_PREFIX)
}

function stripList(list: JsonObject[]): { list: JsonObject[]; changed: boolean } {
    if (!list.some(isStrippedCandidate)) return { list, changed: false }
    return {
        changed: true,
        list: list.map((item) => {
            if (!isStrippedCandidate(item)) return item
            const { previewUrl: _dropped, ...rest } = item
            return { ...rest, hasPreview: true }
        }),
    }
}

/**
 * Message page with large inline image previews removed. Returns the input
 * array when nothing qualifies (the common case) and never mutates a message:
 * pages are built from cached rows, so every touched message is copied.
 */
export function stripLargeInlineImagePreviews<T extends MessageLike>(messages: T[]): T[] {
    let changed = false
    const next = messages.map((message) => {
        const lists = attachmentLists(message)
        if (lists.length === 0) return message
        const outer = message.content as JsonObject
        const inner = outer.content
        const hasInner = inner && typeof inner === 'object' && !Array.isArray(inner)
        const innerList = hasInner ? (inner as JsonObject).attachments : undefined
        const outerList = outer.attachments

        let nextOuter = outer
        let nextInner = inner
        if (Array.isArray(innerList)) {
            const result = stripList(innerList as JsonObject[])
            if (result.changed) {
                changed = true
                nextInner = { ...(inner as JsonObject), attachments: result.list }
            }
        }
        if (Array.isArray(outerList) && outerList !== innerList) {
            const result = stripList(outerList as JsonObject[])
            if (result.changed) {
                changed = true
                nextOuter = { ...outer, attachments: result.list }
            }
        }
        if (nextInner === inner && nextOuter === outer) return message
        return { ...message, content: nextInner === inner ? nextOuter : { ...nextOuter, content: nextInner } }
    })
    return changed ? (next as T[]) : messages
}

export type InlineImagePreview = { mimeType: string; data: Uint8Array }

/** Decode a `data:image/...;base64,` URL; anything else yields null. */
export function decodeInlineImagePreview(url: string): InlineImagePreview | null {
    if (!url.startsWith(DATA_IMAGE_PREFIX)) return null
    const comma = url.indexOf(',')
    if (comma < 0) return null
    const [mediaType, ...params] = url.slice(5, comma).split(';')
    const payload = url.slice(comma + 1)
    let data: Buffer
    if (params.includes('base64')) {
        data = Buffer.from(payload, 'base64')
    } else {
        data = Buffer.from(decodeURIComponent(payload), 'utf8')
    }
    if (data.length === 0) return null
    return { mimeType: mediaType, data: new Uint8Array(data) }
}

/** The stored inline preview of one attachment, or null when it has none. */
export function extractInlineImagePreview(
    message: Pick<DecryptedMessage, 'content'> | null | undefined,
    attachmentId: string
): InlineImagePreview | null {
    if (!message) return null
    for (const list of attachmentLists(message)) {
        for (const item of list) {
            if (item.id !== attachmentId) continue
            const url = item.previewUrl
            return typeof url === 'string' ? decodeInlineImagePreview(url) : null
        }
    }
    return null
}

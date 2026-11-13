import type { PermissionMode } from '@hapi/protocol/types'

export type ZcodeMode = {
    /** Opaque ACP config-option value (ZCode: `providerId\modelId` picker
     * values — sent back verbatim when switching). null = explicit reset to
     * the server default ("Default" in the picker); undefined = no
     * preference (keep whatever the backend is running). */
    model?: string | null
    /** HAPI permission mode attached to the outgoing turn. undefined = the
     * session default ('default'). The launcher maps it onto zcode's own
     * mode axis (default→build, read-only→plan, safe-yolo→guarded,
     * yolo→yolo) through session/set_mode; the HAPI permission bridge
     * reads the session's live mode on every request_permission. */
    permissionMode?: PermissionMode
    /** Inline image attachments upgraded to ACP image content blocks at
     * prompt time (see utils/zcodePromptContent). Part of the mode so the
     * queue's mode hash separates image-carrying turns: collectBatch only
     * keeps the first item's mode, so an image message must never merge
     * into a batch whose mode would silently drop its images. */
    imageAttachments?: ZcodeImageAttachment[]
}

/** Image attachment metadata traveling with a queued turn. The file is read
 * (authorized per session) only at prompt time, when the backend's
 * advertised image capability is known. */
export type ZcodeImageAttachment = {
    /** Registered upload path. */
    path: string
    mimeType: string
    filename?: string
}

/** Mode attached to an outgoing turn. The model preference is three-state:
 *  undefined = nothing requested yet (ordinary turns carry no model field at
 *  all), null = the picker's explicit "Default" reset, string = a concrete
 *  model. Collapsing undefined into null would make every ordinary turn look
 *  like a reset request when no model is known. The permission mode is only
 *  attached once the session state carries one, so ordinary turns stay lean. */
export function zcodeModeForPreference(
    model: string | null | undefined,
    permissionMode?: PermissionMode
): ZcodeMode {
    const mode: ZcodeMode = model === undefined ? {} : { model }
    if (permissionMode !== undefined) {
        mode.permissionMode = permissionMode
    }
    return mode
}

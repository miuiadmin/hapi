export type DshMode = {
    /** Opaque ACP config-option value (dsh: JSON-encoded provider+model tuple).
     * null = explicit reset to the server default ("Default" in the picker);
     * undefined = no preference (keep whatever the backend is running). */
    model?: string | null
}

import { supportsEffort } from '@hapi/protocol'

/** Labels shared by SessionHeader and composer StatusBar for supported reasoning providers. */

export function formatCompactReasoningLabel(effort?: string | null): string {
    const normalized = effort?.trim().toLowerCase()
    if (!normalized || normalized === 'default') return 'default'
    return normalized
}

export function formatReasoningLabel(effort?: string | null, showLabel = true): string {
    const value = formatCompactReasoningLabel(effort)
    return showLabel ? `effort ${value}` : value
}

/**
 * Status metadata comes from different session fields by agent protocol:
 * Codex/OpenCode/DSH publish model reasoning effort; the other effort-capable
 * flavors publish effort.
 */
export function getReasoningEffortForFlavor(
    agentFlavor: string | null | undefined,
    modelReasoningEffort?: string | null,
    effort?: string | null
): string | null {
    if (agentFlavor === 'codex' || agentFlavor === 'opencode' || agentFlavor === 'dsh') {
        return modelReasoningEffort?.trim() || null
    }
    if (supportsEffort(agentFlavor)) {
        return effort?.trim() || null
    }
    return null
}

export function shouldShowReasoningStatusLabel(
    agentFlavor: string | null | undefined,
    reasoningEffort?: string | null
): boolean {
    // Flavors whose models always take an effort show "default" when unset.
    if (agentFlavor === 'codex' || agentFlavor === 'opencode' || agentFlavor === 'claude' || agentFlavor === 'grok') return true
    // DSH publishes modelReasoningEffort (see above) but has no Effort
    // capability: '' (Provider default) stays silent, explicit levels show.
    if (agentFlavor === 'dsh') return Boolean(reasoningEffort?.trim())
    // Pi and AGY models may have no effort at all; only show a real level.
    return supportsEffort(agentFlavor) && Boolean(reasoningEffort?.trim())
}

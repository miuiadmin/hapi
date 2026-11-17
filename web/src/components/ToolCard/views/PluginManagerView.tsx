import { isObject } from '@hapi/protocol'
import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { getInputStringAny } from '@/lib/toolInputUtils'

/**
 * Parsers for the DSH `plugin_manager` tool call.
 *
 * Input shape (rawInput of the tool_call):
 *   { action: list_plugins | list_bundles | set_plugin | set_bundle |
 *             install_bundle | remove_bundle | list_version_exemptions |
 *             set_version_exemption,
 *     target?, enabled?, registry?, … }
 *
 * Result shape (tool-call-result text — DSH JSON.stringify's the payload):
 *   - list actions:  { entries: [...], total, nextOffset }
 *   - change actions: { application: applied | cancelled | overridden |
 *                       restart-required | failed, nextStep?, error?,
 *                       packageResult?, restartReason? }
 * `nextStep` is the model-facing hint of what to do or tell the user next;
 * it gets its own rendered line.
 */

export type PluginManagerOutcome =
    | { kind: 'listed'; total: number; shown: number; nextOffset: number | null }
    | { kind: 'exemptions'; runtimeVersion: string | null }
    | { kind: 'changed'; application: string; nextStep: string | null; detail: string | null }
    | { kind: 'text'; message: string }

export function parsePluginManagerResult(result: unknown): PluginManagerOutcome | null {
    if (result === null || result === undefined) return null

    let parsed: unknown = result
    if (typeof result === 'string') {
        const text = result.trim()
        if (!text) return null
        try {
            parsed = JSON.parse(text)
        } catch {
            return { kind: 'text', message: text }
        }
    }
    if (!isObject(parsed)) return null

    if (Array.isArray(parsed.entries) && typeof parsed.total === 'number') {
        return {
            kind: 'listed',
            total: parsed.total,
            shown: parsed.entries.length,
            nextOffset: typeof parsed.nextOffset === 'number' ? parsed.nextOffset : null
        }
    }

    if (typeof parsed.application === 'string') {
        const nextStep = typeof parsed.nextStep === 'string' && parsed.nextStep.trim()
            ? parsed.nextStep.trim()
            : null
        // Failure payloads carry the refusal code and the package-manager
        // failure kind; surface both when present.
        const details: string[] = []
        const error = isObject(parsed.error) ? parsed.error : null
        if (error && typeof error.code === 'string') details.push(`error: ${error.code}`)
        const packageResult = isObject(parsed.packageResult) ? parsed.packageResult : null
        if (packageResult && typeof packageResult.kind === 'string') details.push(`package: ${packageResult.kind}`)
        if (typeof parsed.restartReason === 'string') details.push(`restart: ${parsed.restartReason}`)
        return { kind: 'changed', application: parsed.application, nextStep, detail: details.join(' · ') || null }
    }

    if (typeof parsed.runtimeVersion === 'string' || typeof parsed.exemptions === 'object') {
        return {
            kind: 'exemptions',
            runtimeVersion: typeof parsed.runtimeVersion === 'string' ? parsed.runtimeVersion : null
        }
    }

    return { kind: 'text', message: JSON.stringify(parsed, null, 2) }
}

function Chip(props: { children: string; title?: string }) {
    return (
        <span
            title={props.title}
            className="inline-flex max-w-full items-center truncate rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 font-mono text-[11px] leading-5 text-[var(--app-hint)]"
        >
            {props.children}
        </span>
    )
}

function applicationTone(application: string): string | null {
    switch (application) {
        case 'applied': return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        case 'restart-required': return 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
        case 'failed': return 'bg-red-500/10 text-red-700 dark:text-red-300'
        case 'cancelled': return 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'
        default: return null
    }
}

function ApplicationBadge(props: { application: string; detail: string | null }) {
    const tone = applicationTone(props.application)
    return (
        <span
            className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tone ?? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'}`}
            data-plugin-application={props.application}
        >
            {props.application}{props.detail ? ` — ${props.detail}` : ''}
        </span>
    )
}

function NextStepLine(props: { nextStep: string }) {
    return (
        <div
            className="rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-fg)]"
            data-plugin-next-step
        >
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                Next step
            </div>
            <div className="whitespace-pre-wrap break-words">{props.nextStep}</div>
        </div>
    )
}

/** Result summary: list counts, change badge with its nextStep hint, or raw text. */
export function PluginManagerOutcomeView(props: { outcome: PluginManagerOutcome }) {
    const outcome = props.outcome
    if (outcome.kind === 'listed') {
        return (
            <div className="flex min-w-0 flex-wrap items-center gap-2" data-plugin-result="listed">
                <span className="inline-flex w-fit items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    {outcome.total === 1 ? '1 entry' : `${outcome.total} entries`}
                </span>
                {outcome.nextOffset !== null ? <Chip title="more entries follow">{`next: ${outcome.nextOffset}`}</Chip> : null}
            </div>
        )
    }
    if (outcome.kind === 'exemptions') {
        return (
            <div className="flex min-w-0 flex-wrap items-center gap-2" data-plugin-result="exemptions">
                {outcome.runtimeVersion ? <Chip title="runtime version">{outcome.runtimeVersion}</Chip> : null}
            </div>
        )
    }
    if (outcome.kind === 'changed') {
        return (
            <div className="flex min-w-0 flex-col gap-2" data-plugin-result="changed">
                <ApplicationBadge application={outcome.application} detail={outcome.detail} />
                {outcome.nextStep ? <NextStepLine nextStep={outcome.nextStep} /> : null}
            </div>
        )
    }
    return (
        <div className="whitespace-pre-wrap break-words text-sm text-[var(--app-fg)]" data-plugin-result="text">
            {outcome.message}
        </div>
    )
}

export function PluginManagerView({ block, surface }: ToolViewProps) {
    const input = block.tool.input
    const action = getInputStringAny(input, ['action'])
    const target = getInputStringAny(input, ['target'])
    const registry = getInputStringAny(input, ['registry'])
    const enabled = isObject(input) && typeof input.enabled === 'boolean' ? input.enabled : null
    const outcome = parsePluginManagerResult(block.tool.result)
    if (!action && !target && !outcome) return null
    const dialog = surface === 'dialog'

    return (
        <div className="flex min-w-0 flex-col gap-2" data-plugin-manager-view>
            {action || target || registry !== null || enabled !== null ? (
                <div className="flex flex-wrap gap-1" data-plugin-manager-input>
                    {action ? <Chip>{action}</Chip> : null}
                    {target ? <Chip title={target}>{target}</Chip> : null}
                    {enabled !== null ? <Chip>{enabled ? 'enabled' : 'disabled'}</Chip> : null}
                    {registry ? <Chip title={registry}>{registry}</Chip> : null}
                </div>
            ) : null}
            {/* The dialog's Result section renders the outcome below; only the
                inline card folds it in here. */}
            {outcome && !dialog ? <PluginManagerOutcomeView outcome={outcome} /> : null}
        </div>
    )
}

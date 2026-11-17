import { isObject, safeStringify } from '@hapi/protocol'
import { CodeBlock } from '@/components/CodeBlock'
import type { ToolViewProps } from '@/components/ToolCard/views/_all'

/**
 * Parsers for the DSH `run_code` tool call (PTC: the model writes a
 * TypeScript program that calls tools through a generated SDK).
 *
 * Input shape (rawInput of the tool_call):
 *   { code: <TypeScript>, description: <UI label>, timeoutMs?, … }
 *
 * Result shape: DSH's ACP bridge flattens the structured output
 *   { logs: string[], result?: json, sandbox? } into one rendered text
 *   (logs joined, then the rendered result). Both the structured object and
 *   the flattened text are accepted here, so the split survives either wire.
 */

export type RunCodeOutcome = {
    logs: string[]
    /** The program's printed/returned value — rendered text or stringified JSON. */
    resultText: string | null
}

function renderRunCodeValue(value: unknown): string | null {
    if (value === undefined || value === null) return null
    if (typeof value === 'string') return value
    return safeStringify(value)
}

function parseStructuredRunCode(parsed: Record<string, unknown>): RunCodeOutcome | null {
    if (!Array.isArray(parsed.logs)) return null
    const logs = parsed.logs.filter((line): line is string => typeof line === 'string' && line.length > 0)
    return { logs, resultText: renderRunCodeValue(parsed.result) }
}

export function parseRunCodeResult(result: unknown): RunCodeOutcome | null {
    if (result === null || result === undefined) return null

    if (isObject(result)) {
        const structured = parseStructuredRunCode(result)
        if (structured) return structured
    }

    if (typeof result === 'string') {
        const text = result.trim()
        if (!text) return null
        // Some bridges ship the structured payload as its JSON text; accept
        // that too before falling back to the rendered-text reading.
        try {
            const parsed: unknown = JSON.parse(text)
            if (isObject(parsed)) {
                const structured = parseStructuredRunCode(parsed)
                if (structured) return structured
            }
        } catch {
            // Not JSON — plain rendered text below.
        }
        return { logs: [], resultText: text }
    }

    return null
}

function OutcomeSection(props: { outcome: RunCodeOutcome; surface?: ToolViewProps['surface'] }) {
    return (
        <div className="flex min-w-0 flex-col gap-2" data-run-code-outcome>
            {props.outcome.logs.length > 0 ? (
                <CodeBlock
                    code={props.outcome.logs.join('\n')}
                    language="text"
                    title="Logs"
                    {...(props.surface === 'dialog'
                        ? { collapseLongContent: false, size: 'comfortable' as const, scrollY: true }
                        : { collapseLongContent: true, showWrapToggle: false })}
                />
            ) : null}
            {props.outcome.resultText ? (
                <CodeBlock
                    code={props.outcome.resultText}
                    language="json"
                    title="Result"
                    {...(props.surface === 'dialog'
                        ? { collapseLongContent: false, size: 'comfortable' as const, scrollY: true }
                        : { collapseLongContent: true, showWrapToggle: false })}
                />
            ) : null}
        </div>
    )
}

export function RunCodeView({ block, surface }: ToolViewProps) {
    const input = block.tool.input
    const code = isObject(input) && typeof input.code === 'string' && input.code.trim()
        ? input.code
        : null
    const outcome = parseRunCodeResult(block.tool.result)
    if (!code && !outcome) return null
    const dialog = surface === 'dialog'

    return (
        <div className="flex min-w-0 flex-col gap-2" data-run-code-view>
            {code ? (
                <details className="min-w-0 text-xs text-[var(--app-hint)]" data-run-code-program>
                    <summary className="cursor-pointer py-1">Program</summary>
                    <CodeBlock
                        code={code}
                        language="typescript"
                        {...(dialog
                            ? { collapseLongContent: false, size: 'comfortable' as const, scrollY: true }
                            : { collapseLongContent: true, showWrapToggle: false })}
                    />
                </details>
            ) : null}
            {/* The dialog's Result section renders the outcome below; only the
                inline card folds it in here. */}
            {outcome && !dialog ? <OutcomeSection outcome={outcome} /> : null}
        </div>
    )
}

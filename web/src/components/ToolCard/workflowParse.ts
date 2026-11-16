import { isObject } from '@hapi/protocol'
import type { ChecklistStatus } from '@/components/ToolCard/checklist'

/**
 * Parsers for the DSH `workflow` tool call.
 *
 * Input shape (rawInput of the tool_call):
 *   { args, meta: { name, description, phases: [{ title, detail }] },
 *     run_in_background, script: <JavaScript> }
 *
 * Result shape (tool-call-result text):
 *   - blocking run, success:  workflow "NAME" completed (N agents)
 *                             Return value:
 *                             ```json ... ``` (or bare JSON)
 *   - blocking run, failure:  Error: <message>
 *   - background run:         workflow "NAME" started in the background as
 *                             job workflow-<hex>
 */

export type WorkflowPhase = {
    title: string
    detail: string | null
    /** Agent labels declared inside this phase (script `label: '...'` opts). */
    agents: string[]
}

export type WorkflowPlan = {
    name: string | null
    description: string | null
    /** True when the invocation asked for run_in_background. */
    background: boolean
    phases: WorkflowPhase[]
    /** Agent labels with no phase sibling (rendered outside the checklist). */
    strayAgents: string[]
    /** True when the script carried a `[hapi: truncated N chars]` marker. */
    truncated: boolean
}

export type WorkflowOutcome =
    | { kind: 'completed'; name: string | null; agents: number; returnValue: string | null }
    | { kind: 'background'; name: string | null; jobId: string }
    | { kind: 'error'; message: string }

/** Truncation markers injected when the runner clips oversized payloads. */
const TRUNCATION_MARKER_RE = /\[hapi:\s*truncated\s+\d+\s+chars?\s*\]/gi

export function stripWorkflowTruncationMarkers(script: string): { script: string; truncated: boolean } {
    const markers = script.match(TRUNCATION_MARKER_RE)
    if (!markers) return { script, truncated: false }
    return { script: script.replace(TRUNCATION_MARKER_RE, ''), truncated: true }
}

function unescapeJsStringLiteral(value: string): string {
    return value.replace(/\\(['"`\\])/g, '$1')
}

const PHASE_CALL_RE = /\bphase\s*\(\s*(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g
const LABEL_RE = /\blabel\s*:\s*(["'])((?:\\.|(?!\1)[^\\\n]){1,60})\1/g
// Used via stateless exec() on one opts literal at a time — no /g flag, so
// lastIndex never leaks between objects.
const PHASE_SIBLING_RE = /\bphase\s*:\s*(["'])((?:\\.|(?!\1)[^\\\n])*)\1/

type ScriptAgent = { label: string; phaseTitle: string | null }

function scanScriptAgents(script: string): { phases: string[]; agents: ScriptAgent[] } {
    const phaseTitles: string[] = []
    for (const match of script.matchAll(PHASE_CALL_RE)) {
        const title = unescapeJsStringLiteral(match[2] ?? '').trim()
        if (title && !phaseTitles.includes(title)) phaseTitles.push(title)
    }

    const agents: ScriptAgent[] = []
    for (const match of script.matchAll(LABEL_RE)) {
        const label = unescapeJsStringLiteral(match[2] ?? '').trim()
        if (!label) continue

        // A `label:` option sits inside its agent's opts object; restrict the
        // `phase:` sibling search to that enclosing {...} literal so adjacent
        // agent() calls (and phase() calls elsewhere) do not bleed in.
        const open = script.lastIndexOf('{', match.index)
        const close = open >= 0 ? script.indexOf('}', match.index) : -1
        let phaseTitle: string | null = null
        if (open >= 0 && close > match.index) {
            const opts = script.slice(open, close)
            const sibling = PHASE_SIBLING_RE.exec(opts)
            if (sibling) phaseTitle = unescapeJsStringLiteral(sibling[2] ?? '').trim() || null
        }
        agents.push({ label, phaseTitle })
    }

    return { phases: phaseTitles, agents }
}

function findPhaseIndex(phases: WorkflowPhase[], title: string): number {
    const exact = phases.findIndex((phase) => phase.title === title)
    if (exact >= 0) return exact
    const folded = title.toLowerCase()
    return phases.findIndex((phase) => phase.title.toLowerCase() === folded)
}

export function parseWorkflowInput(input: unknown): WorkflowPlan | null {
    if (!isObject(input)) return null

    const meta = isObject(input.meta) ? input.meta : null
    const rawScript = typeof input.script === 'string' ? input.script : null
    if (!meta && rawScript === null) return null

    const { script, truncated } = rawScript !== null
        ? stripWorkflowTruncationMarkers(rawScript)
        : { script: '', truncated: false }

    const name = meta && typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : null
    const description = meta && typeof meta.description === 'string' && meta.description.trim()
        ? meta.description.trim()
        : null

    const phases: WorkflowPhase[] = []
    if (meta && Array.isArray(meta.phases)) {
        for (const entry of meta.phases) {
            if (!isObject(entry) || typeof entry.title !== 'string' || !entry.title.trim()) continue
            const detail = typeof entry.detail === 'string' && entry.detail.trim() ? entry.detail.trim() : null
            phases.push({ title: entry.title.trim(), detail, agents: [] })
        }
    }

    const scanned = scanScriptAgents(script)
    if (phases.length === 0) {
        for (const title of scanned.phases) {
            phases.push({ title, detail: null, agents: [] })
        }
    }

    const strayAgents: string[] = []
    for (const agent of scanned.agents) {
        const index = agent.phaseTitle !== null ? findPhaseIndex(phases, agent.phaseTitle) : -1
        if (index >= 0) {
            if (!phases[index].agents.includes(agent.label)) phases[index].agents.push(agent.label)
        } else if (agent.phaseTitle !== null) {
            // A label names a phase the structured meta did not declare; keep
            // the grouping instead of dropping it on the floor.
            phases.push({ title: agent.phaseTitle, detail: null, agents: [agent.label] })
        } else if (!strayAgents.includes(agent.label)) {
            strayAgents.push(agent.label)
        }
    }

    return {
        name,
        description,
        background: input.run_in_background === true,
        phases,
        strayAgents,
        truncated
    }
}

/** Only unwrap documented result/text containers; arbitrary objects are not searched. */
function extractWorkflowResultText(result: unknown, depth = 0): string | null {
    if (depth > 4) return null
    if (typeof result === 'string') return result
    if (Array.isArray(result)) {
        const parts = result
            .map((block) => isObject(block) && typeof block.text === 'string' ? block.text : null)
            .filter((part): part is string => part !== null && part.length > 0)
        return parts.length > 0 ? parts.join('\n') : null
    }
    if (!isObject(result)) return null
    for (const key of ['content', 'text', 'output', 'error', 'message'] as const) {
        const value = result[key]
        if (typeof value === 'string') return value
    }
    for (const key of ['result', 'output', 'content'] as const) {
        if (isObject(result[key]) || Array.isArray(result[key])) {
            const nested = extractWorkflowResultText(result[key], depth + 1)
            if (nested !== null) return nested
        }
    }
    return null
}

const BACKGROUND_JOB_RE = /workflow\s+"([^"]*)"\s+started in the background as job\s+(workflow-[0-9a-fA-F]+)/i
const COMPLETED_RE = /workflow\s+"([^"]*)"\s+completed\s+\((\d+)\s+agents?\)/i
const RETURN_VALUE_RE = /return value\s*:/i
const FENCE_OPEN_RE = /^```[^\n]*\n/
const FENCE_CLOSE_RE = /\n```\s*$/

function extractReturnValue(text: string): string | null {
    const marker = RETURN_VALUE_RE.exec(text)
    if (!marker) return null
    let rest = text.slice(marker.index + marker[0].length).trim()
    if (!rest) return null
    if (FENCE_OPEN_RE.test(rest)) rest = rest.replace(FENCE_OPEN_RE, '')
    rest = rest.replace(FENCE_CLOSE_RE, '')
    rest = stripWorkflowTruncationMarkers(rest.trim()).script.trim()
    return rest || null
}

export function parseWorkflowResult(result: unknown): WorkflowOutcome | null {
    if (result === null || result === undefined) return null
    const text = extractWorkflowResultText(result)
    if (text === null || !text.trim()) return null
    const trimmed = text.trim()

    if (trimmed.startsWith('Error:')) {
        const message = trimmed.slice('Error:'.length).trim()
        return { kind: 'error', message: message || trimmed }
    }

    const background = BACKGROUND_JOB_RE.exec(trimmed)
    if (background) {
        return { kind: 'background', name: background[1] || null, jobId: background[2] }
    }

    const completed = COMPLETED_RE.exec(trimmed)
    if (completed) {
        return {
            kind: 'completed',
            name: completed[1] || null,
            agents: parseInt(completed[2], 10),
            returnValue: extractReturnValue(trimmed)
        }
    }

    return null
}

/** Map plan phases onto checklist statuses for the current tool state. */
export function workflowPhaseStatus(
    index: number,
    state: { running: boolean; outcome: WorkflowOutcome | null }
): ChecklistStatus {
    const outcome = state.outcome
    if (outcome?.kind === 'completed') return 'completed'
    // A background workflow only just queued its job; nothing has finished
    // locally, so every phase reads as queued while the job chip carries the
    // live status.
    if (state.running || outcome?.kind === 'background') {
        return index === 0 ? 'in_progress' : 'pending'
    }
    return 'pending'
}

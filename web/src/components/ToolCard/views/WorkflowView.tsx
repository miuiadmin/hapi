import { CodeBlock } from '@/components/CodeBlock'
import { checklistIcon, checklistTone, type ChecklistItem } from '@/components/ToolCard/checklist'
import {
    parseWorkflowInput,
    parseWorkflowResult,
    workflowPhaseStatus,
    type WorkflowOutcome,
    type WorkflowPlan
} from '@/components/ToolCard/workflowParse'
import type { ToolViewProps } from '@/components/ToolCard/views/_all'

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

function WorkflowHeader(props: { plan: WorkflowPlan | null; outcome: WorkflowOutcome | null }) {
    const outcomeName = props.outcome && props.outcome.kind !== 'error' ? props.outcome.name : null
    const name = props.plan?.name ?? outcomeName
    const description = props.plan?.description ?? null
    if (!name && !description) return null
    return (
        <div className="min-w-0 text-sm">
            {name ? (
                <div className="break-words font-mono text-[13px] font-medium text-[var(--app-fg)]" data-workflow-name>{name}</div>
            ) : null}
            {description ? (
                <div className="mt-0.5 break-words text-xs text-[var(--app-hint)]" data-workflow-description>{description}</div>
            ) : null}
        </div>
    )
}

function AgentChips(props: { labels: string[] }) {
    if (props.labels.length === 0) return null
    return (
        <div className="flex flex-wrap gap-1 pl-4" data-workflow-agents>
            {props.labels.map((label) => <Chip key={label}>{label}</Chip>)}
        </div>
    )
}

function PhaseChecklist(props: {
    plan: WorkflowPlan
    running: boolean
    outcome: WorkflowOutcome | null
    showDetail: boolean
}) {
    if (props.plan.phases.length === 0 && props.plan.strayAgents.length === 0) return null
    return (
        <div className="flex min-w-0 flex-col gap-1" data-workflow-phases>
            {props.plan.phases.map((phase, index) => {
                const item: ChecklistItem = {
                    id: `${index}:${phase.title}`,
                    text: phase.title,
                    status: workflowPhaseStatus(index, { running: props.running, outcome: props.outcome })
                }
                return (
                    <div key={item.id} className="flex min-w-0 flex-col gap-1">
                        <div className={`text-sm ${checklistTone(item)}`} data-workflow-phase={phase.title}>
                            {checklistIcon(item)} {phase.title}
                        </div>
                        {props.showDetail && phase.detail ? (
                            <div className="pl-5 break-words text-xs text-[var(--app-hint)]">{phase.detail}</div>
                        ) : null}
                        <AgentChips labels={phase.agents} />
                    </div>
                )
            })}
            <AgentChips labels={props.plan.strayAgents} />
        </div>
    )
}

/** Result summary: agent count, background job chip, or failure message. */
export function WorkflowOutcomeView(props: { outcome: WorkflowOutcome }) {
    const outcome = props.outcome
    if (outcome.kind === 'completed') {
        return (
            <div className="flex min-w-0 flex-col gap-2" data-workflow-result="completed">
                <span className="inline-flex w-fit items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    {outcome.agents} {outcome.agents === 1 ? 'agent' : 'agents'}
                </span>
                {outcome.returnValue ? <ReturnValueSection returnValue={outcome.returnValue} /> : null}
            </div>
        )
    }
    if (outcome.kind === 'background') {
        return (
            <div className="flex min-w-0 flex-col gap-2" data-workflow-result="background">
                <Chip title={outcome.jobId}>{outcome.jobId}</Chip>
            </div>
        )
    }
    return (
        <div className="whitespace-pre-wrap break-words text-sm text-red-600" data-workflow-result="error">
            {outcome.message}
        </div>
    )
}

function ReturnValueSection(props: { returnValue: string }) {
    return (
        <details className="min-w-0 text-xs text-[var(--app-hint)]" data-workflow-return-value>
            <summary className="cursor-pointer py-1">Return value</summary>
            <CodeBlock code={props.returnValue} language="json" />
        </details>
    )
}

function ScriptSection(props: { script: string }) {
    return (
        <details className="min-w-0 text-xs text-[var(--app-hint)]" data-workflow-script>
            <summary className="cursor-pointer py-1">Script</summary>
            <CodeBlock code={props.script} language="javascript" />
        </details>
    )
}

export function WorkflowView({ block, surface }: ToolViewProps) {
    const plan = parseWorkflowInput(block.tool.input)
    const outcome = block.tool.result !== null && block.tool.result !== undefined
        ? parseWorkflowResult(block.tool.result)
        : null

    if (!plan && !outcome) return null
    const running = block.tool.state === 'running' || block.tool.state === 'pending'
    const dialog = surface === 'dialog'

    return (
        <div className="flex min-w-0 flex-col gap-2" data-workflow-view>
            <WorkflowHeader plan={plan} outcome={outcome} />
            {plan ? (
                <PhaseChecklist plan={plan} running={running} outcome={outcome} showDetail={dialog} />
            ) : null}
            {/* The dialog's Result section renders the outcome below; only the
                inline card folds it in here. */}
            {outcome && !dialog ? <WorkflowOutcomeView outcome={outcome} /> : null}
            {plan?.truncated ? (
                <div className="text-xs text-[var(--app-hint)]">(script truncated)</div>
            ) : null}
            {dialog && typeof block.tool.input === 'object' && block.tool.input !== null
                && 'script' in block.tool.input && typeof (block.tool.input as { script?: unknown }).script === 'string'
                ? <ScriptSection script={(block.tool.input as { script: string }).script} />
                : null}
        </div>
    )
}

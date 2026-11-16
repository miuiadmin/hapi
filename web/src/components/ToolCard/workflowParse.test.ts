import { describe, expect, it } from 'vitest'
import {
    parseWorkflowInput,
    parseWorkflowResult,
    stripWorkflowTruncationMarkers,
    workflowPhaseStatus
} from '@/components/ToolCard/workflowParse'

describe('stripWorkflowTruncationMarkers', () => {
    it('strips hapi truncation markers anywhere in the payload', () => {
        const script = "phase('A')\nconst x = 1 [hapi: truncated 4096 chars]"
        expect(stripWorkflowTruncationMarkers(script)).toEqual({
            script: "phase('A')\nconst x = 1 ",
            truncated: true
        })
    })

    it('leaves intact scripts untouched', () => {
        const script = "phase('A') // [note: not a marker]"
        expect(stripWorkflowTruncationMarkers(script)).toEqual({ script, truncated: false })
    })
})

describe('parseWorkflowInput phases', () => {
    it('reads structured phases from input.meta.phases with titles and details', () => {
        const plan = parseWorkflowInput({
            meta: {
                name: 'repo-audit',
                description: 'Audit every file',
                phases: [
                    { title: 'Scan', detail: 'find matching files' },
                    { title: 'Verify', detail: null }
                ]
            },
            script: 'phase("unused")'
        })
        expect(plan?.name).toBe('repo-audit')
        expect(plan?.description).toBe('Audit every file')
        expect(plan?.phases.map((phase) => phase.title)).toEqual(['Scan', 'Verify'])
        expect(plan?.phases[0].detail).toBe('find matching files')
        expect(plan?.phases[1].detail).toBeNull()
        // Structured meta wins; script phase() calls do not duplicate it.
        expect(plan?.phases).toHaveLength(2)
    })

    it('falls back to phase(...) call order in the script when meta has no phases', () => {
        const plan = parseWorkflowInput({
            script: [
                "phase('Discover')",
                "log('working')",
                "phase('Fix')",
                "phase('Discover') // duplicate call"
            ].join('\n')
        })
        expect(plan?.phases.map((phase) => phase.title)).toEqual(['Discover', 'Fix'])
    })

    it('keeps the checklist empty when neither source yields phases', () => {
        const plan = parseWorkflowInput({ meta: { name: 'empty' }, script: 'return 1' })
        expect(plan?.phases).toEqual([])
        expect(plan?.strayAgents).toEqual([])
    })

    it('marks run_in_background and truncation markers', () => {
        const plan = parseWorkflowInput({
            run_in_background: true,
            script: "phase('A') [hapi: truncated 9999 chars]"
        })
        expect(plan?.background).toBe(true)
        expect(plan?.truncated).toBe(true)
        expect(plan?.phases.map((phase) => phase.title)).toEqual(['A'])
    })

    it('returns null for non-workflow input', () => {
        expect(parseWorkflowInput(null)).toBeNull()
        expect(parseWorkflowInput('workflow')).toBeNull()
        expect(parseWorkflowInput({ command: 'ls' })).toBeNull()
    })
})

describe('parseWorkflowInput agent labels', () => {
    const script = [
        "phase('audit')",
        "const r1 = agent('look at a', { label: 'reader', phase: 'audit' })",
        "const r2 = agent('look at b', { phase: 'audit', label: 'checker' })",
        "const s = parallel([() => agent('x', { label: 'stray' })])",
        "pipeline(files, () => agent('y', { label: 'fixer', phase: 'repair' }))"
    ].join('\n')

    it('groups labels under their phase sibling (double and single quotes)', () => {
        const plan = parseWorkflowInput({ script })
        const audit = plan?.phases.find((phase) => phase.title === 'audit')
        expect(audit?.agents).toEqual(['reader', 'checker'])
    })

    it('keeps phase-less labels as stray agents', () => {
        const plan = parseWorkflowInput({ script })
        expect(plan?.strayAgents).toEqual(['stray'])
    })

    it('appends undeclared phases named by label siblings', () => {
        const plan = parseWorkflowInput({ script })
        const repair = plan?.phases.find((phase) => phase.title === 'repair')
        expect(repair?.agents).toEqual(['fixer'])
    })

    it('ignores labels longer than 60 chars and unescapes quotes', () => {
        const longLabel = 'x'.repeat(61)
        const plan = parseWorkflowInput({
            script: `agent('p', { label: '${longLabel}' })\nagent('q', { label: 'it\\'s fine' })`
        })
        expect(plan?.strayAgents).toEqual(["it's fine"])
    })

    it('picks the nearest phase sibling when agent calls sit close together', () => {
        const plan = parseWorkflowInput({
            script: [
                "agent('p1', { label: 'first', phase: 'one' }); agent('p2', { label: 'second', phase: 'two' })"
            ].join('\n')
        })
        expect(plan?.phases.find((phase) => phase.title === 'one')?.agents).toEqual(['first'])
        expect(plan?.phases.find((phase) => phase.title === 'two')?.agents).toEqual(['second'])
    })
})

describe('parseWorkflowResult', () => {
    it('parses a completed blocking run with a fenced return-value block', () => {
        const result = [
            'workflow "repo-audit" completed (5 agents)',
            '',
            'Return value:',
            '```json',
            '{"files": 12, "findings": ["a", "b"]}',
            '```'
        ].join('\n')
        expect(parseWorkflowResult(result)).toEqual({
            kind: 'completed',
            name: 'repo-audit',
            agents: 5,
            returnValue: '{"files": 12, "findings": ["a", "b"]}'
        })
    })

    it('parses a completed run with a bare JSON return value', () => {
        const result = 'workflow "x" completed (1 agent)\nReturn value:\n{"ok":true}'
        expect(parseWorkflowResult(result)).toEqual({
            kind: 'completed',
            name: 'x',
            agents: 1,
            returnValue: '{"ok":true}'
        })
    })

    it('keeps a truncated return value readable and marker-free', () => {
        const result = 'workflow "x" completed (2 agents)\nReturn value:\n```json\n{"half": " [hapi: truncated 512 chars]'
        const outcome = parseWorkflowResult(result)
        expect(outcome?.kind).toBe('completed')
        if (outcome?.kind === 'completed') {
            expect(outcome.returnValue).not.toMatch(/hapi: truncated/)
            expect(outcome.returnValue).toContain('"half"')
        }
    })

    it('treats an Error: prefix as failure with the remaining text', () => {
        expect(parseWorkflowResult('Error: Misused hooks end the whole script')).toEqual({
            kind: 'error',
            message: 'Misused hooks end the whole script'
        })
    })

    it('extracts the background job id from instant background results', () => {
        const result = 'workflow "repo-audit" started in the background as job workflow-0f1e2d3c4b5a'
        expect(parseWorkflowResult(result)).toEqual({
            kind: 'background',
            name: 'repo-audit',
            jobId: 'workflow-0f1e2d3c4b5a'
        })
    })

    it('unwraps documented result containers (arrays and text objects)', () => {
        expect(parseWorkflowResult([{ type: 'text', text: 'Error: boom' }])).toEqual({
            kind: 'error',
            message: 'boom'
        })
        expect(parseWorkflowResult({ content: 'workflow "n" completed (3 agents)' })).toEqual({
            kind: 'completed',
            name: 'n',
            agents: 3,
            returnValue: null
        })
    })

    it('returns null for absent or unrecognized results', () => {
        expect(parseWorkflowResult(null)).toBeNull()
        expect(parseWorkflowResult(undefined)).toBeNull()
        expect(parseWorkflowResult('some unrelated tool output')).toBeNull()
    })
})

describe('workflowPhaseStatus', () => {
    it('marks the first phase in_progress and the rest queued while running', () => {
        expect(workflowPhaseStatus(0, { running: true, outcome: null })).toBe('in_progress')
        expect(workflowPhaseStatus(1, { running: true, outcome: null })).toBe('pending')
    })

    it('marks every phase completed once the workflow completes', () => {
        const outcome = { kind: 'completed' as const, name: null, agents: 4, returnValue: null }
        expect(workflowPhaseStatus(0, { running: false, outcome })).toBe('completed')
        expect(workflowPhaseStatus(2, { running: false, outcome })).toBe('completed')
    })

    it('keeps the first phase live for a background job start', () => {
        const outcome = { kind: 'background' as const, name: null, jobId: 'workflow-abc' }
        expect(workflowPhaseStatus(0, { running: false, outcome })).toBe('in_progress')
        expect(workflowPhaseStatus(1, { running: false, outcome })).toBe('pending')
    })

    it('queues everything again after a failure', () => {
        const outcome = { kind: 'error' as const, message: 'bad script' }
        expect(workflowPhaseStatus(0, { running: false, outcome })).toBe('pending')
    })
})

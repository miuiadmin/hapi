import { useEffect, useId, useMemo, useState } from 'react'
import {
    BOT_AGENT_FLAVORS,
    BOT_NAME_MAX_LENGTH,
    BOT_PURPOSE_MAX_LENGTH,
    getFlavorLabel,
    getPermissionModeLabel,
    getPermissionModesForFlavor,
    type AgentAvailabilityEntry,
    type AgentFlavor,
    type BotSummary
} from '@hapi/protocol'
import type { Machine } from '@/types/api'
import { apiErrorMessage, type ApiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SelectControl } from '@/components/ui/select-control'
import { useAgentAvailability } from '@/hooks/queries/useAgentAvailability'
import { useMachines } from '@/hooks/queries/useMachines'
import { useBotMutations } from '@/hooks/queries/useBots'
import {
    buildCreateBotRequest,
    previewBotHomeDir,
    EMPTY_CREATE_BOT_DRAFT,
    type CreateBotDraft,
    type CreateBotDraftError
} from '@/lib/bots'
import { useTranslation } from '@/lib/use-translation'

const FIELD_CLASS = 'w-full min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50'
const LABEL_CLASS = 'mb-1 block text-xs font-medium text-[var(--app-hint)]'
const SELECT_CLASS = 'w-full min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-3 pr-10 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50'
const WARNING_CLASS = 'mt-1 text-xs text-[var(--app-warning-text)]'

const ERROR_KEY: Record<CreateBotDraftError | 'agent' | 'failed', string> = {
    nameRequired: 'bots.create.error.nameRequired',
    nameTooLong: 'bots.create.error.nameTooLong',
    nameChars: 'bots.create.error.nameChars',
    nameSlug: 'bots.create.error.nameSlug',
    purposeTooLong: 'bots.create.error.purposeTooLong',
    machine: 'bots.create.error.machine',
    homeDir: 'bots.create.error.homeDir',
    agent: 'bots.create.error.agent',
    failed: 'bots.create.failed'
}

/** Same preference order as the session-list chips: display name → host → short id. */
export function botMachineLabel(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

export function botMachineOptionLabel(machine: Machine): string {
    const platform = machine.metadata?.platform ? ` (${machine.metadata.platform})` : ''
    return `${botMachineLabel(machine)}${platform}`
}

/**
 * The agents a bot's home chat can run on today (`BOT_AGENT_FLAVORS`,
 * in that order) that this machine can also launch. Others have not been
 * run end to end as a bot and the hub rejects them.
 */
export function availableBotAgents(entries: readonly AgentAvailabilityEntry[]): AgentAvailabilityEntry[] {
    const byAgent = new Map(entries.map((entry) => [entry.agent, entry]))
    return (BOT_AGENT_FLAVORS as readonly AgentFlavor[])
        .map((flavor) => byAgent.get(flavor) ?? { agent: flavor, available: false, reason: 'not_found' as const })
        .filter((entry) => entry.available)
}

/** What the agent check came to; drives which message and controls show. */
export type BotAgentState = 'waiting' | 'loading' | 'upgrade' | 'failed' | 'none' | 'ready'

/**
 * The "New bot" form: name, what it is for, the machine it lives on, its
 * agent, an optional permission mode (left to the hub unless chosen) and,
 * under Advanced, its home folder. The request is built locally so a
 * mistake shows inline; the hub's own error is shown verbatim when it
 * refuses one.
 */
export function CreateBotDialog({ isOpen, onClose, api, onCreated }: {
    isOpen: boolean
    onClose: () => void
    api: ApiClient | null
    /** Called with the created bot; the hub has already started its home chat. */
    onCreated: (bot: BotSummary) => void
}) {
    const { t } = useTranslation()
    const idPrefix = useId()
    const { machines, isLoading: machinesLoading } = useMachines(api, isOpen)
    const { createBot } = useBotMutations(api)
    const [draft, setDraft] = useState<CreateBotDraft>(EMPTY_CREATE_BOT_DRAFT)
    const [showAdvanced, setShowAdvanced] = useState(false)
    const [error, setError] = useState<{ key: CreateBotDraftError | 'agent' | 'failed' } | { text: string } | null>(null)
    const [busy, setBusy] = useState(false)

    const machinesById = useMemo(() => new Map(machines.map((machine) => [machine.id, machine])), [machines])
    const onlineMachines = useMemo(() => machines.filter((machine) => machine.active), [machines])
    const machinesSettled = Boolean(api) && !machinesLoading
    // The chosen machine stays chosen when it drops offline: the owner is told, not silently moved (the agent and mode would go with it).
    const selectedMachine = draft.machineId ? machinesById.get(draft.machineId) ?? null : null
    const machineUnavailable = Boolean(draft.machineId)
        && machinesSettled
        && (!selectedMachine || !selectedMachine.active)
    const agentAvailability = useAgentAvailability({ api, machineId: draft.machineId, enabled: isOpen && !machineUnavailable })
    const agents = useMemo(() => availableBotAgents(agentAvailability.agents), [agentAvailability.agents])
    const permissionModes = draft.agent ? getPermissionModesForFlavor(draft.agent) : []

    useEffect(() => {
        if (!isOpen) return
        setDraft(EMPTY_CREATE_BOT_DRAFT)
        setShowAdvanced(false)
        setError(null)
        setBusy(false)
    }, [isOpen])

    // Pick the first online machine until the owner chooses one (or their choice leaves the list); a new machine means a new agent, so a mode choice does not carry over.
    useEffect(() => {
        if (!isOpen || onlineMachines.length === 0) return
        if (draft.machineId && (!machinesSettled || selectedMachine)) return
        update({ machineId: onlineMachines[0].id, agent: null, permissionMode: null })
    }, [isOpen, onlineMachines, draft.machineId, machinesSettled, selectedMachine])

    // The machine's agent list decides the agent until the owner picks one:
    // the first supported agent (Claude today). The permission mode stays
    // on the hub default unless the owner picks one.
    useEffect(() => {
        if (!isOpen || !draft.machineId || agentAvailability.isLoading || agentAvailability.error) return
        if (agents.length === 0) return
        if (draft.agent && agents.some((entry) => entry.agent === draft.agent)) return
        update({ agent: agents[0].agent, permissionMode: null })
    }, [isOpen, draft.machineId, draft.agent, agentAvailability.isLoading, agentAvailability.error, agents])

    function update(patch: Partial<CreateBotDraft>) {
        setError(null)
        setDraft((current) => ({ ...current, ...patch }))
    }

    const handleClose = () => {
        if (busy) return
        onClose()
    }

    const homePreview = previewBotHomeDir(draft.name)
    const agentState: BotAgentState = !draft.machineId || machineUnavailable
        ? 'waiting'
        : agentAvailability.isLoading
            ? 'loading'
            : agentAvailability.error
                ? (agentAvailability.upgradeRequired ? 'upgrade' : 'failed')
                : agents.length === 0 ? 'none' : 'ready'
    // An agent already chosen stays on screen while its machine is offline (the owner is deciding, not the form).
    const agentChosen = agentState === 'ready' || (agentState === 'waiting' && Boolean(draft.agent))
    const noMachine = machinesSettled && !draft.machineId && onlineMachines.length === 0

    const submit = async () => {
        const built = buildCreateBotRequest(draft)
        if ('error' in built) {
            setError({ key: built.error })
            return
        }
        if (agentState !== 'ready') {
            setError({ key: 'agent' })
            return
        }
        setBusy(true)
        setError(null)
        try {
            const bot = await createBot.mutateAsync(built.request)
            setBusy(false)
            onCreated(bot)
        } catch (cause) {
            setBusy(false)
            setError({ text: apiErrorMessage(cause, t('bots.create.failed')) })
        }
    }

    const submitDisabled = busy || machinesLoading || !draft.machineId || machineUnavailable || agentState !== 'ready'

    const errorText = error === null
        ? null
        : 'text' in error
            ? error.text
            : t(ERROR_KEY[error.key], error.key === 'nameTooLong' ? { count: BOT_NAME_MAX_LENGTH }
                : error.key === 'purposeTooLong' ? { count: BOT_PURPOSE_MAX_LENGTH } : undefined)

    const machineOptions = machineUnavailable && selectedMachine ? [...onlineMachines, selectedMachine] : onlineMachines

    return (
        <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose() }}>
            <DialogContent className="max-h-[calc(100dvh-24px)] max-w-lg overflow-y-auto" data-testid="create-bot-dialog">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">{t('bots.create.title')}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    aria-label={t('bots.create.title')}
                    onSubmit={(event) => {
                        event.preventDefault()
                        void submit()
                    }}
                >
                    <div>
                        <label className={LABEL_CLASS} htmlFor={`${idPrefix}-name`}>{t('bots.create.name')}</label>
                        <input
                            id={`${idPrefix}-name`}
                            type="text"
                            value={draft.name}
                            placeholder={t('bots.create.namePlaceholder')}
                            maxLength={BOT_NAME_MAX_LENGTH + 10}
                            autoComplete="off"
                            disabled={busy}
                            onChange={(event) => update({ name: event.target.value })}
                            className={FIELD_CLASS}
                        />
                    </div>
                    <div>
                        <label className={LABEL_CLASS} htmlFor={`${idPrefix}-purpose`}>{t('bots.create.purpose')}</label>
                        <textarea
                            id={`${idPrefix}-purpose`}
                            rows={3}
                            value={draft.purpose}
                            placeholder={t('bots.create.purposePlaceholder')}
                            maxLength={BOT_PURPOSE_MAX_LENGTH + 10}
                            disabled={busy}
                            onChange={(event) => update({ purpose: event.target.value })}
                            className={`${FIELD_CLASS} resize-y`}
                        />
                    </div>
                    <div>
                        <label className={LABEL_CLASS} htmlFor={`${idPrefix}-machine`}>{t('bots.create.machine')}</label>
                        <SelectControl
                            id={`${idPrefix}-machine`}
                            value={draft.machineId ?? ''}
                            disabled={busy || machinesLoading || machineOptions.length === 0}
                            onChange={(event) => update({ machineId: event.target.value || null, agent: null, permissionMode: null })}
                            className={SELECT_CLASS}
                        >
                            {machinesLoading ? <option value="">{t('loading.machines')}</option> : null}
                            {!machinesLoading && machineOptions.length === 0 ? <option value="">{t('misc.noMachines')}</option> : null}
                            {machineOptions.map((machine) => (
                                <option key={machine.id} value={machine.id}>
                                    {machine.active ? botMachineOptionLabel(machine) : t('bots.create.machineOptionOffline', { name: botMachineOptionLabel(machine) })}
                                </option>
                            ))}
                        </SelectControl>
                        {machineUnavailable ? (
                            <p role="alert" className={WARNING_CLASS} data-testid="create-bot-machine-offline">{t('bots.create.machineOffline')}</p>
                        ) : null}
                        {noMachine ? (
                            <p role="alert" className={WARNING_CLASS}>{t('bots.create.noMachine')}</p>
                        ) : null}
                    </div>
                    <div>
                        {agentChosen && agents.length === 1 ? (
                            // One supported agent: a line, not a one-option dropdown. The request still names it.
                            <div className="flex flex-col gap-1.5" data-testid="create-bot-agent-fixed">
                                <span className="text-xs font-medium text-[var(--app-hint)]">{t('bots.create.agent')}</span>
                                <span className="text-sm text-[var(--app-fg)]">
                                    {t('bots.create.agentFixed', { name: getFlavorLabel(agents[0].agent) })}
                                </span>
                            </div>
                        ) : agentChosen ? (
                            <div>
                                <label className={LABEL_CLASS} htmlFor={`${idPrefix}-agent`}>{t('bots.create.agent')}</label>
                                <SelectControl
                                    id={`${idPrefix}-agent`}
                                    value={draft.agent ?? ''}
                                    disabled={busy}
                                    onChange={(event) => update({ agent: event.target.value, permissionMode: null })}
                                    className={SELECT_CLASS}
                                >
                                    {agents.map((entry) => (
                                        <option key={entry.agent} value={entry.agent}>{getFlavorLabel(entry.agent)}</option>
                                    ))}
                                </SelectControl>
                            </div>
                        ) : agentState === 'waiting' ? null : (
                            <div>
                                <span className={LABEL_CLASS}>{t('bots.create.agent')}</span>
                                {agentState === 'loading' ? (
                                    <p className="text-xs text-[var(--app-hint)]">{t('bots.create.agentLoading')}</p>
                                ) : agentState === 'upgrade' ? (
                                    <p role="alert" className="text-xs text-red-600">{t('newSession.runnerUpgradeRequired')}</p>
                                ) : agentState === 'failed' ? (
                                    <p role="alert" className="flex items-center justify-between gap-3 text-xs text-red-600">
                                        <span className="min-w-0">{t('newSession.agentAvailabilityFailed')}</span>
                                        <button type="button" className="shrink-0 underline" onClick={agentAvailability.refetch}>
                                            {t('button.retry')}
                                        </button>
                                    </p>
                                ) : (
                                    <p role="alert" className="text-xs text-red-600">
                                        {t('bots.create.agentUnavailable', { agents: BOT_AGENT_FLAVORS.map((flavor) => getFlavorLabel(flavor)).join(', ') })}
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                    {permissionModes.length > 0 ? (
                        <div>
                            <label className={LABEL_CLASS} htmlFor={`${idPrefix}-permission`}>{t('bots.create.permission')}</label>
                            <SelectControl
                                id={`${idPrefix}-permission`}
                                value={draft.permissionMode ?? ''}
                                disabled={busy}
                                onChange={(event) => update({ permissionMode: event.target.value || null })}
                                className={SELECT_CLASS}
                            >
                                <option value="">{t('bots.create.permissionHubDefault')}</option>
                                {permissionModes.map((mode) => (
                                    <option key={mode} value={mode}>{getPermissionModeLabel(mode)}</option>
                                ))}
                            </SelectControl>
                            <p className="mt-1 text-xs text-[var(--app-hint)]">{t('bots.create.permissionDesc')}</p>
                        </div>
                    ) : null}
                    <div>
                        <button
                            type="button"
                            aria-expanded={showAdvanced}
                            disabled={busy}
                            onClick={() => setShowAdvanced((value) => !value)}
                            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]"
                        >
                            <svg viewBox="0 0 16 16" fill="none" className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} aria-hidden="true">
                                <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            {t('bots.create.advanced')}
                        </button>
                        {showAdvanced ? (
                            <div className="mt-2">
                                <label className={LABEL_CLASS} htmlFor={`${idPrefix}-home`}>{t('bots.create.homeDir')}</label>
                                <input
                                    id={`${idPrefix}-home`}
                                    type="text"
                                    value={draft.homeDir}
                                    placeholder={homePreview ?? ''}
                                    autoComplete="off"
                                    spellCheck={false}
                                    disabled={busy}
                                    onChange={(event) => update({ homeDir: event.target.value })}
                                    className={`${FIELD_CLASS} font-mono text-xs`}
                                />
                                <p className="mt-1 break-all text-xs text-[var(--app-hint)]">
                                    {homePreview
                                        ? t('bots.create.homeDirHint', { path: homePreview })
                                        : draft.name.trim()
                                            ? t('bots.create.homeDirNoSlug')
                                            : t('bots.create.homeDirPending')}
                                </p>
                            </div>
                        ) : null}
                    </div>
                    {errorText ? <p role="alert" className="text-xs text-red-500">{errorText}</p> : null}
                    <Button type="submit" className="w-full" disabled={submitDisabled}>
                        {busy ? t('bots.create.creating') : t('bots.create.submit')}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    )
}

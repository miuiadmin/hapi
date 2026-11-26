import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import type { CodexCollaborationMode, CopilotAgentMode, PermissionMode, SessionResponse, SessionsResponse } from '@/types/api'
import type { ReopenSessionResponse } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow } from '@/lib/message-window-store'
import { isAttachedJobDeleteConflict } from '@/lib/deleteSessionError'
import { isKnownFlavor } from '@hapi/protocol'

export const sessionModelMutationKey = (sessionId: string) => ['session-model', sessionId] as const
export const sessionArchiveMutationKey = (sessionId: string | null) => ['session-archive', sessionId] as const
export const sessionPinMutationKey = (sessionId: string | null) => ['session-pin', sessionId] as const

export type DeleteSessionOptions = {
    /**
     * Clear every `running` attached job before deleting. The hub refuses the
     * delete with 409 while a running job outlives the session, so the caller
     * only sets this once its copy has told the operator about the job.
     */
    clearAttachedJobs?: boolean
}

/**
 * `deleteSession` is also wired straight through as a dialog's `onConfirm`,
 * which may hand it a React event or some other object. Only a plain object
 * carrying a boolean `clearAttachedJobs` counts as options; everything else
 * means "just delete".
 */
export function parseDeleteSessionOptions(input: unknown): DeleteSessionOptions {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
    const { clearAttachedJobs } = input as { clearAttachedJobs?: unknown }
    return typeof clearAttachedJobs === 'boolean' ? { clearAttachedJobs } : {}
}

/**
 * List the session's attached jobs and delete the `running` ones (tiann/hapi
 * #1404). Terminal jobs are left alone — the hub only blocks on running ones.
 * A job that vanished between list and delete (404) already reached the goal
 * state; any other failure aborts before the session delete is attempted.
 */
export async function clearRunningAttachedJobs(api: ApiClient, sessionId: string): Promise<void> {
    const { jobs } = await api.listSessionJobs(sessionId)
    for (const job of jobs) {
        if (job.status !== 'running') continue
        try {
            await api.deleteSessionJob(sessionId, job.key)
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) continue
            throw error
        }
    }
}

export function useSessionActions(
    api: ApiClient | null,
    sessionId: string | null,
    agentFlavor?: string | null,
    codexCollaborationModeSupported?: boolean
): {
    abortSession: () => Promise<void>
    isAborting: boolean
    archiveSession: () => Promise<void>
    reopenSession: () => Promise<ReopenSessionResponse>
    switchSession: () => Promise<void>
    setPermissionMode: (mode: PermissionMode) => Promise<void>
    setCollaborationMode: (mode: CodexCollaborationMode) => Promise<void>
    setCopilotAgentMode: (mode: CopilotAgentMode) => Promise<void>
    setModel: (model: { provider: string; modelId: string } | string | null, options?: { effort: string | null }) => Promise<void>
    setModelReasoningEffort: (modelReasoningEffort: string | null) => Promise<void>
    setEffort: (effort: string | null) => Promise<void>
    setServiceTier: (serviceTier: string | null) => Promise<void>
    renameSession: (name: string | null | undefined, titleLocked?: boolean) => Promise<void>
    setExternalRefs: (refs: import('@/types/api').ExternalRef[]) => Promise<void>
    upsertExternalRef: (ref: import('@/types/api').ExternalRef) => Promise<void>
    removePrimaryExternalRef: () => Promise<void>
    suggestSessionTitle: () => Promise<string>
    updateSessionSummary: (text: string, titleLocked?: boolean) => Promise<void>
    setPinMode: (mode: 'none' | 'project' | 'global') => Promise<void>
    deleteSession: (options?: DeleteSessionOptions) => Promise<void>
    isPending: boolean
} {
    const queryClient = useQueryClient()

    const markSessionActiveInCache = (targetSessionId: string) => {
        // 中文注释：恢复/重开接口成功后，session-alive SSE 可能已经先到或稍后才到。
        // 这里先乐观更新详情和侧边栏摘要，避免 UI 在下一次 SSE/REST 前仍显示离线。
        queryClient.setQueryData<SessionResponse | undefined>(queryKeys.session(targetSessionId), (previous) => {
            if (!previous?.session) return previous
            return {
                ...previous,
                session: {
                    ...previous.session,
                    active: true,
                    activeAt: Math.max(previous.session.activeAt ?? 0, Date.now())
                }
            }
        })
        queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
            if (!previous) return previous
            let changed = false
            const sessions = previous.sessions.map((summary) => {
                if (summary.id !== targetSessionId) return summary
                changed = true
                return {
                    ...summary,
                    active: true,
                    activeAt: Math.max(summary.activeAt ?? 0, Date.now())
                }
            })
            return changed ? { ...previous, sessions } : previous
        })
    }

    const invalidateSession = async () => {
        if (!sessionId) return
        await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const invalidateCursorModels = async () => {
        if (!sessionId || agentFlavor !== 'cursor') return
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessionCursorModels(sessionId) })
        await queryClient.invalidateQueries({ queryKey: ['machine-cursor-models'] })
    }

    const abortMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.abortSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const archiveMutation = useMutation({
        mutationKey: sessionArchiveMutationKey(sessionId),
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.archiveSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const reopenMutation = useMutation<ReopenSessionResponse, Error, void>({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.reopenSession(sessionId)
        },
        onSuccess: (result) => {
            void (async () => {
                // When reopen merges into a different id, the source detail may
                // already be gone. Invalidating it while still on the source
                // route races with draft handoff and flashes "Session unavailable".
                if (result.sessionId === sessionId) {
                    await invalidateSession()
                } else {
                    await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                }
                markSessionActiveInCache(result.sessionId)
            })()
        },
    })

    const switchMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.switchSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const permissionMutation = useMutation({
        mutationFn: async (mode: PermissionMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (isKnownFlavor(agentFlavor) && !isPermissionModeAllowedForFlavor(mode, agentFlavor)) {
                throw new Error('Invalid permission mode for session flavor')
            }
            await api.setPermissionMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const collaborationMutation = useMutation({
        mutationFn: async (mode: CodexCollaborationMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (agentFlavor !== 'codex') {
                throw new Error('Collaboration mode is only supported for Codex sessions')
            }
            if (!codexCollaborationModeSupported) {
                throw new Error('Collaboration mode is only supported for remote Codex sessions')
            }
            await api.setCollaborationMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const copilotAgentModeMutation = useMutation({
        mutationFn: async (mode: CopilotAgentMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (agentFlavor !== 'copilot') {
                throw new Error('Agent mode is only supported for Copilot sessions')
            }
            await api.setCopilotAgentMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const modelMutation = useMutation({
        mutationKey: sessionModelMutationKey(sessionId ?? ''),
        mutationFn: async (args: {
            model: { provider: string; modelId: string } | string | null
            options?: { effort: string | null }
        }) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setModel(sessionId, args.model, args.options)
        },
        onSuccess: async () => {
            await invalidateSession()
            await invalidateCursorModels()
        },
    })

    const setModel = useCallback(
        (model: { provider: string; modelId: string } | string | null, options?: { effort: string | null }) =>
            modelMutation.mutateAsync({ model, options }),
        [modelMutation.mutateAsync]
    )

    const modelReasoningEffortMutation = useMutation({
        mutationFn: async (modelReasoningEffort: string | null) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            // dsh and hermes ride the same rail: their `reasoning_effort`
            // config option (thought_level) is applied through the shared
            // set-config mutation.
            if (agentFlavor !== 'codex' && agentFlavor !== 'opencode' && agentFlavor !== 'dsh' && agentFlavor !== 'hermes') {
                throw new Error('Model reasoning effort is only supported for Codex, OpenCode, DSH, and Hermes sessions')
            }
            if (agentFlavor === 'codex' && !codexCollaborationModeSupported) {
                throw new Error('Model reasoning effort is only supported for remote sessions')
            }
            await api.setModelReasoningEffort(sessionId, modelReasoningEffort)
        },
        onSuccess: () => void invalidateSession(),
    })

    const effortMutation = useMutation({
        mutationFn: async (effort: string | null) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setEffort(sessionId, effort)
        },
        onSuccess: () => void invalidateSession(),
    })

    const serviceTierMutation = useMutation({
        mutationFn: async (serviceTier: string | null) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (agentFlavor !== 'codex') {
                throw new Error('Fast mode is only supported for Codex sessions')
            }
            if (!codexCollaborationModeSupported) {
                throw new Error('Fast mode is only supported for remote sessions')
            }
            await api.setServiceTier(sessionId, serviceTier)
        },
        onSuccess: () => void invalidateSession(),
    })

    const renameMutation = useMutation({
        mutationFn: async ({ name, titleLocked }: { name: string | null | undefined; titleLocked?: boolean }) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.renameSession(sessionId, name, titleLocked)
        },
        onSuccess: () => void invalidateSession(),
    })

    const externalRefsMutation = useMutation({
        mutationFn: async (refs: import('@/types/api').ExternalRef[]) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setSessionExternalRefs(sessionId, refs)
        },
        onSuccess: () => void invalidateSession(),
    })

    const upsertExternalRefMutation = useMutation({
        mutationFn: async (ref: import('@/types/api').ExternalRef) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.upsertSessionExternalRef(sessionId, ref)
        },
        onSuccess: () => void invalidateSession(),
    })

    const removePrimaryExternalRefMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.removePrimarySessionExternalRef(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const titleSuggestionMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const response = await api.suggestSessionTitle(sessionId)
            return response.title
        }
    })

    const summaryMutation = useMutation({
        mutationFn: async ({ text, titleLocked }: { text: string; titleLocked?: boolean }) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.updateSessionSummary(sessionId, text, titleLocked)
        },
        onSuccess: () => void invalidateSession(),
    })

    const pinMutation = useMutation({
        mutationKey: sessionPinMutationKey(sessionId),
        mutationFn: async (mode: 'none' | 'project' | 'global') => {
            if (!api || !sessionId) throw new Error('Session unavailable')
            await api.setSessionPinMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const deleteMutation = useMutation<void, Error, DeleteSessionOptions>({
        mutationFn: async (options) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (options.clearAttachedJobs) {
                await clearRunningAttachedJobs(api, sessionId)
            }
            await api.deleteSession(sessionId)
        },
        onSuccess: async () => {
            if (!sessionId) return
            queryClient.removeQueries({ queryKey: queryKeys.session(sessionId) })
            clearMessageWindow(sessionId)
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
        onError: (error) => {
            // The hub still saw a running attached job, so the summary this
            // delete was confirmed against did not show it. Refresh the list
            // so the dialog copy names the job before the operator retries.
            if (isAttachedJobDeleteConflict(error)) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            }
        },
    })

    return {
        abortSession: abortMutation.mutateAsync,
        isAborting: abortMutation.isPending,
        archiveSession: archiveMutation.mutateAsync,
        reopenSession: reopenMutation.mutateAsync,
        switchSession: switchMutation.mutateAsync,
        setPermissionMode: permissionMutation.mutateAsync,
        setCollaborationMode: collaborationMutation.mutateAsync,
        setCopilotAgentMode: copilotAgentModeMutation.mutateAsync,
        setModel,
        setModelReasoningEffort: modelReasoningEffortMutation.mutateAsync,
        setEffort: effortMutation.mutateAsync,
        setServiceTier: serviceTierMutation.mutateAsync,
        renameSession: (name: string | null | undefined, titleLocked?: boolean) => renameMutation.mutateAsync({ name, titleLocked }),
        setExternalRefs: externalRefsMutation.mutateAsync,
        upsertExternalRef: upsertExternalRefMutation.mutateAsync,
        removePrimaryExternalRef: removePrimaryExternalRefMutation.mutateAsync,
        suggestSessionTitle: titleSuggestionMutation.mutateAsync,
        updateSessionSummary: (text: string, titleLocked?: boolean) => summaryMutation.mutateAsync({ text, titleLocked }),
        setPinMode: pinMutation.mutateAsync,
        deleteSession: (options?: DeleteSessionOptions) => deleteMutation.mutateAsync(parseDeleteSessionOptions(options)),
        isPending: abortMutation.isPending
            || archiveMutation.isPending
            || reopenMutation.isPending
            || switchMutation.isPending
            || permissionMutation.isPending
            || collaborationMutation.isPending
            || copilotAgentModeMutation.isPending
            || modelMutation.isPending
            || modelReasoningEffortMutation.isPending
            || effortMutation.isPending
            || serviceTierMutation.isPending
            || renameMutation.isPending
            || externalRefsMutation.isPending
            || upsertExternalRefMutation.isPending
            || removePrimaryExternalRefMutation.isPending
            || titleSuggestionMutation.isPending
            || summaryMutation.isPending
            || pinMutation.isPending
            || deleteMutation.isPending,
    }
}

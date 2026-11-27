import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import SettingsGeneralPage from './general'

const { getHubSettings, updateHubSettings } = vi.hoisted(() => ({
    getHubSettings: vi.fn(),
    updateHubSettings: vi.fn()
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: { getHubSettings, updateHubSettings },
        baseUrl: 'http://127.0.0.1:3006',
        // The owner's namespace: the hub-wide switches only render for it.
        token: `x.${btoa(JSON.stringify({ ns: 'default' }))}.x`
    })
}))

vi.mock('@/hooks/queries/useFeatures', () => ({
    useFeatures: () => ({
        features: { githubPrAwareness: { enabled: false, source: 'default' }, prChipDisplay: { staleMs: 7_200_000, forge: {}, estateCodes: {} } },
        isLoading: false
    }),
    usePatchFeatures: () => ({ setGithubPrAwareness: vi.fn(), isPending: false })
}))

vi.mock('@/components/settings/CompanionPairing', () => ({ CompanionPairing: () => <div>Companion pairing</div> }))
vi.mock('@/components/settings/PasskeySettings', () => ({ PasskeySettings: () => <div>Passkeys</div> }))
vi.mock('@/components/settings/PushNotificationsControl', () => ({ PushNotificationsControl: () => <div>Push</div> }))

function settings(overrides: Record<string, unknown> = {}) {
    return {
        sessionSummaryContract: false,
        sessionSummaryInChat: false,
        autoTitlePerTurn: false,
        disablePeerTools: false,
        peerToolsBotsOnly: false,
        autoBridgeTransientModelErrors: false,
        telemetryLevel: 0,
        telemetryLevelSource: 'file',
        peerSpawnDefaults: { agent: 'claude', permissionMode: 'bypassPermissions', models: { claude: 'sonnet' } },
        ...overrides
    }
}

function renderGeneral() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider><SettingsGeneralPage /></I18nProvider>
        </QueryClientProvider>
    )
}

describe('Settings → General: "Bots can still use them"', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('is hidden while the peer tools are available to everyone', async () => {
        getHubSettings.mockResolvedValue(settings({ disablePeerTools: false, peerToolsBotsOnly: true }))
        renderGeneral()
        await screen.findByRole('heading', { name: 'Peer session tools' })
        expect(screen.queryByRole('checkbox', { name: 'Bots can still use them' })).toBeNull()
    })

    it('appears under the peer-tools switch once they are off, and PUTs only its own field', async () => {
        getHubSettings.mockResolvedValue(settings({ disablePeerTools: true, peerToolsBotsOnly: false }))
        updateHubSettings.mockImplementation(async (patch: Record<string, unknown>) => settings({ disablePeerTools: true, ...patch }))
        renderGeneral()

        const toggle = await screen.findByRole('checkbox', { name: 'Bots can still use them' })
        expect(toggle).not.toBeChecked()
        expect(screen.getByText("Only a bot's main conversation gets the four peer tools; every other session stays without them.")).toBeInTheDocument()

        fireEvent.click(toggle)
        await waitFor(() => expect(updateHubSettings).toHaveBeenCalledTimes(1))
        expect(updateHubSettings).toHaveBeenCalledWith({ peerToolsBotsOnly: true })
        await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Bots can still use them' })).toBeChecked())
    })

    it('reads as off when an older hub omits the field', async () => {
        const legacy = settings({ disablePeerTools: true })
        delete (legacy as Record<string, unknown>).peerToolsBotsOnly
        getHubSettings.mockResolvedValue(legacy)
        renderGeneral()
        expect(await screen.findByRole('checkbox', { name: 'Bots can still use them' })).not.toBeChecked()
    })

    it('says so, in the hub\'s words, when the hub refuses the change (低 ⑤)', async () => {
        const body = '{"error":"settings are read-only on this hub","code":"read_only"}'
        getHubSettings.mockResolvedValue(settings({ disablePeerTools: true, peerToolsBotsOnly: false }))
        updateHubSettings.mockRejectedValue(new ApiError(`HTTP 403 Forbidden: ${body}`, 403, 'read_only', body))
        renderGeneral()
        const toggle = await screen.findByRole('checkbox', { name: 'Bots can still use them' })
        fireEvent.click(toggle)
        await waitFor(() => expect(updateHubSettings).toHaveBeenCalledWith({ peerToolsBotsOnly: true }))
        expect(await screen.findByText('settings are read-only on this hub')).toBeInTheDocument()
        // Refused: the switch is back where the hub has it.
        await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Bots can still use them' })).not.toBeChecked())
    })
})

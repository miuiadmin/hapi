import {
    getSettingsFile,
    readSettingsOrThrowCached,
    updateSettings,
    type Settings
} from './settings'

/**
 * Hub-persisted opt-out for the peer-session MCP tools (`list_peers` /
 * `inspect_peer` / `ping_peer`). Default is off (tools available). Env
 * `HAPI_DISABLE_PEER_TOOLS` on the CLI process remains a per-runner escape
 * hatch and is resolved client-side.
 */
export function isDisablePeerToolsSettingEnabled(settings: Settings): boolean {
    return settings.disablePeerTools === true
}

/**
 * Whether bots' home chats are exempt from the opt-out above. This is the
 * stored flag; it only has an effect while `disablePeerTools` is set, and
 * the per-session answer is `BotService.peerToolsDisabledFor`.
 */
export function isPeerToolsBotsOnlySettingEnabled(settings: Settings): boolean {
    return settings.peerToolsBotsOnly === true
}

export async function readDisablePeerToolsEnabled(dataDir: string): Promise<boolean> {
    const settings = await readSettingsOrThrowCached(getSettingsFile(dataDir))
    return isDisablePeerToolsSettingEnabled(settings)
}

export async function readPeerToolsBotsOnlyEnabled(dataDir: string): Promise<boolean> {
    const settings = await readSettingsOrThrowCached(getSettingsFile(dataDir))
    return isPeerToolsBotsOnlySettingEnabled(settings)
}

export async function writePeerToolsBotsOnlyEnabled(
    dataDir: string,
    botsOnly: boolean
): Promise<boolean> {
    return updateSettings(getSettingsFile(dataDir), (current) => {
        const settings = {
            ...current,
            peerToolsBotsOnly: botsOnly
        }
        return {
            settings,
            result: isPeerToolsBotsOnlySettingEnabled(settings)
        }
    })
}

export async function writeDisablePeerToolsEnabled(
    dataDir: string,
    disabled: boolean
): Promise<boolean> {
    return updateSettings(getSettingsFile(dataDir), (current) => {
        const settings = {
            ...current,
            disablePeerTools: disabled
        }
        return {
            settings,
            result: settings.disablePeerTools === true
        }
    })
}

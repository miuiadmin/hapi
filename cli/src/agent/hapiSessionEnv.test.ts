import { afterEach, describe, expect, it } from 'vitest'
import { configuration } from '@/configuration'
import {
    HAPI_BOT_ID_ENV,
    HAPI_BOT_NAME_ENV,
    HAPI_SESSION_ID_ENV,
    exportHapiBotEnv,
    exportHapiHubAuthEnv,
    exportHapiSessionEnv
} from './hapiSessionEnv'

describe('exportHapiBotEnv', () => {
    afterEach(() => {
        delete process.env[HAPI_BOT_ID_ENV]
        delete process.env[HAPI_BOT_NAME_ENV]
    })

    it('publishes the bot id and name for a bot home chat', () => {
        exportHapiBotEnv({ id: 'bot-1', name: 'Release Captain' })
        expect(process.env[HAPI_BOT_ID_ENV]).toBe('bot-1')
        expect(process.env[HAPI_BOT_NAME_ENV]).toBe('Release Captain')
    })

    it('omits the name when the bot has none', () => {
        process.env[HAPI_BOT_NAME_ENV] = 'stale'
        exportHapiBotEnv({ id: 'bot-1', name: '  ' })
        expect(process.env[HAPI_BOT_ID_ENV]).toBe('bot-1')
        expect(process.env[HAPI_BOT_NAME_ENV]).toBeUndefined()
    })

    it('clears an inherited marker so a worker opened from a bot shell is not a bot', () => {
        process.env[HAPI_BOT_ID_ENV] = 'bot-1'
        process.env[HAPI_BOT_NAME_ENV] = 'Release Captain'
        exportHapiBotEnv(null)
        expect(process.env[HAPI_BOT_ID_ENV]).toBeUndefined()
        expect(process.env[HAPI_BOT_NAME_ENV]).toBeUndefined()

        process.env[HAPI_BOT_ID_ENV] = 'bot-1'
        exportHapiBotEnv({ id: '   ' })
        expect(process.env[HAPI_BOT_ID_ENV]).toBeUndefined()
    })
})

describe('exportHapiSessionEnv', () => {
    afterEach(() => {
        delete process.env[HAPI_SESSION_ID_ENV]
    })

    it('publishes HAPI_SESSION_ID for child agent shells', () => {
        exportHapiSessionEnv('session-abc')
        expect(process.env[HAPI_SESSION_ID_ENV]).toBe('session-abc')
    })

    it('ignores empty session ids', () => {
        delete process.env[HAPI_SESSION_ID_ENV]
        exportHapiSessionEnv('')
        expect(process.env[HAPI_SESSION_ID_ENV]).toBeUndefined()
    })
})

describe('exportHapiHubAuthEnv', () => {
    const previousUrl = process.env.HAPI_API_URL
    const previousToken = process.env.CLI_API_TOKEN
    const previousConfigUrl = configuration.apiUrl
    const previousConfigToken = configuration.cliApiToken

    afterEach(() => {
        if (previousUrl === undefined) {
            delete process.env.HAPI_API_URL
        } else {
            process.env.HAPI_API_URL = previousUrl
        }
        if (previousToken === undefined) {
            delete process.env.CLI_API_TOKEN
        } else {
            process.env.CLI_API_TOKEN = previousToken
        }
        configuration._setApiUrl(previousConfigUrl)
        configuration._setCliApiToken(previousConfigToken)
    })

    it('mirrors configured hub URL into process.env for child shells', () => {
        delete process.env.HAPI_API_URL
        delete process.env.CLI_API_TOKEN
        configuration._setApiUrl('http://remote-hub:3006')
        configuration._setCliApiToken('runner-token')

        exportHapiHubAuthEnv({ exportApiUrl: true })

        expect(process.env.HAPI_API_URL).toBe('http://remote-hub:3006')
        expect(process.env.CLI_API_TOKEN).toBeUndefined()
    })

    it('does not clear an existing CLI_API_TOKEN when exporting URL only', () => {
        process.env.HAPI_API_URL = 'http://already-set:3006'
        process.env.CLI_API_TOKEN = 'already-set-token'
        configuration._setApiUrl('http://config-hub:3006')
        configuration._setCliApiToken('settings-token')

        exportHapiHubAuthEnv({ exportApiUrl: true })

        expect(process.env.HAPI_API_URL).toBe('http://config-hub:3006')
        expect(process.env.CLI_API_TOKEN).toBe('already-set-token')
    })

    it('does not export URL or token when api URL is the implicit default', () => {
        delete process.env.HAPI_API_URL
        delete process.env.CLI_API_TOKEN
        configuration._setApiUrl('http://localhost:3006')
        configuration._setCliApiToken('local-token')

        exportHapiHubAuthEnv({ exportApiUrl: false })

        expect(process.env.HAPI_API_URL).toBeUndefined()
        expect(process.env.CLI_API_TOKEN).toBeUndefined()
    })

    it('never mirrors settings/prompt tokens into process.env', () => {
        delete process.env.HAPI_API_URL
        delete process.env.CLI_API_TOKEN
        configuration._setApiUrl('http://remote-hub:3006')
        configuration._setCliApiToken('settings-secret')

        exportHapiHubAuthEnv({ exportApiUrl: true })

        expect(process.env.CLI_API_TOKEN).toBeUndefined()
    })
})

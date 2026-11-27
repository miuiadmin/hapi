import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultBotHomeRoots } from './botHomeRoots'

describe('defaultBotHomeRoots', () => {
    const before = process.env.HAPI_HOME

    afterEach(() => {
        if (before === undefined) delete process.env.HAPI_HOME
        else process.env.HAPI_HOME = before
    })

    it('is ~/.hapi/bots of the given home, plus bots under the runner\'s own HAPI_HOME', () => {
        delete process.env.HAPI_HOME
        const own = join(homedir(), '.hapi', 'bots')
        // With the default HAPI_HOME the runner's own folder is the real home's.
        expect(defaultBotHomeRoots(homedir())).toEqual([own])
        expect(defaultBotHomeRoots('/home/ops')).toEqual(own === '/home/ops/.hapi/bots' ? [own] : ['/home/ops/.hapi/bots', own])

        process.env.HAPI_HOME = '/srv/hapi-home'
        expect(defaultBotHomeRoots('/home/ops')).toEqual(['/home/ops/.hapi/bots', '/srv/hapi-home/bots'])
        expect(defaultBotHomeRoots(homedir())).toEqual([own, '/srv/hapi-home/bots'])
    })

    it('expands a leading ~ of HAPI_HOME the way the runner does', () => {
        process.env.HAPI_HOME = '~/elsewhere'
        expect(defaultBotHomeRoots('/home/ops')).toContain(join(homedir(), 'elsewhere', 'bots'))
    })
})

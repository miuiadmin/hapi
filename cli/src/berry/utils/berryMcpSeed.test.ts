import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { seedBerryHapiMcpBridge } from './berryMcpSeed'

const HAPI_SERVER = {
    command: '/usr/local/bin/hapi',
    args: ['mcp', '--url', 'http://127.0.0.1:9/mcp', '--tools', 'ask_user_question']
}

function createDataDir(): string {
    return mkdtempSync(join(tmpdir(), 'berry-mcp-seed-'))
}

function readEnabled(dataDir: string): Record<string, unknown> {
    return parseYaml(readFileSync(join(dataDir, 'enabled.yaml'), 'utf8')) as Record<string, unknown>
}

describe('seedBerryHapiMcpBridge', () => {
    const dirs: string[] = []

    afterEach(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
        dirs.length = 0
    })

    function freshDir(): string {
        const dir = createDataDir()
        dirs.push(dir)
        return dir
    }

    it('creates enabled.yaml with the core:mcp hapi server when none exists', () => {
        const dataDir = freshDir()

        seedBerryHapiMcpBridge(dataDir, HAPI_SERVER)

        expect(readEnabled(dataDir)).toEqual({
            plugins: [{
                id: 'core:mcp',
                config: {
                    servers: {
                        hapi: {
                            command: '/usr/local/bin/hapi',
                            args: ['mcp', '--url', 'http://127.0.0.1:9/mcp', '--tools', 'ask_user_question'],
                            tool_timeout_sec: 600
                        }
                    }
                }
            }]
        })
    })

    it('upserts hapi into an existing core:mcp row, preserving other servers, rows, and root keys', () => {
        const dataDir = freshDir()
        // Shaped like berry's own output: other MCP servers, another plugin
        // row, and a root key the seeder does not know about.
        writeFileSync(join(dataDir, 'enabled.yaml'), [
            'version: 3',
            'plugins:',
            '  - id: core:mcp',
            '    enabled: true',
            '    config:',
            '      servers:',
            '        fetch:',
            '          command: /usr/local/bin/fetch-mcp',
            '          args: []',
            '  - id: core:other',
            '    config: {}',
            ''
        ].join('\n'))

        seedBerryHapiMcpBridge(dataDir, HAPI_SERVER)

        const enabled = readEnabled(dataDir)
        expect(enabled.version).toBe(3)
        const plugins = enabled.plugins as Array<Record<string, unknown>>
        expect(plugins).toHaveLength(2)
        const coreMcp = plugins.find((row) => row.id === 'core:mcp')!
        expect(coreMcp.enabled).toBe(true)
        const servers = (coreMcp.config as { servers: Record<string, unknown> }).servers
        // The pre-existing server survives untouched.
        expect(servers.fetch).toEqual({ command: '/usr/local/bin/fetch-mcp', args: [] })
        expect(servers.hapi).toEqual({
            command: '/usr/local/bin/hapi',
            args: HAPI_SERVER.args,
            tool_timeout_sec: 600
        })
        expect(plugins.find((row) => row.id === 'core:other')).toEqual({ id: 'core:other', config: {} })
    })

    it('appends the core:mcp row when the file exists without one', () => {
        const dataDir = freshDir()
        writeFileSync(join(dataDir, 'enabled.yaml'), 'plugins:\n  - id: core:other\n    config: {}\n')

        seedBerryHapiMcpBridge(dataDir, HAPI_SERVER)

        const plugins = readEnabled(dataDir).plugins as Array<Record<string, unknown>>
        expect(plugins.map((row) => row.id)).toEqual(['core:other', 'core:mcp'])
    })

    it('is idempotent: a re-seed with the same server writes nothing', () => {
        const dataDir = freshDir()
        seedBerryHapiMcpBridge(dataDir, HAPI_SERVER)
        const enabledPath = join(dataDir, 'enabled.yaml')
        const before = readFileSync(enabledPath, 'utf8')
        const mtimeBefore = statSync(enabledPath).mtimeMs

        seedBerryHapiMcpBridge(dataDir, HAPI_SERVER)

        expect(readFileSync(enabledPath, 'utf8')).toBe(before)
        expect(statSync(enabledPath).mtimeMs).toBe(mtimeBefore)
    })

    it('rewrites when the bridge URL changes', () => {
        const dataDir = freshDir()
        seedBerryHapiMcpBridge(dataDir, HAPI_SERVER)

        seedBerryHapiMcpBridge(dataDir, {
            command: '/usr/local/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:10/mcp', '--tools', 'ask_user_question']
        })

        const servers = ((readEnabled(dataDir).plugins as Array<{ config: { servers: Record<string, unknown> } }>)[0].config).servers
        expect(servers.hapi).toEqual({
            command: '/usr/local/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:10/mcp', '--tools', 'ask_user_question'],
            tool_timeout_sec: 600
        })
    })

    it('rejects a non-absolute command without touching the dataDir', () => {
        const dataDir = freshDir()

        expect(() => seedBerryHapiMcpBridge(dataDir, { command: 'hapi', args: [] })).toThrow(/absolute/)
        expect(existsSync(join(dataDir, 'enabled.yaml'))).toBe(false)
    })
})

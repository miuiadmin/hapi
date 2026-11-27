import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { BOT_HOME_CLAUDE_MD, BOT_HOME_RULES_FILE, PrepareBotHomeResponseSchema, botHomeAgentsMd } from '@hapi/protocol'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { BOT_HOME_MARKER_FILES, expandBotHomePath, isSameOrAncestor, prepareBotHome, registerBotHomeHandlers } from './botHomeHandlers'

describe('expandBotHomePath', () => {
    it('expands a leading ~ against the given home and resolves relative paths', () => {
        expect(expandBotHomePath('~', '/home/ops')).toBe('/home/ops')
        expect(expandBotHomePath('~/.hapi/bots/ops-bot', '/home/ops')).toBe('/home/ops/.hapi/bots/ops-bot')
        expect(expandBotHomePath(' ~/bots/x ', '/home/ops')).toBe('/home/ops/bots/x')
        expect(expandBotHomePath('/srv/bots/../ops', '/home/ops')).toBe('/srv/ops')
    })

    it('leaves a tilde that is not a leading home marker alone', () => {
        expect(expandBotHomePath('/srv/~ops', '/home/ops')).toBe('/srv/~ops')
        expect(expandBotHomePath('a~b', '/home/ops')).toBe(join(process.cwd(), 'a~b'))
    })
})

describe('isSameOrAncestor', () => {
    it('is true for the anchor itself and its ancestors only', () => {
        expect(isSameOrAncestor('/home/ops', '/home/ops')).toBe(true)
        expect(isSameOrAncestor('/home', '/home/ops')).toBe(true)
        expect(isSameOrAncestor('/', '/home/ops')).toBe(true)
        expect(isSameOrAncestor('/home/ops/.hapi', '/home/ops')).toBe(false)
        expect(isSameOrAncestor('/srv', '/home/ops')).toBe(false)
        expect(isSameOrAncestor('/home/opsx', '/home/ops')).toBe(false)
    })
})

describe('prepare-bot-home handler', () => {
    let sandbox: string
    let home: string
    let root: string
    let outside: string

    beforeEach(async () => {
        sandbox = await mkdtemp(join(tmpdir(), 'hapi-bot-home-'))
        home = join(sandbox, 'home')
        root = join(sandbox, 'root')
        outside = join(sandbox, 'outside')
        await Promise.all([home, root, outside].map((dir) => mkdir(dir, { recursive: true })))
    })

    afterEach(async () => {
        await rm(sandbox, { recursive: true, force: true })
    })

    const unrestricted = () => new MachinePathPolicy()
    const run = (path: string, name = 'Ops Bot', policy = unrestricted()) => prepareBotHome({ path, name }, { pathPolicy: policy, home })
    const refused = (code: string) => ({ success: false, code })

    it('creates the folder and seeds AGENTS.md and CLAUDE.md on first use', async () => {
        const result = await run('~/.hapi/bots/ops-bot')
        expect(PrepareBotHomeResponseSchema.parse(result)).toEqual({ path: join(home, '.hapi', 'bots', 'ops-bot'), seeded: true })
        expect(await readFile(join(home, '.hapi', 'bots', 'ops-bot', BOT_HOME_RULES_FILE), 'utf8')).toBe(botHomeAgentsMd('Ops Bot'))
        expect(await readFile(join(home, '.hapi', 'bots', 'ops-bot', 'CLAUDE.md'), 'utf8')).toBe(BOT_HOME_CLAUDE_MD)
    })

    it('the same bot again: identical rules pass with seeded=false and SOUL / MEMORY / CLAUDE.md are left alone', async () => {
        const dir = join(home, 'bots', 'ops')
        await run(dir, 'Ops')
        await writeFile(join(dir, 'SOUL.md'), 'I am careful.\n')
        await writeFile(join(dir, 'MEMORY.md'), 'note\n')
        await writeFile(join(dir, 'CLAUDE.md'), 'my own pointer\n')

        const result = await run(dir, 'Ops')
        expect(result).toEqual({ path: dir, seeded: false })
        expect(await readFile(join(dir, 'SOUL.md'), 'utf8')).toBe('I am careful.\n')
        expect(await readFile(join(dir, 'MEMORY.md'), 'utf8')).toBe('note\n')
        expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe('my own pointer\n')
        expect(await readFile(join(dir, BOT_HOME_RULES_FILE), 'utf8')).toBe(botHomeAgentsMd('Ops'))
    })

    it('re-seeds a missing CLAUDE.md next to identical rules', async () => {
        const dir = join(home, 'bots', 'half')
        await run(dir, 'Half')
        await rm(join(dir, 'CLAUDE.md'))
        const result = await run(dir, 'Half')
        expect(result).toEqual({ path: dir, seeded: false })
        expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(BOT_HOME_CLAUDE_MD)
    })

    it('a different bot\'s home (AGENTS.md differs) is refused as home_taken and nothing is written', async () => {
        const dir = join(home, 'bots', 'other')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, BOT_HOME_RULES_FILE), '# Other: working rules\n')
        await writeFile(join(dir, 'SOUL.md'), 'someone else\n')

        const result = await run(dir, 'Ops')
        expect(result).toMatchObject(refused('home_taken'))
        expect((result as { error: string }).error).toMatch(/another bot's home/)
        expect(await readFile(join(dir, 'SOUL.md'), 'utf8')).toBe('someone else\n')
        expect((await readdir(dir)).sort()).toEqual(['AGENTS.md', 'SOUL.md'])
    })

    it('a folder that already has things in it and is not a bot home is refused as home_not_empty', async () => {
        const project = join(home, 'projects', 'app')
        await mkdir(project, { recursive: true })
        await writeFile(join(project, 'README.md'), 'user project\n')

        const result = await run(project)
        expect(result).toMatchObject(refused('home_not_empty'))
        expect((result as { error: string }).error).toMatch(/not a bot home/)
        expect((await readdir(project)).sort()).toEqual(['README.md'])
    })

    it('a folder with the bot\'s notes but no rules yet is seeded', async () => {
        const dir = join(home, 'bots', 'notes')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'SOUL.md'), 'who I am\n')
        const result = await run(dir, 'Notes')
        expect(result).toEqual({ path: dir, seeded: true })
        expect(await readFile(join(dir, BOT_HOME_RULES_FILE), 'utf8')).toBe(botHomeAgentsMd('Notes'))
        expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(BOT_HOME_CLAUDE_MD)
        expect(await readFile(join(dir, 'SOUL.md'), 'utf8')).toBe('who I am\n')
        expect(BOT_HOME_MARKER_FILES).toEqual(['SOUL.md', 'MEMORY.md'])
    })

    it('refuses the user home directory and anything above it (also via ~ and via a symlink to it)', async () => {
        expect(await run('~')).toMatchObject(refused('invalid_path'))
        expect(await run(sandbox)).toMatchObject(refused('invalid_path'))
        expect(await run('/')).toMatchObject(refused('invalid_path'))
        // The real home of this machine, with the default home lookup: refused before anything is created.
        expect(await prepareBotHome({ path: '~', name: 'Ops' }, { pathPolicy: unrestricted() })).toMatchObject(refused('invalid_path'))
        expect(await readdir(homedir())).not.toContain('CLAUDE.md')

        await mkdir(join(home, 'bots'), { recursive: true })
        await symlink(home, join(home, 'bots', 'home-link'))
        expect(await run(join(home, 'bots', 'home-link'))).toMatchObject(refused('invalid_path'))
        expect(await readdir(home)).not.toContain('CLAUDE.md')
    })

    it('refuses a home outside the machine\'s workspace roots and creates nothing', async () => {
        const result = await run(outside, 'Ops', new MachinePathPolicy({ workspaceRoots: [root] }))
        expect(result).toMatchObject({ ...refused('outside_workspace_roots'), error: 'Path is outside this machine\'s workspace roots' })
        expect(await readdir(outside)).toEqual([])
    })

    it('accepts a home inside the workspace roots even when written via ~', async () => {
        const dir = join(root, 'bots', 'ops')
        const result = await prepareBotHome({ path: '~/bots/ops', name: 'Ops' }, { pathPolicy: new MachinePathPolicy({ workspaceRoots: [root] }), home: root })
        expect(result).toEqual({ path: dir, seeded: true })
    })

    it('follows a symlinked folder name and reports the requested location', async () => {
        const real = join(home, 'bots', 'real')
        await mkdir(real, { recursive: true })
        const link = join(home, 'bots', 'link')
        await symlink(real, link)
        const result = await run(link)
        expect(result).toEqual({ path: link, seeded: true })
        expect(await readFile(join(real, BOT_HOME_RULES_FILE), 'utf8')).toBe(botHomeAgentsMd('Ops Bot'))
    })

    it('reports a path that exists as a file instead of clobbering it', async () => {
        const filePath = join(home, 'not-a-dir')
        await writeFile(filePath, 'keep\n')
        const result = await run(filePath)
        expect(result).toMatchObject(refused('mkdir_failed'))
        expect(await readFile(filePath, 'utf8')).toBe('keep\n')
    })

    it('a read-only folder: identical rules and CLAUDE.md pass untouched; an empty one fails to seed', async () => {
        const readOnlyReady = join(home, 'bots', 'ro-ready')
        await run(readOnlyReady, 'Ops')
        await chmod(readOnlyReady, 0o500)
        try {
            expect(await run(readOnlyReady, 'Ops')).toEqual({ path: readOnlyReady, seeded: false })
        } finally {
            await chmod(readOnlyReady, 0o700)
        }

        const readOnlyEmpty = join(home, 'bots', 'ro-empty')
        await mkdir(readOnlyEmpty, { recursive: true })
        await chmod(readOnlyEmpty, 0o500)
        try {
            expect(await run(readOnlyEmpty)).toMatchObject(refused('seed_failed'))
        } finally {
            await chmod(readOnlyEmpty, 0o700)
        }
    })

    it('is registered on the machine scope and validates its request', async () => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerBotHomeHandlers(rpc, unrestricted())
        expect(rpc.hasHandler(RPC_METHODS.PrepareBotHome)).toBe(true)

        const call = (params: unknown) => rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.PrepareBotHome}`,
            params: JSON.stringify(params)
        })

        const invalid = JSON.parse(await call({ name: 'Ops' })) as Record<string, unknown>
        expect(invalid).toMatchObject({ success: false, code: 'invalid_path' })
        expect(String(invalid.error)).toContain('expected string, received undefined')
        // A relative path never reaches the handler: the shared schema refuses it, and the refusal says why.
        const relativePath = JSON.parse(await call({ path: 'bots/ops', name: 'Ops' })) as Record<string, unknown>
        expect(relativePath).toMatchObject({ success: false, code: 'invalid_path' })
        expect(String(relativePath.error)).toContain('path must be absolute or start with ~')

        const ok = JSON.parse(await call({ path: join(home, 'bots', 'ops'), name: 'Ops' })) as Record<string, unknown>
        expect(PrepareBotHomeResponseSchema.parse(ok)).toEqual({ path: join(home, 'bots', 'ops'), seeded: true })
    })
})

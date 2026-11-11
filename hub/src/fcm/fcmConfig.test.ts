import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeOs from 'node:os'
import { join, relative } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'

import { resolveFcmConfig } from './fcmConfig'

const tempDirs: string[] = []
afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
    // Drop any homedir() override installed by a test in this file so the
    // mock never leaks into other test files sharing the process.
    mock.restore()
})

function makeServiceAccountFile(
    contents: object,
    baseDir: string = nodeOs.tmpdir()
): string {
    const dir = mkdtempSync(join(baseDir, 'hapi-fcm-sa-'))
    tempDirs.push(dir)
    const path = join(dir, 'service-account.json')
    writeFileSync(path, JSON.stringify(contents))
    return path
}

const VALID_ACCOUNT = {
    project_id: 'proj-1',
    client_email: 'svc@proj-1.iam.gserviceaccount.com',
    private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
}

describe('resolveFcmConfig', () => {
    it('returns null when no path is configured', () => {
        expect(resolveFcmConfig({ fcmServiceAccountPath: null })).toBeNull()
        expect(resolveFcmConfig({ fcmServiceAccountPath: '   ' })).toBeNull()
    })

    it('returns null when the configured file does not exist', () => {
        expect(resolveFcmConfig({ fcmServiceAccountPath: '/nonexistent/sa.json' })).toBeNull()
    })

    it('loads the service account and takes the project id from the JSON', () => {
        const path = makeServiceAccountFile(VALID_ACCOUNT)
        const config = resolveFcmConfig({ fcmServiceAccountPath: path })
        expect(config).not.toBeNull()
        expect(config?.projectId).toBe('proj-1')
        expect(config?.serviceAccountPath).toBe(path)
        expect(config?.serviceAccount.client_email).toBe(VALID_ACCOUNT.client_email)
    })

    it('returns null when the JSON has no project_id', () => {
        const path = makeServiceAccountFile({
            client_email: VALID_ACCOUNT.client_email,
            private_key: VALID_ACCOUNT.private_key
        })
        expect(resolveFcmConfig({ fcmServiceAccountPath: path })).toBeNull()
    })

    it('expands ~ in the configured path', () => {
        // Hermetic: resolveFcmConfig expands ~ against os.homedir(), and Bun
        // caches homedir() from the process env at startup — writing the
        // fixture into the operator's real $HOME is the only thing the old
        // test did, and it fails (EACCES) under sandboxed test runs. Override
        // homedir() to a throwaway dir instead.
        const fakeHome = mkdtempSync(join(nodeOs.tmpdir(), 'hapi-fcm-home-'))
        tempDirs.push(fakeHome)
        mock.module('node:os', () => ({ ...nodeOs, homedir: () => fakeHome }))
        const path = makeServiceAccountFile(VALID_ACCOUNT, fakeHome)
        const config = resolveFcmConfig({
            fcmServiceAccountPath: `~/${relative(fakeHome, path)}`
        })
        expect(config?.projectId).toBe('proj-1')
        expect(config?.serviceAccountPath).toBe(path)
    })
})

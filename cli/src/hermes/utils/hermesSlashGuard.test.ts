import { describe, expect, it } from 'vitest'
import {
    HERMES_DESTRUCTIVE_SLASH_VERBS,
    escapeHermesDestructiveSlash,
    hermesSlashVerb,
    isHermesDestructiveSlashVerb
} from './hermesSlashGuard'

describe('hermesSlashVerb', () => {
    it('tokenizes a leading slash verb the way hermes does', () => {
        expect(hermesSlashVerb('/clear')).toBe('clear')
        expect(hermesSlashVerb('/undo last turn')).toBe('undo')
        expect(hermesSlashVerb('  /branch demo')).toBe('branch')
        expect(hermesSlashVerb('/CLEAR')).toBe('clear')
    })

    it('returns null for ordinary text, paths, and unknown words', () => {
        // Mirrors hermes: only a registered command is a command; /etc/hosts
        // and unknown /words are prompt text.
        expect(hermesSlashVerb('hello /clear')).toBeNull()
        expect(hermesSlashVerb('/etc/hosts is wrong')).toBeNull()
        expect(hermesSlashVerb('/tmp/build.log shows the failure')).toBeNull()
        expect(hermesSlashVerb('/')).toBeNull()
        expect(hermesSlashVerb('plain text')).toBeNull()
        expect(hermesSlashVerb('')).toBeNull()
    })
})

describe('escapeHermesDestructiveSlash', () => {
    it('escapes every destructive verb and keeps the original text intact', () => {
        for (const verb of HERMES_DESTRUCTIVE_SLASH_VERBS) {
            const result = escapeHermesDestructiveSlash(`/${verb} the workspace please`)
            expect(result.escaped).toBe(true)
            expect(result.verb).toBe(verb)
            // The user's words survive verbatim below the notice line, and
            // the notice line breaks the leading-slash interception (a
            // leading space would NOT: hermes lstrips before matching).
            expect(result.text).toContain(`/${verb} the workspace please`)
            expect(result.text.startsWith('/')).toBe(false)
            expect(result.text).toContain('must be typed deliberately')
        }
    })

    it('passes read-only verbs through untouched', () => {
        for (const verb of ['help', 'model', 'queue', 'status', 'usage', 'tools', 'title']) {
            const result = escapeHermesDestructiveSlash(`/${verb} glm`)
            expect(result).toEqual({ text: `/${verb} glm`, escaped: false, verb })
        }
    })

    it('passes paths and unknown slash words through untouched', () => {
        expect(escapeHermesDestructiveSlash('/etc/hosts is wrong')).toEqual({
            text: '/etc/hosts is wrong',
            escaped: false,
            verb: null
        })
        expect(escapeHermesDestructiveSlash('/notacommand please')).toEqual({
            text: '/notacommand please',
            escaped: false,
            verb: 'notacommand'
        })
        expect(isHermesDestructiveSlashVerb('notacommand')).toBe(false)
    })

    it('does not escape a verb that is not the first token', () => {
        const result = escapeHermesDestructiveSlash('can you /clear the build dir?')
        expect(result.escaped).toBe(false)
        expect(result.text).toBe('can you /clear the build dir?')
    })
})

import { describe, expect, it } from 'vitest';
import { canonicalizeDiffToolInput, deriveToolName, deriveToolNameWithSource, isPlaceholderToolName } from './utils';

describe('agent tool name helpers', () => {
    it('treats generic kind fallback as placeholder', () => {
        expect(deriveToolName({ kind: 'other' })).toBe('Tool');
        expect(deriveToolName({ kind: 'unknown' })).toBe('Tool');
    });

    it('keeps source metadata for explicit raw input names', () => {
        const derived = deriveToolNameWithSource({
            kind: 'execute',
            rawInput: { name: 'Bash' }
        });
        expect(derived).toEqual({
            name: 'Bash',
            source: 'raw_input_name'
        });
    });

    it('marks placeholder tool names', () => {
        expect(isPlaceholderToolName('other')).toBe(true);
        expect(isPlaceholderToolName('tool')).toBe(true);
        expect(isPlaceholderToolName('search')).toBe(false);
    });

    describe('tool_call title preview suffix (hermes "<name>: <preview>")', () => {
        it('strips the preview when the pre-colon token is a tool identifier', () => {
            expect(deriveToolName({ title: 'terminal: ls -la /tmp' })).toBe('terminal');
            expect(deriveToolName({ title: 'write_file: src/chat/types.ts' })).toBe('write_file');
            expect(deriveToolName({ title: 'todo_list: 3 items updated' })).toBe('todo_list');
        });

        it('strips down to mounted MCP tool identifiers', () => {
            expect(deriveToolName({ title: 'mcp__editor_hapi_ab12cd34__write_file: draft.md' }))
                .toBe('mcp__editor_hapi_ab12cd34__write_file');
        });

        it('keeps the title verbatim when the pre-colon token is a sentence', () => {
            expect(deriveToolName({ title: 'Fix the bug: rewrite the parser' }))
                .toBe('Fix the bug: rewrite the parser');
            expect(deriveToolName({ title: 'Step 1: collect inputs' }))
                .toBe('Step 1: collect inputs');
        });

        it('keeps titles without an identifier-shaped prefix verbatim', () => {
            // No ': ' separator at all.
            expect(deriveToolName({ title: 'Bash(npm test)' })).toBe('Bash(npm test)');
            // Colon is not followed by a space.
            expect(deriveToolName({ title: 'grep:http' })).toBe('grep:http');
            // Pre-colon token carries characters no identifier has.
            expect(deriveToolName({ title: 'src/app.ts: 42 lines' })).toBe('src/app.ts: 42 lines');
        });

        it('strips a single identifier-shaped word before the colon', () => {
            // The charset guard is the only sentence filter (a real sentence
            // always carries whitespace/punctuation); a lone word like this
            // is indistinguishable from a tool name and strips by design.
            expect(deriveToolName({ title: 'Error: something failed' })).toBe('Error');
        });

        it('reports the stripped name with the title source', () => {
            const derived = deriveToolNameWithSource({ title: 'web_extract: https://example.com/a' });
            expect(derived).toEqual({ name: 'web_extract', source: 'title' });
        });
    });

    describe('kind=edit _meta.kind mapping (Gemini write_file / replace)', () => {
        // Gemini ACP: kind=edit with _meta.kind distinguishes write_file (add)
        // from replace (modify). Map to canonical Claude tool names.
        //   kind=edit + metaKind=add    → 'Write'
        //   kind=edit + metaKind=modify → 'Edit'
        //   metaKind absent             → existing kind fallback ('edit')

        it('maps kind=edit + metaKind=add to Write', () => {
            const derived = deriveToolNameWithSource({
                kind: 'edit',
                metaKind: 'add'
            });
            expect(derived.name).toBe('Write');
        });

        it('maps kind=edit + metaKind=modify to Edit', () => {
            const derived = deriveToolNameWithSource({
                kind: 'edit',
                metaKind: 'modify'
            });
            expect(derived.name).toBe('Edit');
        });

        it('falls back to kind-based name when metaKind is absent', () => {
            // Without metaKind the existing behaviour must be preserved:
            // kind='edit' is not a placeholder so it surfaces as 'edit'
            const derived = deriveToolNameWithSource({
                kind: 'edit'
            });
            expect(derived.source).toBe('kind');
            expect(derived.name).toBe('edit');
        });

        it('title still wins over metaKind when title is present', () => {
            // title takes highest priority — metaKind must NOT override it
            const derived = deriveToolNameWithSource({
                title: 'MyCustomTool',
                kind: 'edit',
                metaKind: 'add'
            });
            expect(derived.name).toBe('MyCustomTool');
            expect(derived.source).toBe('title');
        });
    });

    describe('canonicalizeDiffToolInput (OpenCode native diff shapes)', () => {
        // OpenCode ACP keeps tool arguments in native shape:
        //   edit  → {filePath, oldString, newString}
        //   write → {filePath, content}
        // The web Edit/Write views only render the Claude-shaped inputs
        // ({file_path, old_string, new_string} / {file_path, content}), so
        // these shapes are canonicalized at the adapter boundary.

        it('maps camelCase edit input to the canonical Edit shape', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'foo',
                newString: 'bar'
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' }
            });
        });

        it('maps snake_case edit input to the canonical Edit shape', () => {
            expect(canonicalizeDiffToolInput({
                file_path: '/tmp/a.ts',
                old_string: 'foo',
                new_string: 'bar'
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' }
            });
        });

        it('allows empty newString (deletion edits)', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'drop me\n',
                newString: ''
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'drop me\n', new_string: '' }
            });
        });

        it('preserves replaceAll=true on edit input', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'foo',
                newString: 'bar',
                replaceAll: true
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar', replace_all: true }
            });
        });

        it('preserves replaceAll=false on edit input', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'foo',
                newString: 'bar',
                replaceAll: false
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar', replace_all: false }
            });
        });

        it('preserves snake_case replace_all=true on edit input', () => {
            expect(canonicalizeDiffToolInput({
                file_path: '/tmp/a.ts',
                old_string: 'foo',
                new_string: 'bar',
                replace_all: true
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar', replace_all: true }
            });
        });

        it('preserves snake_case replace_all=false on edit input', () => {
            expect(canonicalizeDiffToolInput({
                file_path: '/tmp/a.ts',
                old_string: 'foo',
                new_string: 'bar',
                replace_all: false
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar', replace_all: false }
            });
        });

        it('prefers camelCase replaceAll over snake_case replace_all', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'foo',
                newString: 'bar',
                replaceAll: true,
                replace_all: false
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar', replace_all: true }
            });
        });

        it('omits replace_all when absent or non-boolean', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'foo',
                newString: 'bar'
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' }
            });
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'foo',
                newString: 'bar',
                replaceAll: 'yes'
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' }
            });
        });

        it('prefers Edit over Write when both edit and content fields are present', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'foo',
                newString: 'bar',
                content: 'baz'
            }, 'edit')).toEqual({
                name: 'Edit',
                input: { file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' }
            });
        });

        it('maps camelCase write input to the canonical Write shape', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/b.txt',
                content: 'hello\n'
            }, 'write')).toEqual({
                name: 'Write',
                input: { file_path: '/tmp/b.txt', content: 'hello\n' }
            });
        });

        it('maps snake_case write input to the canonical Write shape', () => {
            expect(canonicalizeDiffToolInput({
                file_path: '/tmp/b.txt',
                content: ''
            }, 'write')).toEqual({
                name: 'Write',
                input: { file_path: '/tmp/b.txt', content: '' }
            });
        });

        it('returns null without a usable path', () => {
            expect(canonicalizeDiffToolInput({
                oldString: 'foo',
                newString: 'bar'
            }, 'edit')).toBeNull();
            expect(canonicalizeDiffToolInput({
                filePath: 42,
                oldString: 'foo',
                newString: 'bar'
            }, 'edit')).toBeNull();
        });

        it('returns null when one of old/new is missing', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'foo'
            }, 'edit')).toBeNull();
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                newString: 'bar'
            }, 'edit')).toBeNull();
        });

        it('returns null for non-diff shapes (e.g. apply_patch text)', () => {
            expect(canonicalizeDiffToolInput({
                patch: '*** Begin Patch\n...'
            }, 'edit')).toBeNull();
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                command: 'ls'
            }, 'edit')).toBeNull();
        });

        it('returns null for non-object inputs', () => {
            expect(canonicalizeDiffToolInput(null, 'edit')).toBeNull();
            expect(canonicalizeDiffToolInput(undefined, 'edit')).toBeNull();
            expect(canonicalizeDiffToolInput('{"filePath":"/tmp/a.ts"}', 'edit')).toBeNull();
            expect(canonicalizeDiffToolInput([], 'edit')).toBeNull();
        });

        it('does not rename a non-edit tool whose schema accepts filePath/content', () => {
            // A custom MCP tool with {filePath, content, mode} must not be
            // canonicalized to Write — its name and extra args are preserved.
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                content: 'payload',
                mode: 'append'
            }, 'artifact_write')).toBeNull();
        });

        it('returns null when the semantic hint is missing or unknown', () => {
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                oldString: 'foo',
                newString: 'bar'
            }, null)).toBeNull();
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/a.ts',
                content: 'hi'
            }, 'bash')).toBeNull();
        });

        it('canonicalizes write when the kind is edit (OpenCode mapping)', () => {
            // OpenCode maps write's kind to 'edit'; that alias must still
            // canonicalize a write-shaped input.
            expect(canonicalizeDiffToolInput({
                filePath: '/tmp/b.txt',
                content: 'hello\n'
            }, 'edit')).toEqual({
                name: 'Write',
                input: { file_path: '/tmp/b.txt', content: 'hello\n' }
            });
        });
    });
});

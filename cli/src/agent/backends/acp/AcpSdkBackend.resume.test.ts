import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportState = vi.hoisted(() => ({
    calls: [] as Array<{ method: string; params?: unknown }>,
    initializeResponse: {} as Record<string, unknown>,
    resumeResponse: { configOptions: [] } as Record<string, unknown>,
    loadResponse: {} as Record<string, unknown> | null,
    resumeErrorQueue: [] as Array<Error | null>
}));

vi.mock('./AcpStdioTransport', () => {
    class MockAcpStdioTransport {
        static async create(_options: unknown) {
            return new MockAcpStdioTransport();
        }
        onNotification = vi.fn();
        onStderrError = vi.fn();
        registerRequestHandler = vi.fn();
        sendRequest = vi.fn(async (method: string, params?: unknown) => {
            transportState.calls.push({ method, params });
            if (method === 'initialize') {
                return transportState.initializeResponse;
            }
            if (method === 'session/resume') {
                // Deferred (null) placeholders consume a slot without failing,
                // letting tests stage N failures followed by success.
                if (transportState.resumeErrorQueue.length > 0) {
                    const error = transportState.resumeErrorQueue.shift();
                    if (error) throw error;
                }
                return transportState.resumeResponse;
            }
            if (method === 'session/load') {
                // Berry 0.1.x answers session/load with {} (replay then live
                // attach; no remapped id).
                return transportState.loadResponse ?? {};
            }
            return null;
        });
        sendNotification = vi.fn();
        close = vi.fn(async () => {});
    }
    // Mirrors the real module's indeterminate marker (the mock replaces the
    // module, so AcpSdkBackend's own import must resolve to a working copy).
    // Registered globally so tests can mark errors with the same symbol.
    const indeterminateSymbol = Symbol.for('acp-indeterminate-mock');
    return {
        AcpStdioTransport: MockAcpStdioTransport,
        ACP_INDETERMINATE_SYMBOL: indeterminateSymbol,
        isAcpIndeterminateError: (error: unknown) =>
            typeof error === 'object'
            && error !== null
            && (error as Record<symbol, unknown>)[indeterminateSymbol] === true
    };
});

import { AcpSdkBackend } from './AcpSdkBackend';

/** A dead-transport rejection the way AcpStdioTransport marks one. */
function indeterminateError(message = 'ACP process exited (code=1, signal=null)'): Error {
    const error = new Error(message)
    Object.defineProperty(error, Symbol.for('acp-indeterminate-mock'), { value: true })
    return error
}

describe('AcpSdkBackend.sessionResume', () => {
    beforeEach(() => {
        transportState.calls = [];
        transportState.initializeResponse = { protocolVersion: 1, authMethods: [] };
        transportState.resumeResponse = { configOptions: [] };
        transportState.loadResponse = {};
        transportState.resumeErrorQueue = [];
    });

    it('probes the resume capability independently of loadSession', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                // dsh 0.2.x: no legacy loadSession flag, resume under sessionCapabilities.
                sessionCapabilities: { close: {}, list: {}, resume: {} }
            }
        };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        expect(backend.supportsLoadSession()).toBe(false);
        expect(backend.supportsSessionResume()).toBe(true);
    });

    it('reports no resume support for agents that stay silent about session capabilities', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        expect(backend.supportsSessionResume()).toBe(false);
    });

    it('resumes via session/resume and keeps the requested id when none is returned', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { close: {}, list: {}, resume: {} }
            }
        };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        const sessionId = await backend.resumeSession({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp',
            mcpServers: []
        });

        expect(transportState.calls).toContainEqual({
            method: 'session/resume',
            params: { sessionId: 'dsh-stored-1', cwd: '/tmp', mcpServers: [] }
        });
        expect(sessionId).toBe('dsh-stored-1');
    });

    it('prefers the sessionId returned by the agent when present', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { close: {}, list: {}, resume: {} }
            }
        };
        transportState.resumeResponse = { sessionId: 'remapped-1' };
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        const sessionId = await backend.resumeSession({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp',
            mcpServers: []
        });

        expect(sessionId).toBe('remapped-1');
    });

    it('does not retry a terminal invalidParams resume rejection (dsh: mismatched cwd / active session)', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { close: {}, list: {}, resume: {} }
            }
        };
        // dsh answers a resume whose cwd does not realpath-match the stored
        // session (or one that is still active elsewhere) with a TERMINAL
        // invalidParams JSON-RPC error. Retrying it would only delay the
        // caller's fresh-session fallback by the full backoff chain.
        transportState.resumeErrorQueue = [
            new Error('Session cwd mismatch: session belongs to /other/path (-32602 invalidParams)')
        ];
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        await expect(backend.resumeSession({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp',
            mcpServers: []
        })).rejects.toThrow('invalidParams');

        // Exactly one session/resume request — no retry of the terminal error.
        const resumeCalls = transportState.calls.filter((call) => call.method === 'session/resume');
        expect(resumeCalls).toHaveLength(1);
    });

    it('retries a transport-indeterminate resume failure and then succeeds', async () => {
        transportState.initializeResponse = {
            protocolVersion: 1,
            agentCapabilities: {
                sessionCapabilities: { close: {}, list: {}, resume: {} }
            }
        };
        // The child process died mid-request: the failure carries the
        // transport's indeterminate marker (after a respawn the same request
        // can succeed, so retrying it is correct).
        transportState.resumeErrorQueue = [indeterminateError()];
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        await backend.initialize();

        const sessionId = await backend.resumeSession({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp',
            mcpServers: []
        });

        expect(sessionId).toBe('dsh-stored-1');
        const resumeCalls = transportState.calls.filter((call) => call.method === 'session/resume');
        expect(resumeCalls).toHaveLength(2);
    });

    it('does not retry a terminal session/new rejection', async () => {
        // Mirrors the resume filter: a terminal session/new rejection
        // (invalidParams etc.) fails fast instead of burning all 3 attempts
        // of backoff before the caller surfaces the error.
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                transportState.calls.push({ method, params });
                throw new Error('Invalid session configuration (-32602 invalidParams)');
            },
            close: async () => {}
        };

        await expect(backend.newSession({ cwd: '/tmp', mcpServers: [] }))
            .rejects.toThrow('invalidParams');

        // Exactly one session/new request — no retry of the terminal error.
        const newCalls = transportState.calls.filter((call) => call.method === 'session/new');
        expect(newCalls).toHaveLength(1);
    });

    it('retries a transport-indeterminate session/new failure and then succeeds', async () => {
        // Only the transport's indeterminate marker keeps the retry: the
        // child died mid-request, and the same request can succeed after a
        // respawn.
        let attempts = 0;
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                transportState.calls.push({ method, params });
                attempts += 1;
                if (attempts === 1) throw indeterminateError();
                return { sessionId: 'fresh-acp-1' };
            },
            close: async () => {}
        };

        const sessionId = await backend.newSession({ cwd: '/tmp', mcpServers: [] });

        expect(sessionId).toBe('fresh-acp-1');
        const newCalls = transportState.calls.filter((call) => call.method === 'session/new');
        expect(newCalls).toHaveLength(2);
    });

    it('loads via session/load and falls back to the requested id when the answer carries none', async () => {
        // Berry (agentCapabilities.loadSession): session/load replays the
        // stored history then live-attaches, answering {} — no sessionId.
        // The caller must still end up with the requested id.
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async (method, params) => {
                transportState.calls.push({ method, params });
                if (method === 'session/load') return {};
                return null;
            },
            close: async () => {}
        };

        const sessionId = await backend.loadSession({
            sessionId: 'berry-stored-1',
            cwd: '/tmp',
            mcpServers: []
        });

        expect(transportState.calls).toContainEqual({
            method: 'session/load',
            params: { sessionId: 'berry-stored-1', cwd: '/tmp', mcpServers: [] }
        });
        expect(sessionId).toBe('berry-stored-1');
    });

    it('prefers the sessionId returned by session/load when present', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        const backendInternal = backend as unknown as {
            transport: { sendRequest: (method: string, params: unknown) => Promise<unknown>; close: () => Promise<void> } | null;
        };
        backendInternal.transport = {
            sendRequest: async () => ({ sessionId: 'remapped-9' }),
            close: async () => {}
        };

        const sessionId = await backend.loadSession({
            sessionId: 'berry-stored-1',
            cwd: '/tmp',
            mcpServers: []
        });

        expect(sessionId).toBe('remapped-9');
    });
});

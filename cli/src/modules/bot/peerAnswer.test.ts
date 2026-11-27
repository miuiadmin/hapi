import { describe, expect, it, vi } from 'vitest'
import { answerRequest, buildPeerAnswerPlan, isQuestionTool, parseQuestionToolInput, resolveOptionChoice } from './peerAnswer'
import { BotClientError } from './botClient'

type MockResponse = { status: number; data: unknown }

const SESSION = '11111111-2222-4333-8444-555555555555'
const REQUEST = 'req-1'

const askUserQuestion = {
    tool: 'AskUserQuestion',
    arguments: {
        questions: [
            { question: 'Ship from where?', header: 'Branch', options: [{ label: 'main' }, { label: 'release/2.3', description: 'older' }], multiSelect: false },
            { question: 'Notify whom?', options: [{ label: 'Team' }, { label: 'Owner' }], multiSelect: true }
        ]
    }
}
const singleQuestion = { tool: 'AskUserQuestion', arguments: { questions: [askUserQuestion.arguments.questions[0]] } }
const bashPrompt = { tool: 'Bash', arguments: { command: 'rm -rf build' } }

function createHttpMock(handler: (method: 'get' | 'post', url: string, body?: unknown) => MockResponse) {
    return {
        get: vi.fn(async (url: string) => handler('get', url)),
        post: vi.fn(async (url: string, body?: unknown) => handler('post', url, body)),
        patch: vi.fn(async () => { throw new Error('unexpected PATCH') })
    }
}

function sessionWithRequests(requests: Record<string, unknown>) {
    return { status: 200, data: { session: { id: SESSION, active: true, agentState: { requests } } } }
}

/** Every refusal must be a bad_args with the given message; a helper so each case stays one line. */
function refuse(request: unknown, input: unknown, message: RegExp) {
    expect(() => buildPeerAnswerPlan(request as never, input as never)).toThrow(message)
    try {
        buildPeerAnswerPlan(request as never, input as never)
    } catch (error) {
        expect(error).toBeInstanceOf(BotClientError)
        expect((error as BotClientError).code).toBe('bad_args')
    }
}

describe('question tool detection', () => {
    it('knows the question tools', () => {
        for (const tool of ['AskUserQuestion', 'ask_user_question', 'mcp__hapi__ask_user_question', 'CursorAskQuestion', 'request_user_input']) {
            expect(isQuestionTool(tool)).toBe(true)
        }
        expect(isQuestionTool('Bash')).toBe(false)
        expect(isQuestionTool('Write')).toBe(false)
    })

    it('parses questions keyed by index, by id for Cursor and request_user_input', () => {
        expect(parseQuestionToolInput('AskUserQuestion', askUserQuestion.arguments).map((q) => q.key)).toEqual(['0', '1'])
        const cursor = parseQuestionToolInput('CursorAskQuestion', { questions: [{ id: 'q7', prompt: 'Go?', options: [{ id: 'yes', label: 'Yes' }] }] })
        expect(cursor).toEqual([{ index: 0, key: 'q7', prompt: 'Go?', options: [{ label: 'Yes', id: 'yes' }], multi: false }])
        expect(parseQuestionToolInput('request_user_input', { questions: [{ id: 'a', question: 'x?' }] }).map((q) => q.key)).toEqual(['a'])
        expect(parseQuestionToolInput('AskUserQuestion', null)).toEqual([])
    })
})

describe('permission prompts', () => {
    it('need an explicit --approve or --deny; nothing else counts', () => {
        refuse(bashPrompt, {}, /is a permission request, not a question: pass --approve or --deny/)
        expect(buildPeerAnswerPlan(bashPrompt, { approve: true })).toEqual({ approve: true, body: { decision: 'approved' }, summary: 'approved Bash (once)' })
        expect(buildPeerAnswerPlan(bashPrompt, { deny: true })).toEqual({ approve: false, body: {}, summary: 'denied Bash' })
    })

    it('refuse answer flags instead of reading them as approval', () => {
        refuse(bashPrompt, { option: 'y' }, /pass --approve or --deny/)
        refuse(bashPrompt, { options: ['1'] }, /is a permission request, not a question: answer it with --approve or --deny/)
        refuse(bashPrompt, { text: 'ok' }, /permission request, not a question/)
        refuse(bashPrompt, { question: 1 }, /permission request, not a question/)
        refuse(bashPrompt, { answers: ['1=yes'] }, /permission request, not a question/)
        refuse(bashPrompt, { approve: true, deny: true }, /not both/)
    })
})

describe('questions: cancel', () => {
    it('--deny cancels and takes no answers; --approve is refused on a question', () => {
        expect(buildPeerAnswerPlan(askUserQuestion, { deny: true })).toEqual({ approve: false, body: {}, summary: 'canceled AskUserQuestion' })
        refuse(askUserQuestion, { deny: true, options: ['main'] }, /takes no answers/)
        refuse(askUserQuestion, { approve: true }, /is a question, not a permission request/)
        refuse({ tool: 'AskUserQuestion', arguments: { questions: [] } }, {}, /has no questions to answer; cancel it with --deny/)
    })
})

describe('questions: one question', () => {
    it('answers by exact option text or 1-based number, multi-select appends, free text only via --text', () => {
        expect(buildPeerAnswerPlan(singleQuestion, { options: ['1'] }).body).toEqual({ answers: { '0': ['main'] } })
        expect(buildPeerAnswerPlan(singleQuestion, { options: ['release/2.3'] }).body).toEqual({ answers: { '0': ['release/2.3'] } })
        expect(buildPeerAnswerPlan(singleQuestion, { options: ['main', '2'] }).body).toEqual({ answers: { '0': ['main', 'release/2.3'] } })
        expect(buildPeerAnswerPlan(singleQuestion, { text: ' neither ' }).body).toEqual({ answers: { '0': ['neither'] } })
        expect(buildPeerAnswerPlan(singleQuestion, { options: ['main'], text: 'note' }).body).toEqual({ answers: { '0': ['main', 'note'] } })
        expect(buildPeerAnswerPlan(singleQuestion, { options: ['main'] }).summary).toBe('answered AskUserQuestion: 1. Ship from where? → main')
    })

    it('--option must hit exactly one option: out of range, unknown or ambiguous is an error, never free text', () => {
        refuse(singleQuestion, { options: ['3'] }, /option 3 is out of range for question 1 \(1\. main  2\. release\/2\.3\)/)
        refuse(singleQuestion, { options: ['0'] }, /option 0 is out of range/)
        refuse(singleQuestion, { options: ['rele'] }, /"rele" is not an option of question 1 .*free text goes through --text/)
        refuse(singleQuestion, { options: ['Main'] }, /"Main" is not an option of question 1/)
        refuse(singleQuestion, { options: [''] }, /cannot be blank/)
        refuse(singleQuestion, { options: ['main'], text: '  ' }, /--text is empty/)
        refuse({ tool: 'AskUserQuestion', arguments: { questions: [{ question: 'Twin?', options: [{ label: 'same' }, { label: 'same' }] }] } }, { options: ['same'] }, /"same" names 2 options of question 1; use the index/)
    })

    it('a question without options takes free text only', () => {
        const open = { tool: 'AskUserQuestion', arguments: { questions: [{ question: 'Why?' }] } }
        expect(buildPeerAnswerPlan(open, { text: 'because' }).body).toEqual({ answers: { '0': ['because'] } })
        refuse(open, { options: ['because'] }, /"because" is not an option of question 1 \(no options; answer in your own words with --text\)/)
    })
})

describe('questions: several', () => {
    it('take one --answer <n>=… per question; option values resolve like --option, anything else is free text', () => {
        const plan = buildPeerAnswerPlan(askUserQuestion, { answers: ['1=1', '2=Team', '2=Owner'] })
        expect(plan.body).toEqual({ answers: { '0': ['main'], '1': ['Team', 'Owner'] } })
        expect(plan.summary).toBe('answered AskUserQuestion: 1. Ship from where? → main; 2. Notify whom? → Team, Owner')
        expect(buildPeerAnswerPlan(askUserQuestion, { answers: ['1=later', '2=someone else'] }).body).toEqual({ answers: { '0': ['later'], '1': ['someone else'] } })
        expect(buildPeerAnswerPlan(askUserQuestion, { answers: ['1 = main', '2= 2'] }).body).toEqual({ answers: { '0': ['main'], '1': ['Owner'] } })
    })

    it('a missing question is refused by name and nothing partial is sent', () => {
        refuse(askUserQuestion, { answers: ['1=main'] }, /no answer for question\(s\): 2\. Notify whom\? — nothing was sent/)
        refuse(askUserQuestion, {}, /answer every question: 1\. Ship from where\?; 2\. Notify whom\? .*--answer <n>=<option or text>/)
        refuse(askUserQuestion, { answers: ['2=Team'] }, /no answer for question\(s\): 1\. Ship from where\?/)
    })

    it('--option / --text need --question there, and every question still gets an answer', () => {
        refuse(askUserQuestion, { options: ['main'] }, /has 2 questions; answer each with --answer <n>=<option or text> \(1\.\.2\)/)
        refuse(askUserQuestion, { question: 1, options: ['main'] }, /no answer for question\(s\): 2\. Notify whom\?/)
        expect(buildPeerAnswerPlan(askUserQuestion, { question: 1, options: ['main'], answers: ['2=Team'] }).body).toEqual({ answers: { '0': ['main'], '1': ['Team'] } })
    })

    it('refuses malformed answers and unknown question numbers', () => {
        refuse(askUserQuestion, { answers: ['main'] }, /--answer must look like <n>=<option or text> \(got "main"\)/)
        refuse(askUserQuestion, { answers: ['1='] }, /--answer 1= is empty/)
        refuse(askUserQuestion, { answers: ['3=main', '2=Team'] }, /question 3 does not exist; this request has 2 \(1\.\.2\)/)
        refuse(askUserQuestion, { question: 0, options: ['main'], answers: ['2=Team'] }, /question 0 does not exist/)
    })
})

describe('other question tools', () => {
    it('uses option ids for Cursor and the nested shape for request_user_input', () => {
        const cursor = buildPeerAnswerPlan({ tool: 'CursorAskQuestion', arguments: { questions: [{ id: 'q7', prompt: 'Go?', options: [{ id: 'yes', label: 'Yes' }] }] } }, { options: ['1'] })
        expect(cursor.body).toEqual({ answers: { q7: ['yes'] } })
        const codex = buildPeerAnswerPlan({ tool: 'request_user_input', arguments: { questions: [{ id: 'a', question: 'x?' }] } }, { text: 'because' })
        expect(codex.body).toEqual({ answers: { a: { answers: ['user_note: because'] } } })
        const codexOption = buildPeerAnswerPlan({ tool: 'request_user_input', arguments: { questions: [{ id: 'a', question: 'x?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }, { options: ['No'] })
        expect(codexOption.body).toEqual({ answers: { a: { answers: ['No'] } } })
    })

    it('resolveOptionChoice is strict on demand and lenient for --answer values', () => {
        const [question] = parseQuestionToolInput('AskUserQuestion', singleQuestion.arguments)
        expect(resolveOptionChoice(question!, '2', 'AskUserQuestion', { strict: true })).toBe('release/2.3')
        expect(resolveOptionChoice(question!, 'whatever', 'AskUserQuestion', { strict: false })).toBe('whatever')
        expect(() => resolveOptionChoice(question!, 'whatever', 'AskUserQuestion', { strict: true })).toThrow(/not an option/)
        expect(() => resolveOptionChoice(question!, '9', 'AskUserQuestion', { strict: false })).toThrow(/out of range/)
    })
})

describe('answerRequest', () => {
    const base = { apiUrl: 'http://hub.test', accessToken: 'tok' }

    it('loads the pending request, resolves a 1-based option number to its label and approves once', async () => {
        const http = createHttpMock((method, url, body) => {
            if (method === 'post' && url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            if (method === 'get' && url.endsWith(`/api/sessions/${SESSION}`)) return sessionWithRequests({ [REQUEST]: singleQuestion })
            if (method === 'post') {
                expect(url).toBe(`http://hub.test/api/sessions/${SESSION}/permissions/${REQUEST}/approve`)
                expect(body).toEqual({ answers: { '0': ['main'] } })
                return { status: 200, data: { ok: true } }
            }
            throw new Error(`unexpected ${method} ${url}`)
        })
        const result = await answerRequest({ ...base, sessionIdPrefix: SESSION, requestId: REQUEST, input: { options: ['1'] }, http: http as never })
        expect(result).toMatchObject({ sessionId: SESSION, requestId: REQUEST, tool: 'AskUserQuestion' })
        expect(result.plan.summary).toBe('answered AskUserQuestion: 1. Ship from where? → main')
        // One JWT exchange for the whole command.
        expect(http.post.mock.calls.map((call) => call[0]).filter((url) => String(url).endsWith('/api/auth'))).toHaveLength(1)
    })

    it('resolves a session prefix through the list and denies a tool permission only when told to', async () => {
        const http = createHttpMock((method, url, body) => {
            if (method === 'post' && url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            if (method === 'get' && url.endsWith('/api/sessions')) return { status: 200, data: { sessions: [{ id: SESSION }, { id: 'other-2222-2222-2222-222222222222' }] } }
            if (method === 'get') return sessionWithRequests({ [REQUEST]: bashPrompt })
            expect(url).toBe(`http://hub.test/api/sessions/${SESSION}/permissions/${REQUEST}/deny`)
            expect(body).toEqual({})
            return { status: 200, data: { ok: true } }
        })
        const result = await answerRequest({ ...base, sessionIdPrefix: '11111111-2222', requestId: REQUEST, input: { deny: true }, http: http as never })
        expect(result.plan.approve).toBe(false)
        // No decision at all: refused before any answer is posted.
        const bare = createHttpMock((method, url) => {
            if (method === 'post' && url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            if (method === 'get') return sessionWithRequests({ [REQUEST]: bashPrompt })
            throw new Error('an answer must not be posted')
        })
        await expect(answerRequest({ ...base, sessionIdPrefix: SESSION, requestId: REQUEST, input: {}, http: bare as never }))
            .rejects.toMatchObject({ code: 'bad_args' })
    })

    it('reports a missing or already-answered request as not_found', async () => {
        const http = createHttpMock((method, url) => {
            if (method === 'post' && url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            if (method === 'get') return sessionWithRequests({ 'other-req': { tool: 'Bash' } })
            return { status: 404, data: { error: 'Request not found' } }
        })
        await expect(answerRequest({ ...base, sessionIdPrefix: SESSION, requestId: 'gone', input: { deny: true }, http: http as never }))
            .rejects.toMatchObject({ code: 'not_found' })
    })

    it('maps a race (409) and a refused answer', async () => {
        const race = createHttpMock((method, url) => {
            if (method === 'post' && url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            if (method === 'get') return sessionWithRequests({ [REQUEST]: bashPrompt })
            return { status: 409, data: { error: 'Permission request not found' } }
        })
        await expect(answerRequest({ ...base, sessionIdPrefix: SESSION, requestId: REQUEST, input: { deny: true }, http: race as never }))
            .rejects.toMatchObject({ code: 'request_failed', httpStatus: 409 })

        const refused = createHttpMock((method, url) => {
            if (method === 'post' && url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            if (method === 'get') return sessionWithRequests({ [REQUEST]: bashPrompt })
            return { status: 503, data: { error: 'Session is not connected to the hub, so the answer cannot be delivered.', code: 'rpc_target_missing' } }
        })
        await expect(answerRequest({ ...base, sessionIdPrefix: SESSION, requestId: REQUEST, input: { deny: true }, http: refused as never }))
            .rejects.toThrow(/not connected to the hub/)
    })

    it('refuses an ambiguous prefix before touching the request', async () => {
        const http = createHttpMock((method, url) => {
            if (method === 'post' && url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            return { status: 200, data: { sessions: [{ id: 'aaaaaaaa-1' }, { id: 'aaaaaaaa-2' }] } }
        })
        await expect(answerRequest({ ...base, sessionIdPrefix: 'aaaaaaaa', requestId: REQUEST, input: { deny: true }, http: http as never }))
            .rejects.toMatchObject({ code: 'bad_args' })
    })
})

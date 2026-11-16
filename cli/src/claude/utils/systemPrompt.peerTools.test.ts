import { describe, expect, it, vi } from 'vitest'

/**
 * Peer-tools citation steer across all three flavors.
 *
 * The gate is resolved either at import time (citation block baked into
 * module-level prompt consts, feature shape) or at call time
 * (getSystemPrompt(env) resolving per call, stack shape). Setting the env
 * before import AND keeping it set through the assertions covers both
 * shapes; each mode re-imports the modules fresh via vi.resetModules().
 */
async function importFlavorPrompts(disabled: boolean) {
    vi.resetModules()
    const prev = process.env.HAPI_DISABLE_PEER_TOOLS
    if (disabled) process.env.HAPI_DISABLE_PEER_TOOLS = '1'
    else delete process.env.HAPI_DISABLE_PEER_TOOLS
    const [claude, codex, opencode, peerTools] = await Promise.all([
        import('./systemPrompt'),
        import('../../codex/utils/systemPrompt'),
        import('../../opencode/utils/systemPrompt'),
        import('../../modules/common/peerTools'),
    ])
    const restore = () => {
        if (prev === undefined) delete process.env.HAPI_DISABLE_PEER_TOOLS
        else process.env.HAPI_DISABLE_PEER_TOOLS = prev
    }
    return { claude, codex, opencode, peerTools, restore }
}

describe('peer-tools citation steer across flavors', () => {
    it('replaces the citation tool steer with the disabled notice when HAPI_DISABLE_PEER_TOOLS is set', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(true)
        try {
            const claudePrompt = claude.getSystemPrompt()
            expect(claudePrompt).toContain('are disabled on this machine')
            expect(claudePrompt).not.toContain('Call "mcp__hapi__inspect_peer"')

            expect(codex.TITLE_INSTRUCTION).toContain('are disabled on this machine')
            expect(codex.TITLE_INSTRUCTION).not.toContain('Call "functions.hapi__inspect_peer"')

            expect(opencode.TITLE_INSTRUCTION).toContain('are disabled on this machine')
            expect(opencode.TITLE_INSTRUCTION).not.toContain('Call "hapi_inspect_peer"')

            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).toContain('are disabled on this machine')
            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).not.toContain('Call "hapi_inspect_peer"')
            for (const prompt of [claudePrompt, codex.TITLE_INSTRUCTION, opencode.TITLE_INSTRUCTION, opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION]) {
                expect(prompt).not.toContain('auto (default)')
            }
        } finally {
            restore()
        }
    })

    it('leaves media delivery to tool contracts across flavors', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(false)
        try {
            for (const prompt of [claude.getSystemPrompt(), codex.getCodexSystemPrompt({}), opencode.getTitleInstruction({})]) {
                expect(prompt).not.toContain('display_image')
                expect(prompt).not.toContain('display_video')
                expect(prompt).not.toContain('display_media')
                expect(prompt).not.toContain('Web/PWA')
                expect(prompt).toContain('change_title')
                expect(prompt).toContain('hapi job run')
            }
            // Native ACP sessions discover change_title through MCP tool
            // descriptions (#2416): their prompt carries jobs + skill lookup
            // but no per-tool guidance.
            const nativePrompt = opencode.getOpencodeNativeToolInstruction({})
            expect(nativePrompt).not.toContain('display_image')
            expect(nativePrompt).not.toContain('change_title')
            expect(nativePrompt).toContain('hapi job run')
        } finally {
            restore()
        }
    })

    it('keeps the citation tool steer by default', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(false)
        try {
            expect(claude.getSystemPrompt()).toContain('Call "mcp__hapi__inspect_peer"')
            expect(codex.TITLE_INSTRUCTION).toContain('Call "functions.hapi__inspect_peer"')
            expect(opencode.TITLE_INSTRUCTION).toContain('Call "hapi_inspect_peer"')
            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).toContain('Call "hapi_inspect_peer"')
            for (const prompt of [claude.getSystemPrompt(), codex.TITLE_INSTRUCTION, opencode.TITLE_INSTRUCTION, opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION]) {
                expect(prompt).toContain('auto (default)')
                expect(prompt).toContain('Prefer auto for routine collaboration')
                expect(prompt).toContain('steer: use for important, time-sensitive findings the peer needs to know now')
                expect(prompt).toContain('does not abort the current turn or guarantee an immediate response')
                expect(prompt).toContain('do not resend automatically')
            }
        } finally {
            restore()
        }
    })

    it('resolves the disabled notice at call time from the hub preference', async () => {
        const { claude, codex, opencode, peerTools, restore } = await importFlavorPrompts(false)
        try {
            peerTools.applyHubPeerToolsDisabled(true)
            expect(claude.getSystemPrompt()).toContain('are disabled on this machine')
            expect(claude.getSystemPrompt()).not.toContain('Call "mcp__hapi__inspect_peer"')
            expect(codex.getCodexSystemPrompt()).toContain('are disabled on this machine')
            expect(codex.getCodexSystemPrompt()).not.toContain('Call "functions.hapi__inspect_peer"')
            expect(opencode.getTitleInstruction()).toContain('are disabled on this machine')
            expect(opencode.getTitleInstruction()).not.toContain('Call "hapi_inspect_peer"')
            expect(opencode.getOpencodeNativeToolInstruction()).toContain('are disabled on this machine')
            expect(opencode.getOpencodeNativeToolInstruction()).not.toContain('Call "hapi_inspect_peer"')
        } finally {
            peerTools.resetPeerToolsForTests()
            restore()
        }
    })

    it('lets an explicit env value override the hub preference in both directions', async () => {
        const prev = process.env.HAPI_DISABLE_PEER_TOOLS
        try {
            vi.resetModules()
            process.env.HAPI_DISABLE_PEER_TOOLS = '0'
            const [claude, peerTools] = await Promise.all([
                import('./systemPrompt'),
                import('../../modules/common/peerTools'),
            ])
            peerTools.applyHubPeerToolsDisabled(true)
            // hub says disabled but the operator explicitly re-enabled via env
            expect(claude.getSystemPrompt()).toContain('Call "mcp__hapi__inspect_peer"')
            expect(claude.getSystemPrompt()).not.toContain('are disabled on this machine')

            peerTools.applyHubPeerToolsDisabled(false)
            process.env.HAPI_DISABLE_PEER_TOOLS = '1'
            expect(claude.getSystemPrompt()).not.toContain('Call "mcp__hapi__inspect_peer"')
            expect(claude.getSystemPrompt()).toContain('are disabled on this machine')

            peerTools.resetPeerToolsForTests()
        } finally {
            if (prev === undefined) delete process.env.HAPI_DISABLE_PEER_TOOLS
            else process.env.HAPI_DISABLE_PEER_TOOLS = prev
        }
    })
})

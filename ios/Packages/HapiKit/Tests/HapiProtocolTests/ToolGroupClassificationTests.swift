import Testing
@testable import HapiProtocol

/// Normalized tool classification (port of the web `toolGroups.ts` name
/// tables): identifiers are matched lowercased with separators stripped, so
/// DSH's raw lowercase snake tool names (`bash`, `apply_patch`, `todo_write`)
/// classify into the same buckets as the exact-case spellings.
@Suite("Tool group classification")
struct ToolGroupClassificationTests {
    private func tool(_ name: String, nativeKind: String? = nil) -> ToolCallBlock {
        ToolCallBlock(
            id: name, localId: nil, createdAt: 0, invokedAt: nil,
            durationMs: nil, usage: nil, model: nil,
            tool: ChatToolCall(
                id: name, name: name, state: .completed, input: nil,
                createdAt: 0, nativeKind: nativeKind
            ),
            children: [], meta: nil
        )
    }

    // MARK: - DSH raw lowercase snake names

    @Test func dshToolNamesClassifyThroughNormalization() {
        #expect(getToolGroupActionKind(tool("bash")) == .command)
        #expect(getToolGroupActionKind(tool("read")) == .read)
        #expect(getToolGroupActionKind(tool("grep")) == .search)
        #expect(getToolGroupActionKind(tool("glob")) == .search)
        #expect(getToolGroupActionKind(tool("edit")) == .mutation)
        #expect(getToolGroupActionKind(tool("write")) == .mutation)
        #expect(getToolGroupActionKind(tool("apply_patch")) == .mutation)
        #expect(getToolGroupActionKind(tool("web_fetch")) == .web)
        #expect(getToolGroupActionKind(tool("web_search")) == .web)
        // Not in any web table — stays `.other` (web parity).
        #expect(getToolGroupActionKind(tool("read_image")) == .other)
    }

    // MARK: - Exact-case spellings still classify

    @Test func exactCaseNamesKeepTheirBuckets() {
        #expect(getToolGroupActionKind(tool("Read")) == .read)
        #expect(getToolGroupActionKind(tool("NotebookRead")) == .read)
        #expect(getToolGroupActionKind(tool("Grep")) == .search)
        #expect(getToolGroupActionKind(tool("Glob")) == .search)
        #expect(getToolGroupActionKind(tool("LS")) == .search)
        #expect(getToolGroupActionKind(tool("Bash")) == .command)
        #expect(getToolGroupActionKind(tool("CodexBash")) == .command)
        #expect(getToolGroupActionKind(tool("shell_command")) == .command)
        #expect(getToolGroupActionKind(tool("run_shell_command")) == .command)
        #expect(getToolGroupActionKind(tool("Edit")) == .mutation)
        #expect(getToolGroupActionKind(tool("MultiEdit")) == .mutation)
        #expect(getToolGroupActionKind(tool("Write")) == .mutation)
        #expect(getToolGroupActionKind(tool("NotebookEdit")) == .mutation)
        #expect(getToolGroupActionKind(tool("CodexPatch")) == .mutation)
        #expect(getToolGroupActionKind(tool("CodexDiff")) == .mutation)
        #expect(getToolGroupActionKind(tool("WebFetch")) == .web)
        #expect(getToolGroupActionKind(tool("WebSearch")) == .web)
    }

    // MARK: - Native kinds win over names (web precedence)

    @Test func nativeKindTakesPrecedenceOverTheName() {
        #expect(getToolGroupActionKind(tool("bash", nativeKind: "read")) == .read)
        #expect(getToolGroupActionKind(tool("Read", nativeKind: "shell")) == .command)
        #expect(getToolGroupActionKind(tool("unknown-tool", nativeKind: "webfetch")) == .web)
        #expect(getToolGroupActionKind(tool("unknown-tool", nativeKind: "execute")) == .command)
        #expect(getToolGroupActionKind(tool("unknown-tool", nativeKind: "replace")) == .mutation)
        // DSH tool calls always carry kind `other` — not in any native set,
        // so classification falls through to the name tables.
        #expect(getToolGroupActionKind(tool("bash", nativeKind: "other")) == .command)
        #expect(getToolGroupActionKind(tool("read", nativeKind: "other")) == .read)
    }

    // MARK: - Eligibility through normalization

    @Test func planAndMilestoneToolsStayOutOfGroups() {
        #expect(!isEligibleForToolGrouping(tool("todo_write")))
        #expect(!isEligibleForToolGrouping(tool("TodoWrite")))
        #expect(!isEligibleForToolGrouping(tool("update_plan")))
        #expect(!isEligibleForToolGrouping(tool("updatePlan")))
        #expect(!isEligibleForToolGrouping(tool("ExitPlanMode")))
        #expect(!isEligibleForToolGrouping(tool("CodexReasoning")))
        #expect(!isEligibleForToolGrouping(tool("Task")))
        #expect(!isEligibleForToolGrouping(tool("spawn_agent")))
        #expect(!isEligibleForToolGrouping(tool("AgyTaskLog")))
        // Newly ported milestone rows (web has them; the exact-case table did not).
        #expect(!isEligibleForToolGrouping(tool("agy_async_task")))
        #expect(!isEligibleForToolGrouping(tool("agy_error")))
    }

    @Test func ordinaryToolsRemainEligible() {
        #expect(isEligibleForToolGrouping(tool("bash")))
        #expect(isEligibleForToolGrouping(tool("read")))
        #expect(isEligibleForToolGrouping(tool("apply_patch")))
        #expect(isEligibleForToolGrouping(tool("WebFetch")))
    }
}

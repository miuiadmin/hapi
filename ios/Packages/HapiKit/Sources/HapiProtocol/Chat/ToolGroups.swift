import Foundation

// Port of web/src/chat/toolGroups.ts — collapsing runs of low-signal tool
// calls into tool-group blocks, plus the codex-exploration grouping family
// (which needs the CodexBash command_actions parsing from
// web/src/chat/codexCommandPresentation.ts, ported in ToolPresentation.swift).

// MARK: - Tool input access (web/src/lib/toolInputUtils.ts)

/// Port of `getInputString` — non-string values yield nil; the `Any` variant
/// additionally skips empty strings (JS truthiness).
func getInputString(_ input: JSONValue?, _ key: String) -> String? {
    input?.objectValue?[key]?.stringValue
}

/// Port of `getInputStringAny`.
func getInputStringAny(_ input: JSONValue?, _ keys: [String]) -> String? {
    for key in keys {
        if let value = getInputString(input, key), !value.isEmpty {
            return value
        }
    }
    return nil
}

// MARK: - Group model

public enum ToolGroupActionKind: String, Equatable, Sendable, CaseIterable {
    case read
    case search
    case command
    case mutation
    case web
    case other
}

/// Port of `ToolGroupSummary`.
public struct ToolGroupSummary: Equatable, Sendable {
    public var totalTools: Int
    public var countsByKind: [ToolGroupActionKind: Int]
    public var fileTargets: [String]
    public var commandTargets: [String]
    public var searchTargets: [String]
    public var urlTargets: [String]
    public var otherTargets: [String]
    public var errorCount: Int
    public var runningCount: Int
    public var pendingCount: Int
}

/// Port of `ToolGroupBlock`.
public struct ToolGroupBlock: Equatable, Sendable {
    public var id: String
    public var createdAt: Int
    public var invokedAt: Int?
    public var firstToolId: String
    public var lastToolId: String
    public var tools: [ToolCallBlock]
    public var defaultOpen: Bool
    public var historyState: HistoryState
    public var needsOlderHistory: Bool
    public var activityTitle: String?
    public var presentationMode: PresentationMode
    public var summary: ToolGroupSummary

    public enum HistoryState: String, Equatable, Sendable {
        case complete
        case needsOlderHistory = "needs-older-history"
    }

    public enum PresentationMode: String, Equatable, Sendable {
        case `default`
        case codexExploration = "codex-exploration"
    }
}

/// Port of `VisibleChatBlock`.
public enum VisibleChatBlock: Equatable, Sendable {
    case block(ChatBlock)
    case toolGroup(ToolGroupBlock)
}

public enum VisibleChatBlockRole: String, Equatable, Sendable {
    case user
    case assistant
    case system
}

/// Port of `visibleBlockRole`.
public func visibleBlockRole(_ block: VisibleChatBlock) -> VisibleChatBlockRole {
    switch block {
    case .toolGroup:
        return .assistant
    case .block(let chatBlock):
        switch chatBlock {
        case .userText: return .user
        case .agentEvent: return .system
        case .cliOutput(let cliOutput): return cliOutput.source == .user ? .user : .assistant
        default: return .assistant
        }
    }
}

/// Port of `ToolGroupingOptions`.
public struct ToolGroupingOptions: Sendable {
    public var hasMoreMessages: Bool
    public var previousGroups: [ToolGroupBlock]
    /// Tri-state like the TS optional boolean: only an explicit `false`
    /// opens codex-exploration groups by default.
    public var codexExplorationCollapsed: Bool?

    public init(hasMoreMessages: Bool, previousGroups: [ToolGroupBlock] = [], codexExplorationCollapsed: Bool? = nil) {
        self.hasMoreMessages = hasMoreMessages
        self.previousGroups = previousGroups
        self.codexExplorationCollapsed = codexExplorationCollapsed
    }
}

// MARK: - Name tables

/// Port of `normalizeToolIdentifier` — tool names/kinds are matched after
/// trimming, lowercasing and stripping every non-alphanumeric character, so
/// every spelling variant of a tool (`TodoWrite`, `todo_write`, `TODO-WRITE`)
/// resolves to the same identifier (`todowrite`). DSH reports raw lowercase
/// snake names (`bash`, `read`, `apply_patch`, `todo_write`), which only
/// classify through this normalization.
func normalizeToolIdentifier(_ value: String?) -> String {
    guard let value else { return "" }
    let lowercased = value.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    return String(String.UnicodeScalarView(
        lowercased.unicodeScalars.filter { scalar in
            (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
        }
    ))
}

private let planToolNames: Set<String> = [
    "todowrite",
    // hermes todo_list — same plan-milestone treatment as dsh's
    // todo_write: keep it standalone, never grouped.
    "todolist",
    "updateplan",
    "exitplanmode",
    "codexreasoning",
]

private let milestoneToolNames: Set<String> = [
    "task",
    "agent",
    "codexagent",
    "teamcreate",
    "teamdelete",
    "sendmessage",
    // agy's transitional task-log chip — keep it standalone (like SendMessage)
    // so it reads as a thin marker instead of being folded into a tool group.
    "agytasklog",
    "agyasynctask",
    "agyerror",
    "skill",
    "spawnagent",
    "sendinput",
    "resumeagent",
    "followuptask",
    "waitagent",
    "closeagent",
    "interruptagent",
    "listagents",
]

private let interactiveToolNames: Set<String> = [
    "codexpermission",
]

private let readToolNames: Set<String> = [
    "read",
    "notebookread",
    "readfile",
    "viewfile",
    "fileread",
]

private let searchToolNames: Set<String> = [
    "search",
    "grep",
    "glob",
    // Berry's `find` arrives with kind 'other' (not its native search kind),
    // so only the name fallback classifies it — kept in the search bucket.
    "find",
    "ls",
    "listdir",
    "listfiles",
    "searchfiles",
    "grepsearch",
    "contentsearch",
]

private let commandToolNames: Set<String> = [
    "bash",
    "codexbash",
    "shell",
    "shellcommand",
    "runshellcommand",
    "runcommand",
    "executecommand",
    "terminal",
]

private let mutationToolNames: Set<String> = [
    "edit",
    "multiedit",
    "write",
    "notebookedit",
    "codexpatch",
    "codexdiff",
    "editfile",
    "writefile",
    "replacefilecontent",
    "writetofile",
    "applypatch",
    "patch",
]

private let webToolNames: Set<String> = [
    "webfetch",
    "websearch",
    // hermes web_extract — same URL-driven bucket as web_fetch.
    "webextract",
    "fetchurl",
    "openurl",
    "urlfetch",
]

private let readNativeKinds: Set<String> = ["read", "readfile", "fileread", "view", "viewfile"]
private let searchNativeKinds: Set<String> = ["search", "grep", "find", "glob"]
private let commandNativeKinds: Set<String> = [
    "execute", "shell", "bash", "run", "runshell", "runshellcommand", "cmd", "terminal", "command",
]
private let mutationNativeKinds: Set<String> = ["edit", "write", "writefile", "replace", "fileedit", "modify", "patch"]
private let webNativeKinds: Set<String> = ["web", "fetch", "webfetch", "websearch", "openurl"]

/// Port of `isAskUserQuestionToolName` (web ToolCard/askUserQuestion.ts).
public func isAskUserQuestionToolName(_ toolName: String) -> Bool {
    toolName == "AskUserQuestion" || toolName == "ask_user_question" || toolName == "CursorAskQuestion"
        // DSH surfaces hapi MCP bridge tools under mcp__<server>__<name>; the
        // transcript card renders the questions read-only while the pending
        // AskUserQuestion permission card carries the interactive footer.
        || toolName == "mcp__hapi__ask_user_question"
}

/// Port of `isRequestUserInputToolName` (web ToolCard/requestUserInput.ts).
public func isRequestUserInputToolName(_ toolName: String) -> Bool {
    toolName == "request_user_input"
}

// MARK: - Summaries

private func pushUnique(_ target: inout [String], _ value: String?) {
    guard let value, !value.isEmpty else { return }
    if target.contains(value) { return }
    target.append(value)
}

/// Port of `normalizeCommandInput`.
private func normalizeCommandInput(_ input: JSONValue?) -> String? {
    if let direct = getInputStringAny(input, ["command", "cmd"]) { return direct }

    guard let command = input?.objectValue?["command"]?.arrayValue else { return nil }
    let parts = command.compactMap { part -> String? in
        guard let text = part.stringValue, !text.isEmpty else { return nil }
        return text
    }
    return parts.isEmpty ? nil : parts.joined(separator: " ")
}

/// Port of `getToolGroupActionKind`.
public func getToolGroupActionKind(_ block: ToolCallBlock) -> ToolGroupActionKind {
    let nativeKind = normalizeToolIdentifier(block.tool.nativeKind)
    if webNativeKinds.contains(nativeKind) { return .web }
    if readNativeKinds.contains(nativeKind) { return .read }
    if searchNativeKinds.contains(nativeKind) { return .search }
    if commandNativeKinds.contains(nativeKind) { return .command }
    if mutationNativeKinds.contains(nativeKind) { return .mutation }

    let name = normalizeToolIdentifier(block.tool.name)
    if webToolNames.contains(name) { return .web }
    if readToolNames.contains(name) { return .read }
    if searchToolNames.contains(name) { return .search }
    if commandToolNames.contains(name) { return .command }
    if mutationToolNames.contains(name) { return .mutation }
    return .other
}

private func getPrimaryFileTarget(_ block: ToolCallBlock) -> String? {
    getInputStringAny(block.tool.input, ["file_path", "path", "file", "filePath", "notebook_path", "name"])
}

private func getPrimarySearchTarget(_ block: ToolCallBlock) -> String? {
    getInputStringAny(block.tool.input, ["pattern", "query"])
}

private func getPrimaryUrlTarget(_ block: ToolCallBlock) -> String? {
    getInputStringAny(block.tool.input, ["url"])
}

private func getPrimaryOtherTarget(_ block: ToolCallBlock) -> String? {
    if let fileTarget = getPrimaryFileTarget(block) { return fileTarget }
    if let searchTarget = getPrimarySearchTarget(block) { return searchTarget }
    if let commandTarget = normalizeCommandInput(block.tool.input) { return commandTarget }
    if let urlTarget = getPrimaryUrlTarget(block) { return urlTarget }
    return block.tool.name
}

/// Port of `summarizeToolGroup`.
private func summarizeToolGroup(_ tools: [ToolCallBlock]) -> ToolGroupSummary {
    var countsByKind: [ToolGroupActionKind: Int] = [
        .read: 0, .search: 0, .command: 0, .mutation: 0, .web: 0, .other: 0,
    ]
    var fileTargets: [String] = []
    var commandTargets: [String] = []
    var searchTargets: [String] = []
    var urlTargets: [String] = []
    var otherTargets: [String] = []
    var errorCount = 0
    var runningCount = 0
    var pendingCount = 0

    for tool in tools {
        let kind = getToolGroupActionKind(tool)
        countsByKind[kind, default: 0] += 1

        switch tool.tool.state {
        case .error: errorCount += 1
        case .running: runningCount += 1
        case .pending: pendingCount += 1
        case .completed: break
        }

        if kind == .read || kind == .mutation {
            pushUnique(&fileTargets, getPrimaryFileTarget(tool))
            continue
        }
        if kind == .search {
            pushUnique(&searchTargets, getPrimarySearchTarget(tool))
            continue
        }
        if kind == .command {
            pushUnique(&commandTargets, normalizeCommandInput(tool.tool.input))
            continue
        }
        if kind == .web {
            pushUnique(&urlTargets, getPrimaryUrlTarget(tool) ?? getPrimarySearchTarget(tool))
            continue
        }
        pushUnique(&otherTargets, getPrimaryOtherTarget(tool))
    }

    return ToolGroupSummary(
        totalTools: tools.count,
        countsByKind: countsByKind,
        fileTargets: fileTargets,
        commandTargets: commandTargets,
        searchTargets: searchTargets,
        urlTargets: urlTargets,
        otherTargets: otherTargets,
        errorCount: errorCount,
        runningCount: runningCount,
        pendingCount: pendingCount
    )
}

// MARK: - Eligibility

private func isInteractiveToolBlock(_ block: ToolCallBlock) -> Bool {
    interactiveToolNames.contains(normalizeToolIdentifier(block.tool.name))
        || block.tool.permission?.status == .pending
        || isAskUserQuestionToolName(block.tool.name)
        || isRequestUserInputToolName(block.tool.name)
}

/// Port of `isEligibleForToolGrouping`.
public func isEligibleForToolGrouping(_ block: ToolCallBlock) -> Bool {
    let normalizedName = normalizeToolIdentifier(block.tool.name)
    if isSubagentToolName(block.tool.name) { return false }
    if planToolNames.contains(normalizedName) { return false }
    if milestoneToolNames.contains(normalizedName) { return false }
    if isInteractiveToolBlock(block) { return false }
    // Classification selects the group family; shared Codex `unknown`
    // agent commands still belong in ordinary groups. User shell stays separate.
    if block.tool.name == "CodexBash"
        && getInputStringAny(block.tool.input, ["command_source", "commandSource"])?.lowercased() == "usershell" {
        return false
    }
    return true
}

private func getGroupingFamily(_ block: ToolCallBlock) -> ToolGroupBlock.PresentationMode? {
    guard isEligibleForToolGrouping(block) else { return nil }
    return isCodexExplorationTool(block) ? .codexExploration : .default
}

/// Boundary-based identity reuse, with native list uniqueness guarantees:
/// splits may claim an old ID only once; fresh runs cannot steal a later
/// group's historical ID. No row-index or random IDs (scroll-anchor stability).
private func createToolGroupId(
    tools: [ToolCallBlock],
    needsOlderHistory: Bool,
    previousGroups: [ToolGroupBlock],
    reservedGroupIds: Set<String>,
    usedIds: inout Set<String>
) -> String {
    let firstToolId = tools.first?.id ?? "unknown"
    let lastToolId = tools.last?.id ?? firstToolId

    if let previous = previousGroups.first(where: {
        ($0.firstToolId == firstToolId || $0.lastToolId == lastToolId) && !usedIds.contains($0.id)
    }) {
        usedIds.insert(previous.id)
        return previous.id
    }

    let boundaries = needsOlderHistory ? [lastToolId, firstToolId] : [firstToolId, lastToolId]
    for boundary in boundaries {
        let candidate = "tool-group:\(boundary)"
        if !reservedGroupIds.contains(candidate), usedIds.insert(candidate).inserted { return candidate }
    }
    let base = "tool-group:\(boundaries[0])"
    var suffix = 2
    var candidate = "\(base)#\(suffix)"
    while reservedGroupIds.contains(candidate) || usedIds.contains(candidate) {
        suffix += 1
        candidate = "\(base)#\(suffix)"
    }
    usedIds.insert(candidate)
    return candidate
}

// MARK: - buildVisibleChatBlocks

/// Port of `buildVisibleChatBlocks`.
public func buildVisibleChatBlocks(
    _ blocks: [ChatBlock],
    options: ToolGroupingOptions
) -> [VisibleChatBlock] {
    var visibleBlocks: [VisibleChatBlock] = []
    let previousGroups = options.previousGroups
    let reservedGroupIds = Set(previousGroups.map(\.id))
    // Includes flattened tool children as well as ordinary display blocks.
    var usedIds = Set(blocks.map(\.id))

    var index = 0
    while index < blocks.count {
        let block = blocks[index]
        guard case .toolCall(let toolBlock) = block else {
            visibleBlocks.append(.block(block))
            index += 1
            continue
        }
        guard let groupingFamily = getGroupingFamily(toolBlock) else {
            visibleBlocks.append(.block(block))
            index += 1
            continue
        }

        var tools: [ToolCallBlock] = [toolBlock]
        var cursor = index + 1
        while cursor < blocks.count {
            guard case .toolCall(let candidate) = blocks[cursor],
                  getGroupingFamily(candidate) == groupingFamily else {
                break
            }
            tools.append(candidate)
            cursor += 1
        }

        if tools.count < 2 && groupingFamily != .codexExploration {
            visibleBlocks.append(.block(block))
            index += 1
            continue
        }

        let startsAtOldestVisibleBoundary = visibleBlocks.isEmpty
        let needsOlderHistory = options.hasMoreMessages && startsAtOldestVisibleBoundary
        let activityTitle: String? = {
            guard case .block(.toolCall(let previousBlock))? = visibleBlocks.last,
                  previousBlock.tool.name == "CodexReasoning" else { return nil }
            return getInputStringAny(previousBlock.tool.input, ["title"])
        }()
        visibleBlocks.append(.toolGroup(ToolGroupBlock(
            id: createToolGroupId(tools: tools, needsOlderHistory: needsOlderHistory,
                                  previousGroups: previousGroups, reservedGroupIds: reservedGroupIds, usedIds: &usedIds),
            createdAt: tools[0].createdAt,
            invokedAt: tools[0].invokedAt,
            firstToolId: tools[0].id,
            lastToolId: tools[tools.count - 1].id,
            tools: tools,
            defaultOpen: groupingFamily == .codexExploration && options.codexExplorationCollapsed == false,
            historyState: needsOlderHistory ? .needsOlderHistory : .complete,
            needsOlderHistory: needsOlderHistory,
            activityTitle: activityTitle,
            presentationMode: groupingFamily,
            summary: summarizeToolGroup(tools)
        )))
        index = cursor
    }

    return visibleBlocks
}

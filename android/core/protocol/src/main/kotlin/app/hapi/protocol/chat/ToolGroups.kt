package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** Port of `web/src/chat/toolGroups.ts` — the visible-layer tool grouping. */

enum class ToolGroupActionKind { READ, SEARCH, COMMAND, MUTATION, WEB, OTHER }

data class ToolGroupSummary(
    val totalTools: Int,
    val countsByKind: Map<ToolGroupActionKind, Int>,
    val fileTargets: List<String>,
    val commandTargets: List<String>,
    val searchTargets: List<String>,
    val urlTargets: List<String>,
    val otherTargets: List<String>,
    val errorCount: Int,
    val runningCount: Int,
    val pendingCount: Int,
)

class ToolGroupBlock(
    val id: String,
    val createdAt: Long,
    val invokedAt: Long?,
    val firstToolId: String,
    val lastToolId: String,
    val tools: List<ToolCallBlock>,
    val defaultOpen: Boolean,
    /** `'complete' | 'needs-older-history'`. */
    val historyState: String,
    val needsOlderHistory: Boolean,
    val activityTitle: String?,
    /** `'default' | 'codex-exploration'`. */
    val presentationMode: String,
    val roundSummary: RoundSummary? = null,
    val summary: ToolGroupSummary,
) : VisibleChatBlock {
    val kind: String get() = "tool-group"
}

data class ToolGroupingOptions(
    val hasMoreMessages: Boolean,
    val previousGroups: List<ToolGroupBlock> = emptyList(),
    val codexExplorationCollapsed: Boolean? = null,
)

/** The role a block renders under in the thread. */
fun visibleBlockRole(block: VisibleChatBlock): String = when {
    block is UserTextBlock -> "user"
    block is AgentEventBlock -> "system"
    block is CliOutputBlock -> if (block.source == "user") "user" else "assistant"
    else -> "assistant"
}

/**
 * Port of web `normalizeToolIdentifier` — tool names/kinds are matched after
 * trimming, lowercasing and stripping every non-alphanumeric character, so
 * every spelling variant of a tool (`TodoWrite`, `todo_write`, `TODO-WRITE`)
 * resolves to the same identifier (`todowrite`). DSH reports raw lowercase
 * snake names (`bash`, `read`, `apply_patch`, `todo_write`), which only
 * classify through this normalization.
 */
fun normalizeToolIdentifier(value: String?): String {
    if (value == null) return ""
    val lower = value.trim().lowercase()
    return buildString {
        for (char in lower) {
            if (char in 'a'..'z' || char in '0'..'9') append(char)
        }
    }
}

private val PLAN_TOOL_NAMES = setOf(
    "todowrite",
    "updateplan",
    "exitplanmode",
    "codexreasoning",
)

private val MILESTONE_TOOL_NAMES = setOf(
    "task",
    "agent",
    "codexagent",
    "teamcreate",
    "teamdelete",
    "sendmessage",
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
)

private val INTERACTIVE_TOOL_NAMES = setOf(
    "codexpermission",
)

private val READ_TOOL_NAMES = setOf(
    "read",
    "notebookread",
    "readfile",
    "viewfile",
    "fileread",
)

private val SEARCH_TOOL_NAMES = setOf(
    "search",
    "grep",
    "glob",
    "ls",
    "listdir",
    "listfiles",
    "searchfiles",
    "grepsearch",
    "contentsearch",
)

private val COMMAND_TOOL_NAMES = setOf(
    "bash",
    "codexbash",
    "shell",
    "shellcommand",
    "runshellcommand",
    "runcommand",
    "executecommand",
    "terminal",
)

private val MUTATION_TOOL_NAMES = setOf(
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
)

private val WEB_TOOL_NAMES = setOf(
    "webfetch",
    "websearch",
    "fetchurl",
    "openurl",
    "urlfetch",
)

private val READ_NATIVE_KINDS = setOf("read", "readfile", "fileread", "view", "viewfile")
private val SEARCH_NATIVE_KINDS = setOf("search", "grep", "find", "glob")
private val COMMAND_NATIVE_KINDS = setOf(
    "execute", "shell", "bash", "run", "runshell", "runshellcommand", "cmd", "terminal", "command",
)
private val MUTATION_NATIVE_KINDS = setOf("edit", "write", "writefile", "replace", "fileedit", "modify", "patch")
private val WEB_NATIVE_KINDS = setOf("web", "fetch", "webfetch", "websearch", "openurl")

private fun pushUnique(target: MutableList<String>, value: String?) {
    if (value.isNullOrEmpty()) return
    if (target.contains(value)) return
    target.add(value)
}

private fun normalizeCommandInput(input: JsonElement?): String? {
    val direct = getInputStringAny(input, listOf("command", "cmd"))
    if (direct != null) return direct

    val record = asObject(input) ?: return null
    val command = record["command"] as? JsonArray ?: return null

    val parts = command.mapNotNull { part ->
        (part as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
    }
    return if (parts.isNotEmpty()) parts.joinToString(" ") else null
}

fun getToolGroupActionKind(block: ToolCallBlock): ToolGroupActionKind {
    val nativeKind = normalizeToolIdentifier(block.tool.nativeKind)
    if (nativeKind in WEB_NATIVE_KINDS) return ToolGroupActionKind.WEB
    if (nativeKind in READ_NATIVE_KINDS) return ToolGroupActionKind.READ
    if (nativeKind in SEARCH_NATIVE_KINDS) return ToolGroupActionKind.SEARCH
    if (nativeKind in COMMAND_NATIVE_KINDS) return ToolGroupActionKind.COMMAND
    if (nativeKind in MUTATION_NATIVE_KINDS) return ToolGroupActionKind.MUTATION

    val name = normalizeToolIdentifier(block.tool.name)
    if (name in WEB_TOOL_NAMES) return ToolGroupActionKind.WEB
    if (name in READ_TOOL_NAMES) return ToolGroupActionKind.READ
    if (name in SEARCH_TOOL_NAMES) return ToolGroupActionKind.SEARCH
    if (name in COMMAND_TOOL_NAMES) return ToolGroupActionKind.COMMAND
    if (name in MUTATION_TOOL_NAMES) return ToolGroupActionKind.MUTATION
    return ToolGroupActionKind.OTHER
}

private fun getPrimaryFileTarget(block: ToolCallBlock): String? =
    getInputStringAny(block.tool.input, listOf("file_path", "path", "file", "filePath", "notebook_path", "name"))

private fun getPrimarySearchTarget(block: ToolCallBlock): String? =
    getInputStringAny(block.tool.input, listOf("pattern", "query"))

private fun getPrimaryUrlTarget(block: ToolCallBlock): String? =
    getInputStringAny(block.tool.input, listOf("url"))

private fun getPrimaryOtherTarget(block: ToolCallBlock): String? {
    getPrimaryFileTarget(block)?.let { return it }
    getPrimarySearchTarget(block)?.let { return it }
    normalizeCommandInput(block.tool.input)?.let { return it }
    getPrimaryUrlTarget(block)?.let { return it }
    return block.tool.name
}

private fun summarizeToolGroup(tools: List<ToolCallBlock>): ToolGroupSummary {
    val countsByKind = linkedMapOf(
        ToolGroupActionKind.READ to 0,
        ToolGroupActionKind.SEARCH to 0,
        ToolGroupActionKind.COMMAND to 0,
        ToolGroupActionKind.MUTATION to 0,
        ToolGroupActionKind.WEB to 0,
        ToolGroupActionKind.OTHER to 0,
    )
    val fileTargets = mutableListOf<String>()
    val commandTargets = mutableListOf<String>()
    val searchTargets = mutableListOf<String>()
    val urlTargets = mutableListOf<String>()
    val otherTargets = mutableListOf<String>()
    var errorCount = 0
    var runningCount = 0
    var pendingCount = 0

    for (tool in tools) {
        val kind = getToolGroupActionKind(tool)
        countsByKind[kind] = (countsByKind[kind] ?: 0) + 1

        when (tool.tool.state) {
            ToolState.ERROR -> errorCount += 1
            ToolState.RUNNING -> runningCount += 1
            ToolState.PENDING -> pendingCount += 1
        }

        when (kind) {
            ToolGroupActionKind.READ, ToolGroupActionKind.MUTATION -> pushUnique(fileTargets, getPrimaryFileTarget(tool))
            ToolGroupActionKind.SEARCH -> pushUnique(searchTargets, getPrimarySearchTarget(tool))
            ToolGroupActionKind.COMMAND -> pushUnique(commandTargets, normalizeCommandInput(tool.tool.input))
            ToolGroupActionKind.WEB -> pushUnique(urlTargets, getPrimaryUrlTarget(tool) ?: getPrimarySearchTarget(tool))
            ToolGroupActionKind.OTHER -> pushUnique(otherTargets, getPrimaryOtherTarget(tool))
        }
    }

    return ToolGroupSummary(
        totalTools = tools.size,
        countsByKind = countsByKind,
        fileTargets = fileTargets,
        commandTargets = commandTargets,
        searchTargets = searchTargets,
        urlTargets = urlTargets,
        otherTargets = otherTargets,
        errorCount = errorCount,
        runningCount = runningCount,
        pendingCount = pendingCount,
    )
}

private fun isInteractiveToolBlock(block: ToolCallBlock): Boolean =
    normalizeToolIdentifier(block.tool.name) in INTERACTIVE_TOOL_NAMES
        || block.tool.permission?.status == "pending"
        || isAskUserQuestionToolName(block.tool.name)
        || isRequestUserInputToolName(block.tool.name)

fun isEligibleForToolGrouping(block: ToolCallBlock): Boolean {
    val normalizedName = normalizeToolIdentifier(block.tool.name)
    if (isSubagentToolName(block.tool.name)) return false
    if (normalizedName in PLAN_TOOL_NAMES) return false
    if (normalizedName in MILESTONE_TOOL_NAMES) return false
    if (isInteractiveToolBlock(block)) return false
    // Classification selects the group family; shared Codex `unknown`
    // agent commands still belong in ordinary groups. User shell stays separate.
    if (block.tool.name == "CodexBash"
        && getInputStringAny(block.tool.input, listOf("command_source", "commandSource"))?.lowercase() == "usershell"
    ) {
        return false
    }
    return true
}

private fun getGroupingFamily(block: ToolCallBlock): String? {
    if (!isEligibleForToolGrouping(block)) return null
    return if (isCodexExplorationTool(block)) "codex-exploration" else "default"
}

private fun createToolGroupId(
    tools: List<ToolCallBlock>,
    needsOlderHistory: Boolean,
    previousGroups: List<ToolGroupBlock>,
    reservedGroupIds: Set<String>,
    usedIds: MutableSet<String>,
): String {
    val firstToolId = tools.firstOrNull()?.id ?: "unknown"
    val lastToolId = tools.lastOrNull()?.id ?: firstToolId

    // A split may share both old boundaries, but only one resulting group
    // can own the old identity. Reserve other old IDs against fresh runs.
    val previous = previousGroups.firstOrNull {
        (it.firstToolId == firstToolId || it.lastToolId == lastToolId) && it.id !in usedIds
    }
    if (previous != null) {
        usedIds.add(previous.id)
        return previous.id
    }

    val boundaries = if (needsOlderHistory) listOf(lastToolId, firstToolId) else listOf(firstToolId, lastToolId)
    for (boundary in boundaries) {
        val candidate = "tool-group:$boundary"
        if (candidate !in reservedGroupIds && usedIds.add(candidate)) return candidate
    }
    val base = "tool-group:${boundaries.first()}"
    var suffix = 2
    var candidate = "$base#$suffix"
    while (candidate in reservedGroupIds || candidate in usedIds) {
        suffix += 1
        candidate = "$base#$suffix"
    }
    usedIds.add(candidate)
    return candidate
}

fun isToolGroupBlock(block: VisibleChatBlock): Boolean = block is ToolGroupBlock

fun buildVisibleChatBlocks(
    blocks: List<ChatBlock>,
    options: ToolGroupingOptions,
): List<VisibleChatBlock> {
    val visibleBlocks = mutableListOf<VisibleChatBlock>()
    val previousGroups = options.previousGroups
    val reservedGroupIds = previousGroups.mapTo(mutableSetOf()) { it.id }
    val usedIds = blocks.mapTo(mutableSetOf()) { it.id }

    var index = 0
    while (index < blocks.size) {
        val block = blocks[index]
        if (block !is ToolCallBlock) {
            visibleBlocks.add(block)
            index += 1
            continue
        }
        val groupingFamily = getGroupingFamily(block)
        if (groupingFamily == null) {
            visibleBlocks.add(block)
            index += 1
            continue
        }

        val tools = mutableListOf(block)
        var cursor = index + 1
        while (cursor < blocks.size) {
            val candidate = blocks[cursor]
            if (candidate !is ToolCallBlock || getGroupingFamily(candidate) != groupingFamily) {
                break
            }
            tools.add(candidate)
            cursor += 1
        }

        if (tools.size < 2 && groupingFamily != "codex-exploration") {
            visibleBlocks.add(block)
            index += 1
            continue
        }

        val startsAtOldestVisibleBoundary = visibleBlocks.isEmpty()
        val needsOlderHistory = options.hasMoreMessages && startsAtOldestVisibleBoundary
        val previousBlock = visibleBlocks.lastOrNull()
        val activityTitle = if (previousBlock is ToolCallBlock && previousBlock.tool.name == "CodexReasoning") {
            getInputStringAny(previousBlock.tool.input, listOf("title"))
        } else {
            null
        }
        visibleBlocks.add(
            ToolGroupBlock(
                id = createToolGroupId(tools, needsOlderHistory, previousGroups, reservedGroupIds, usedIds),
                createdAt = tools.first().createdAt,
                invokedAt = tools.first().invokedAt,
                firstToolId = tools.first().id,
                lastToolId = tools.last().id,
                tools = tools,
                defaultOpen = groupingFamily == "codex-exploration" && options.codexExplorationCollapsed == false,
                historyState = if (needsOlderHistory) "needs-older-history" else "complete",
                needsOlderHistory = needsOlderHistory,
                activityTitle = activityTitle,
                presentationMode = groupingFamily,
                roundSummary = tools.first().roundSummary,
                summary = summarizeToolGroup(tools),
            )
        )
        index = cursor
    }

    return visibleBlocks
}

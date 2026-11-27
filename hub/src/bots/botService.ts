import { randomUUID } from 'node:crypto'
import {
    BOT_AGENT_FLAVORS,
    BOT_MAX_ITEMS,
    botHomeSlug,
    botKickoffMessage,
    buildBotItemCommentMessageLocalId,
    defaultBotPermissionMode,
    buildBotKickoffMessageLocalId,
    buildBotRequestNoticeMessageLocalId,
    defaultBotHomeDir,
    formatBotItemCommentMessage,
    formatBotRequestNoticeMessage,
    isAbsoluteHomePath,
    summarizeBotRequestArguments,
    type AgentStateRequest,
    type Bot,
    type BotItem,
    type BotItemAsk,
    type BotItemAskRequest,
    type BotItemCommentRequest,
    type BotItemEvent,
    type BotItemEventActor,
    type BotItemStatus,
    type BotSummary,
    type CreateBotItemRequest,
    type CreateBotRequest,
    type NeedsYouEntry,
    type PrepareBotHomeRequest,
    type PrepareBotHomeResponse,
    type UpdateBotItemRequest,
    type UpdateBotRequest,
    type BotWorker
} from '@hapi/protocol'
import type { Store } from '../store'
import type { PausedTask, StoredBot, StoredBotItem } from '../store/bots'

/**
 * Bots: what the hub does for a bot besides storing its record.
 *
 * - creating one: prepare the home folder on the chosen machine, open the
 *   home chat there, send the first-run message;
 * - the ledger: items, the bot's structured questions, the owner's answers
 *   (which wake the bot);
 * - "needs you": one list of everything waiting on the owner;
 * - telling a bot when one of its workers is stuck on a request.
 *
 * Every list the owner reads (the bot's counts, "needs you", its workers) is
 * derived from the rows, and every change to those rows is announced on the
 * event stream, so no surface has to poll.
 */

export type BotEvent =
    | { type: 'bots-changed'; namespace: string; botId?: string }
    | { type: 'bot-items-changed'; namespace: string; sessionId: string; botId: string; itemId?: string }

export class BotError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string
    ) {
        super(message)
        this.name = 'BotError'
    }
}

export type BotSessionView = {
    id: string
    name?: string | null
    active: boolean
    thinking: boolean
    agentState?: { requests?: Record<string, AgentStateRequest> | null } | null
}

export type BotServiceDeps = {
    store: Pick<Store, 'bots' | 'sessionReceipts'>
    getSession: (sessionId: string) => BotSessionView | null
    /** Whether the session exists and belongs to this namespace. */
    sessionInNamespace: (sessionId: string, namespace: string) => boolean
    getMachine: (machineId: string) => { id: string; namespace: string } | null
    isMachineOnline: (machineId: string) => boolean
    /** Sessions the bot's home chat is still waiting on a receipt from. */
    receiptChildrenOf: (parentSessionId: string) => string[]
    prepareHome: (machineId: string, request: PrepareBotHomeRequest) => Promise<PrepareBotHomeResponse>
    spawnHomeChat: (input: {
        /** The id the home chat gets; the bot is recorded under it first. */
        sessionId: string
        /** The home chat is named before the machine starts it, so its first run already knows the bot's name. */
        name: string
        machineId: string
        homeDir: string
        agent: string
        model: string | undefined
        permissionMode: string | undefined
        namespace: string
    }) => Promise<{ sessionId: string } | { error: string }>
    /**
     * Bring a message to a session. It is queued first and stays queued
     * whatever happens, then the session is woken (now, or when that becomes
     * possible). Rejects only when the session does not exist.
     */
    deliver: (sessionId: string, text: string, localId: string) => Promise<void>
    /**
     * Store a message for a session that is starting already, without
     * waking it: it takes the message when it attaches. Waking it here
     * would be asking for a second start of the same session.
     */
    queueMessage: (sessionId: string, text: string, localId: string) => Promise<void>
    /** Whether a message with this localId already exists in the session (queued or taken). */
    hasMessage: (sessionId: string, localId: string) => boolean
    permissionModesFor: (agent: string) => readonly string[]
    /**
     * The session's repeat/queue tasks: the state of each one, when it is due
     * next, the prompt it waits on, and what an edit by hand would change.
     */
    listTasks: (sessionId: string) => Array<{ id: string; state: string; nextRunAt: number | null; pendingLocalId: string | null; fingerprint: string }>
    /**
     * Pause or resume tasks the way the owner does from the bar. It resolves
     * once the hub is through with each: a pause takes a waiting prompt back
     * first, and that changes the task.
     */
    setTasksPaused: (sessionId: string, taskIds: string[], paused: boolean) => Promise<void>
    /**
     * Start paused tasks again where they were on their schedule before the
     * pause. (Resuming a task by hand runs it at once, which is right for a
     * person asking for it and wrong for a bot that was merely paused.)
     * Returns the tasks it had to leave paused, because the session holds its
     * cap of active tasks.
     */
    resumeTasksAt: (sessionId: string, tasks: Array<{ id: string; nextRunAt: number | null }>) => string[]
    /** The parent stopped holding receipts: deliver what was kept for it. */
    releaseReceipts: (parentSessionId: string) => void
    emit: (event: BotEvent) => void
    now?: () => number
    log?: (message: string, detail: Record<string, unknown>) => void
}

const OPEN_STATUSES: ReadonlySet<BotItemStatus> = new Set(['planned', 'working', 'waiting', 'needs_you'])
/** States in which a bot's home chat is the bot: still being created, running, or paused. */
const RUNNABLE_STATES: ReadonlySet<string> = new Set(['creating', 'active', 'paused'])
/** Statuses an item may be moved to directly; `needs_you` goes through `ask`. */
const MOVABLE_STATUSES: ReadonlySet<BotItemStatus> = new Set(['planned', 'working', 'waiting', 'done', 'canceled'])
/**
 * A creation still marked `creating` after this long belongs to a hub process
 * that is gone: preparing the folder, opening the home chat and sending the
 * first message take seconds.
 */
export const BOT_CREATION_STALE_MS = 10 * 60_000
export const BOT_HOME_CHAT_GONE_MESSAGE = 'Its home chat was deleted. Archive this bot and create a new one to start over.'

function toWireBot(bot: StoredBot): Bot {
    return {
        id: bot.id,
        name: bot.name,
        purpose: bot.purpose,
        machineId: bot.machineId,
        homeDir: bot.homeDir,
        agent: bot.agent,
        model: bot.model,
        permissionMode: bot.permissionMode,
        homeChatSessionId: bot.homeChatSessionId,
        state: bot.state,
        lastError: bot.lastError,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt
    }
}

export class BotService {
    constructor(private readonly deps: BotServiceDeps) {}

    private get store(): BotServiceDeps['store'] {
        return this.deps.store
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now()
    }

    // ---- lookup -------------------------------------------------------------

    /** The bot whose home chat this session is; null for every other session. */
    homeChatBot(sessionId: string): StoredBot | null {
        return this.store.bots.getByHomeChat(sessionId)
    }

    /**
     * The bot this session may act as: its home chat, while the bot can
     * still run. The conversation of a bot whose creation failed (the
     * machine may have started it after all) is left as an ordinary session:
     * no bot tools, no place in the ledger.
     */
    private runningHomeChatBot(sessionId: string): StoredBot | null {
        const bot = this.store.bots.getByHomeChat(sessionId)
        return bot && RUNNABLE_STATES.has(bot.state) ? bot : null
    }

    /** The id of the bot this session is the home chat of, for the session's first start; undefined for every other session. */
    botIdForHomeChat(sessionId: string): string | undefined {
        return this.runningHomeChatBot(sessionId)?.id
    }

    /**
     * Whether the peer-session tools are off for this session. With
     * `botsOnly`, they stay off for everyone but a bot's home chat.
     */
    peerToolsDisabledFor(sessionId: string, hubDisabled: boolean, botsOnly: boolean): boolean {
        return hubDisabled && !(botsOnly && this.runningHomeChatBot(sessionId) !== null)
    }

    /** An archived bot is gone as far as the API is concerned. */
    private requireBot(namespace: string, botId: string): StoredBot {
        const bot = this.store.bots.get(botId)
        if (!bot || bot.namespace !== namespace || bot.state === 'archived') {
            throw new BotError(404, 'bot_not_found', 'Bot not found')
        }
        return bot
    }

    private requireItem(bot: StoredBot, itemKey: string): StoredBotItem {
        const item = this.store.bots.getItem(bot.id, itemKey)
        if (!item) {
            throw new BotError(404, 'item_not_found', 'Item not found')
        }
        return item
    }

    /**
     * A worker an item is linked to must be a session of the bot's own
     * namespace: its name, its state and its pending requests are shown to
     * the owner, and its requests are forwarded to the bot.
     */
    private requireWorker(bot: StoredBot, workerSessionId: string): void {
        if (!this.deps.sessionInNamespace(workerSessionId, bot.namespace)) {
            throw new BotError(404, 'worker_not_found', 'Worker session not found')
        }
    }

    /** `fromSessionId` names the bot's home chat on agent calls; its absence means the owner. */
    private actorOf(bot: StoredBot, fromSessionId: string | undefined): BotItemEventActor {
        if (fromSessionId === undefined) return 'user'
        if (fromSessionId === bot.homeChatSessionId) return 'bot'
        throw new BotError(403, 'not_bot_home_chat', 'Only the bot\'s home chat may act as the bot')
    }

    // ---- bots ---------------------------------------------------------------

    private workerSessionIds(bot: StoredBot, openItems: StoredBotItem[]): string[] {
        const ids = new Set<string>()
        // Only a worker still attached to open work counts; a finished item keeps its worker as history.
        for (const item of openItems) {
            if (item.workerSessionId) ids.add(item.workerSessionId)
        }
        if (bot.homeChatSessionId) {
            for (const child of this.deps.receiptChildrenOf(bot.homeChatSessionId)) ids.add(child)
        }
        return [...ids]
    }

    private pendingRequestCount(session: BotSessionView | null): number {
        return Object.keys(session?.agentState?.requests ?? {}).length
    }

    private needsYouEntries(bot: StoredBot, openItems: StoredBotItem[], workers: string[], now: number): NeedsYouEntry[] {
        const entries: NeedsYouEntry[] = []
        const sessions = new Set<string>()
        if (bot.homeChatSessionId) sessions.add(bot.homeChatSessionId)
        for (const worker of workers) sessions.add(worker)
        // Unanswered requests first: a worker cannot continue until they are settled.
        for (const sessionId of sessions) {
            const session = this.deps.getSession(sessionId)
            for (const [requestId, request] of Object.entries(session?.agentState?.requests ?? {})) {
                entries.push({ kind: 'request', sessionId, requestId, tool: request.tool, createdAt: request.createdAt ?? null })
            }
        }
        for (const item of openItems) {
            if (item.status !== 'needs_you' || !item.ask) continue
            if (item.snoozedUntil !== null && item.snoozedUntil > now) continue
            entries.push({
                kind: 'question',
                itemId: item.id,
                number: item.number,
                title: item.title,
                ask: item.ask,
                workerSessionId: item.workerSessionId,
                updatedAt: item.updatedAt
            })
        }
        return entries
    }

    private summary(bot: StoredBot): BotSummary {
        // Only open items are read: with 500 items per bot, listing them all for a sidebar count is wasted work.
        const openItems = this.store.bots.listOpenItems(bot.id)
        const workers = this.workerSessionIds(bot, openItems)
        const home = bot.homeChatSessionId ? this.deps.getSession(bot.homeChatSessionId) : null
        return {
            ...toWireBot(bot),
            machineOnline: this.deps.isMachineOnline(bot.machineId),
            homeChatActive: home?.active ?? false,
            counts: {
                needsYou: this.needsYouEntries(bot, openItems, workers, this.now()).length,
                working: openItems.filter((item) => item.status !== 'needs_you').length,
                workers: workers.length
            }
        }
    }

    list(namespace: string) {
        return this.store.bots.list(namespace).map((bot) => this.summary(bot))
    }

    get(namespace: string, botId: string) {
        return this.summary(this.requireBot(namespace, botId))
    }

    /**
     * Hub start: a creation that never finished is marked failed, so it does
     * not sit at "creating" forever, and its name can be used again.
     */
    sweep(): void {
        const now = this.now()
        const stale = this.store.bots.failStaleCreating(
            now - BOT_CREATION_STALE_MS,
            'Its creation did not finish (the hub restarted while it was under way). Create the bot again.',
            now
        )
        for (const bot of stale) this.emitBotChanged(bot)
    }

    async create(namespace: string, request: CreateBotRequest) {
        const now = this.now()
        const name = request.name.trim()
        const agent = request.agent ?? 'claude'
        const slug = botHomeSlug(name)
        if (!slug && request.homeDir === undefined) {
            throw new BotError(400, 'unusable_name', 'This name has no letters or digits to name a home folder after; set homeDir')
        }
        // A bot whose creation failed does not hold its name: the owner has to be able to try again.
        const taken = this.store.bots.list(namespace).find(
            (bot) => bot.state !== 'failed' && bot.name.toLowerCase() === name.toLowerCase()
        )
        if (taken) {
            throw new BotError(409, 'name_taken', `A bot named "${taken.name}" already exists`)
        }
        const machine = this.deps.getMachine(request.machineId)
        if (!machine || machine.namespace !== namespace) {
            throw new BotError(404, 'machine_not_found', 'Machine not found')
        }
        if (!this.deps.isMachineOnline(machine.id)) {
            throw new BotError(503, 'machine_offline', 'The machine is offline; bring its runner online to create the bot there')
        }
        if (!BOT_AGENT_FLAVORS.includes(agent)) {
            throw new BotError(400, 'unknown_agent', `${agent} cannot run a bot yet. Agents that can: ${BOT_AGENT_FLAVORS.join(', ')}`)
        }
        const modes = this.deps.permissionModesFor(agent)
        let permissionMode: string | undefined
        if (request.permissionMode !== undefined) {
            if (!modes.includes(request.permissionMode)) {
                throw new BotError(400, 'invalid_permission_mode', `permission mode ${request.permissionMode} is not supported by ${agent}`)
            }
            permissionMode = request.permissionMode
        } else {
            // The owner's choice: a bot runs without permission prompts, like the workers it
            // opens. What it does without asking is then up to its working rules.
            permissionMode = defaultBotPermissionMode(modes)
        }

        const homeDir = request.homeDir ?? defaultBotHomeDir(name)
        let prepared: PrepareBotHomeResponse
        try {
            prepared = await this.deps.prepareHome(machine.id, { path: homeDir, name })
        } catch (error) {
            throw new BotError(502, 'home_prepare_failed', `Could not prepare the home folder on ${machine.id}: ${describe(error)}`)
        }
        // The folder is the home chat's working directory on that machine: it has to be
        // a path there, not something relative to wherever the runner was started.
        if (!isUsableHomePath(prepared.path)) {
            throw new BotError(502, 'home_prepare_failed', `The machine reported an unusable home folder: ${prepared.path}`)
        }

        let bot: StoredBot
        try {
            bot = this.store.bots.insert({
                namespace,
                name,
                purpose: request.purpose?.trim() ?? '',
                machineId: machine.id,
                homeDir: prepared.path,
                agent,
                model: request.model ?? null,
                permissionMode: permissionMode ?? null,
                state: 'creating',
                now
            })
        } catch (error) {
            // Two requests raced past the check above; the name index settles it.
            if (/UNIQUE constraint/.test(describe(error))) {
                throw new BotError(409, 'name_taken', `A bot named "${name}" already exists`)
            }
            throw error
        }
        this.emitBotChanged(bot)

        // Record the home chat before the machine starts it: the session's first
        // bootstrap then already finds the bot, and gets the bot's tools.
        const homeChatSessionId = randomUUID()
        this.store.bots.update(bot.id, { homeChatSessionId }, this.now())

        let spawned: { sessionId: string } | { error: string }
        try {
            spawned = await this.deps.spawnHomeChat({
                sessionId: homeChatSessionId,
                name: bot.name,
                machineId: machine.id,
                homeDir: prepared.path,
                agent,
                model: request.model,
                permissionMode,
                namespace
            })
        } catch (error) {
            spawned = { error: describe(error) }
        }
        if ('error' in spawned) {
            // The id stays recorded. The machine may have started the home chat
            // after all (a reply that never came back), and a session that
            // exists must still be known as this bot's.
            const failed = this.store.bots.update(bot.id, { state: 'failed', lastError: spawned.error }, this.now())
            if (failed) this.emitBotChanged(failed)
            throw new BotError(502, 'home_chat_spawn_failed', `Could not open the bot's conversation: ${spawned.error}`)
        }
        const active = this.store.bots.update(bot.id, { state: 'active', lastError: null }, this.now())
        if (active) this.emitBotChanged(active)
        // The machine has just been asked to start this session: the first run waits for it, it does not start it.
        void this.deps.queueMessage(spawned.sessionId, botKickoffMessage(bot.name, bot.purpose), buildBotKickoffMessageLocalId(bot.id))
            .catch((error) => this.deps.log?.('[bots] first run could not be sent', { botId: bot.id, error: describe(error) }))
        return this.summary(this.requireBot(namespace, bot.id))
    }

    /** Pauses under way, per bot: a change that comes meanwhile waits for them, so that the owner's last request is the one that stands. */
    private readonly pausesUnderWay = new Map<string, Promise<BotSummary>>()

    async update(namespace: string, botId: string, patch: UpdateBotRequest): Promise<BotSummary> {
        const underWay = this.pausesUnderWay.get(botId)
        if (underWay) await underWay.catch(() => undefined)
        const bot = this.requireBot(namespace, botId)
        if (patch.paused !== undefined && bot.state !== 'active' && bot.state !== 'paused') {
            throw new BotError(409, 'bot_not_pausable', `A ${bot.state} bot cannot be paused or resumed`)
        }
        // Pausing quiets everything that would start a turn on its own: the
        // home chat's schedules stop, and replies from its workers are kept
        // until it resumes. Resuming undoes both.
        if (patch.paused === true) {
            const pausing = this.pause(namespace, bot, patch).finally(() => { this.pausesUnderWay.delete(botId) })
            // Registered before anything else gets a turn: `pause` stops at its first await, not this call.
            this.pausesUnderWay.set(botId, pausing)
            return pausing
        }
        const now = this.now()
        const home = bot.homeChatSessionId
        let pausedTasks: PausedTask[] | undefined
        if (patch.paused === false && bot.pausedTasks.length > 0 && home) {
            // Only tasks the owner has not edited since the bot paused them
            // start again: one that was edited meanwhile is left as they left
            // it, and one that is running by the owner's hand needs no resuming.
            const current = new Map(this.deps.listTasks(home).map((task) => [task.id, task]))
            const toResume = bot.pausedTasks.filter((entry) => {
                const task = current.get(entry.id)
                return task?.state === 'paused' && task.fingerprint === entry.fingerprint
            })
            // Back on their schedule, not run at once: one that was due while
            // the bot was paused runs now, once. Those the session had no room
            // for stay recorded, and the next resume tries them again.
            const leftPaused = toResume.length > 0
                ? new Set(this.deps.resumeTasksAt(home, toResume.map((entry) => ({ id: entry.id, nextRunAt: entry.nextRunAt }))))
                : new Set<string>()
            pausedTasks = bot.pausedTasks.filter((entry) => leftPaused.has(entry.id))
        }
        const updated = this.store.bots.update(botId, {
            ...(patch.purpose !== undefined ? { purpose: patch.purpose.trim() } : {}),
            ...(patch.paused === false ? { state: 'active' } : {}),
            ...(patch.paused === false ? { lastError: null } : {}),
            ...(pausedTasks !== undefined ? { pausedTasks } : {})
        }, now)
        if (!updated) throw new BotError(404, 'bot_not_found', 'Bot not found')
        this.emitBotChanged(updated)
        if (patch.paused === false && home) this.deps.releaseReceipts(home)
        return this.summary(updated)
    }

    /**
     * Stops the home chat's running schedules and records them with the bot,
     * so that resuming starts each again where it was due.
     */
    private async pause(namespace: string, bot: StoredBot, patch: UpdateBotRequest): Promise<BotSummary> {
        const now = this.now()
        const home = bot.homeChatSessionId
        // What is running now joins the list; a list from an earlier pause
        // stays. (Computing it afresh would find nothing running and lose
        // what has to be resumed.) When each was due next is read here: the
        // pause clears it.
        const running = home ? this.deps.listTasks(home).filter((task) => task.state === 'active') : []
        const recorded = new Map(bot.pausedTasks.map((entry) => [entry.id, entry]))
        for (const task of running) recorded.set(task.id, { id: task.id, fingerprint: task.fingerprint, nextRunAt: task.nextRunAt })
        let pausedTasks = [...recorded.values()]
        // The bot is written paused, with its schedules, before the pause is
        // waited for. The hub stops the schedules in the same breath; taking
        // a waiting prompt back comes after that and takes a moment. If the
        // hub stops in that moment, the bot is still paused and its schedules
        // are still recorded.
        let updated = this.store.bots.update(bot.id, {
            ...(patch.purpose !== undefined ? { purpose: patch.purpose.trim() } : {}),
            state: 'paused',
            pausedTasks
        }, now)
        if (!updated) throw new BotError(404, 'bot_not_found', 'Bot not found')
        this.emitBotChanged(updated)
        if (home && running.length > 0) await this.deps.setTasksPaused(home, running.map((task) => task.id), true)

        // The pause took a moment, so the bot is read again: it may have been
        // archived meanwhile, or its home chat merged into another session.
        const pausedBot = this.requireBot(namespace, bot.id)
        if (pausedBot.state !== 'paused') return this.summary(pausedBot)
        const homeNow = pausedBot.homeChatSessionId
        const stopped = new Set(homeNow ? this.deps.listTasks(homeNow).filter((task) => task.state === 'paused').map((task) => task.id) : [])
        const stopping = new Set(running.map((task) => task.id))
        // Deleted while it was being paused, or one the hub could not stop:
        // not this pause's to resume.
        const kept = pausedTasks.filter((entry) => !stopping.has(entry.id) || stopped.has(entry.id))
        if (kept.length !== pausedTasks.length) {
            updated = this.store.bots.update(bot.id, { pausedTasks: kept }, now)
            if (!updated) throw new BotError(404, 'bot_not_found', 'Bot not found')
            this.emitBotChanged(updated)
        }
        return this.summary(updated)
    }

    /**
     * Keeps the bot's conversations; it just stops being a bot. Its schedules
     * stop with it: nothing should keep starting turns in the name of a bot
     * that no longer exists.
     */
    archive(namespace: string, botId: string): void {
        const bot = this.requireBot(namespace, botId)
        const now = this.now()
        const home = bot.homeChatSessionId
        if (home) {
            const running = this.deps.listTasks(home).filter((task) => task.state === 'active')
            // Not waited for: the bot is archived either way, and a prompt the
            // pause takes back is taken back whenever the pause gets to it.
            if (running.length > 0) void this.deps.setTasksPaused(home, running.map((task) => task.id), true)
        }
        this.store.bots.update(botId, { state: 'archived', lastError: null, pausedTasks: [] }, now)
        this.emitBotChanged(bot)
        // A paused bot's receipts were held for it; an archived one is not held, so let them go where they may.
        if (home) this.deps.releaseReceipts(home)
    }

    /** The home chat of a bot was deleted: the bot cannot run any more. */
    onHomeChatGone(sessionId: string): void {
        const bot = this.store.bots.getByHomeChat(sessionId)
        if (!bot || bot.state === 'archived' || bot.state === 'failed') return
        const failed = this.store.bots.update(bot.id, { state: 'failed', lastError: BOT_HOME_CHAT_GONE_MESSAGE, pausedTasks: [] }, this.now())
        if (failed) this.emitBotChanged(failed)
    }

    // ---- items --------------------------------------------------------------

    createItem(namespace: string, botId: string, body: CreateBotItemRequest): { item: BotItem; event: BotItemEvent } {
        const bot = this.requireBot(namespace, botId)
        const actor = this.actorOf(bot, body.fromSessionId)
        if (body.workerSessionId !== undefined) this.requireWorker(bot, body.workerSessionId)
        if (this.store.bots.countAllItems(bot.id) >= BOT_MAX_ITEMS) {
            throw new BotError(400, 'too_many_items', `A bot keeps at most ${BOT_MAX_ITEMS} items`)
        }
        const item = this.store.bots.createItem({
            botId: bot.id,
            // Always the home chat: the owner may create an item from the panel while the bot is elsewhere.
            sessionId: bot.homeChatSessionId ?? bot.id,
            title: body.title,
            detail: body.detail ?? '',
            status: body.status ?? 'planned',
            workerSessionId: body.workerSessionId ?? null,
            actor,
            now: this.now()
        })
        const event = body.workerSessionId
            ? this.store.bots.appendEvent(item.id, { kind: 'linked', actor, text: body.workerSessionId }, this.now())
            : null
        this.announceItem(bot, item)
        return { item, event: event ?? this.store.bots.listEvents(item.id)[0] }
    }

    listItems(namespace: string, botId: string): BotItem[] {
        const bot = this.requireBot(namespace, botId)
        return this.store.bots.listItems(bot.id)
    }

    updateItem(namespace: string, botId: string, itemKey: string, body: UpdateBotItemRequest): BotItem {
        const bot = this.requireBot(namespace, botId)
        const item = this.requireItem(bot, itemKey)
        const actor = this.actorOf(bot, body.fromSessionId)
        if (body.status !== undefined && !MOVABLE_STATUSES.has(body.status)) {
            throw new BotError(400, 'invalid_status', 'To ask the owner, use the ask endpoint')
        }
        if (body.status !== undefined && !OPEN_STATUSES.has(item.status) && body.status !== item.status) {
            throw new BotError(409, 'item_closed', 'A done or canceled item cannot be reopened; create a new item')
        }
        if (body.workerSessionId) this.requireWorker(bot, body.workerSessionId)
        const changes: Array<{ kind: 'status' | 'linked' | 'unlinked' | 'updated'; text: string }> = []
        if (body.status !== undefined && body.status !== item.status) changes.push({ kind: 'status', text: body.status })
        if (body.workerSessionId !== undefined && body.workerSessionId !== item.workerSessionId) {
            changes.push({ kind: body.workerSessionId ? 'linked' : 'unlinked', text: body.workerSessionId ?? item.workerSessionId ?? '' })
        }
        const edited = [
            ...(body.title !== undefined && body.title !== item.title ? ['title'] : []),
            ...(body.detail !== undefined && body.detail !== item.detail ? ['detail'] : []),
            ...(body.snoozedUntil !== undefined && body.snoozedUntil !== item.snoozedUntil ? ['snooze'] : [])
        ]
        if (edited.length > 0) changes.push({ kind: 'updated', text: edited.join(', ') })
        // Leaving `needs_you` for any other status drops the question; a plain edit keeps it.
        const ask = body.status !== undefined && body.status !== item.status ? null : item.ask
        if (changes.length === 0) return item
        const [first, ...rest] = changes
        const updated = this.store.bots.mutateItem(item.id, {
            title: body.title,
            detail: body.detail,
            status: body.status,
            snoozedUntil: body.snoozedUntil,
            workerSessionId: body.workerSessionId,
            ask
        }, { kind: first.kind, actor, text: first.text }, this.now())
        if (!updated) throw new BotError(404, 'item_not_found', 'Item not found')
        for (const change of rest) {
            this.store.bots.appendEvent(item.id, { kind: change.kind, actor, text: change.text }, this.now())
        }
        this.announceItem(bot, updated)
        return updated
    }

    /** The bot puts an item to its owner. Bot only. */
    ask(namespace: string, botId: string, itemKey: string, body: BotItemAskRequest): BotItem {
        const bot = this.requireBot(namespace, botId)
        const item = this.requireItem(bot, itemKey)
        if (body.fromSessionId === undefined) {
            throw new BotError(403, 'bot_only', 'Only the bot can put an item to its owner')
        }
        const actor = this.actorOf(bot, body.fromSessionId)
        if (!OPEN_STATUSES.has(item.status)) {
            throw new BotError(409, 'item_closed', 'A done or canceled item cannot be put to the owner; create a new item')
        }
        const options = body.options && body.options.length > 0 ? body.options : undefined
        if (body.recommended !== undefined && body.recommended !== null && (!options || body.recommended >= options.length)) {
            throw new BotError(400, 'invalid_recommended', 'recommended must be the index of one of the options')
        }
        const ask: BotItemAsk = {
            question: body.question,
            ...(options ? { options } : {}),
            recommended: body.recommended ?? null
        }
        const updated = this.store.bots.mutateItem(item.id, { status: 'needs_you', ask, snoozedUntil: null }, {
            kind: 'ask', actor, text: body.question
        }, this.now())
        if (!updated) throw new BotError(404, 'item_not_found', 'Item not found')
        this.announceItem(bot, updated)
        return updated
    }

    /**
     * One comment. The owner's comment moves the item back to working and
     * wakes the bot with it; the bot's own comment only goes on the record.
     * Returns before the bot has been woken.
     */
    comment(namespace: string, botId: string, itemKey: string, body: BotItemCommentRequest): { item: BotItem; event: BotItemEvent } {
        const bot = this.requireBot(namespace, botId)
        const item = this.requireItem(bot, itemKey)
        const actor = this.actorOf(bot, body.fromSessionId)
        const answered = actor === 'user' && item.ask !== null
        const reopened = actor === 'user' && (item.status === 'needs_you' || item.status === 'waiting')
        const updated = this.store.bots.mutateItem(item.id, {
            status: reopened ? 'working' : item.status,
            ask: reopened ? null : item.ask,
            snoozedUntil: reopened ? null : item.snoozedUntil
        }, { kind: answered ? 'answered' : 'comment', actor, text: body.text }, this.now())
        if (!updated) throw new BotError(404, 'item_not_found', 'Item not found')
        this.announceItem(bot, updated)

        const events = this.store.bots.listEvents(item.id)
        const event = events.at(-1)
        if (!event) throw new Error('item event missing after comment')
        // The owner started this: it is delivered even to a paused bot.
        if (actor === 'user' && bot.homeChatSessionId) {
            const localId = buildBotItemCommentMessageLocalId(event.id)
            const text = formatBotItemCommentMessage({
                number: item.number,
                title: item.title,
                comment: body.text,
                question: item.ask?.question ?? null,
                reopened
            })
            void this.deps.deliver(bot.homeChatSessionId, text, localId)
                .catch((error) => this.deps.log?.('[bots] comment could not reach the bot', { botId: bot.id, itemId: item.id, error: describe(error) }))
        }
        return { item: updated, event }
    }

    listEvents(namespace: string, botId: string, itemKey: string): BotItemEvent[] {
        const bot = this.requireBot(namespace, botId)
        const item = this.requireItem(bot, itemKey)
        return this.store.bots.listEvents(item.id)
    }

    // ---- views --------------------------------------------------------------

    needsYou(namespace: string, botId: string): NeedsYouEntry[] {
        const bot = this.requireBot(namespace, botId)
        const openItems = this.store.bots.listOpenItems(bot.id)
        return this.needsYouEntries(bot, openItems, this.workerSessionIds(bot, openItems), this.now())
    }

    workers(namespace: string, botId: string): BotWorker[] {
        const bot = this.requireBot(namespace, botId)
        const openItems = this.store.bots.listOpenItems(bot.id)
        const itemByWorker = new Map<string, number>()
        for (const item of openItems) {
            if (item.workerSessionId) itemByWorker.set(item.workerSessionId, item.number)
        }
        const workers: BotWorker[] = []
        for (const sessionId of this.workerSessionIds(bot, openItems)) {
            const session = this.deps.getSession(sessionId)
            if (!session) continue
            workers.push({
                sessionId,
                name: session.name ?? null,
                active: session.active,
                thinking: session.thinking,
                pendingRequests: this.pendingRequestCount(session),
                itemNumber: itemByWorker.get(sessionId) ?? null
            })
        }
        return workers
    }

    /** Bots that wait on this session as a worker: it is attached to one of their items, or their home chat awaits a receipt from it. */
    botsWaitingOn(sessionId: string): StoredBot[] {
        // Items are indexed by worker; receipts are asked of the receipt service, once per bot (a handful).
        const withItem = new Set(this.store.bots.listItemsForWorker(sessionId).map((item) => item.botId))
        return this.store.bots.listLive().filter(
            (bot) => withItem.has(bot.id)
                || (bot.homeChatSessionId !== null && this.deps.receiptChildrenOf(bot.homeChatSessionId).includes(sessionId))
        )
    }

    /**
     * A session's pending requests changed: some were raised, or some were
     * answered. The owner's lists read those requests, so every bot that
     * shows them is announced. For requests just raised by one of a bot's
     * workers, the bot is told, once per request, and can then decide.
     */
    onRequestsChanged(sessionId: string, added: Array<{ requestId: string; request: AgentStateRequest }>): void {
        const own = this.store.bots.getByHomeChat(sessionId)
        const concerned = own ? [own, ...this.botsWaitingOn(sessionId).filter((bot) => bot.id !== own.id)] : this.botsWaitingOn(sessionId)
        for (const bot of concerned) {
            this.emitBotChanged(bot)
            // The event names the bot's ledger, as every bot-items-changed does; which session's requests moved is not part of it.
            this.emitItemsChanged(bot, bot.homeChatSessionId ?? sessionId)
        }
        if (added.length === 0 || concerned.length === 0) return
        const worker = this.deps.getSession(sessionId)
        for (const bot of concerned) {
            // A paused bot is not started by its workers; the request waits under "Needs you".
            if (bot.state !== 'active' || !bot.homeChatSessionId || bot.homeChatSessionId === sessionId) continue
            for (const { requestId, request } of added) {
                const localId = buildBotRequestNoticeMessageLocalId(sessionId, requestId)
                if (this.deps.hasMessage(bot.homeChatSessionId, localId)) continue
                const text = formatBotRequestNoticeMessage({
                    workerSessionId: sessionId,
                    workerName: worker?.name?.trim() || sessionId.slice(0, 8),
                    requestId,
                    tool: request.tool,
                    summary: summarizeBotRequestArguments(request.arguments)
                })
                void this.deps.deliver(bot.homeChatSessionId, text, localId)
                    .catch((error) => this.deps.log?.('[bots] request notice could not reach the bot', {
                        botId: bot.id, sessionId, requestId, error: describe(error)
                    }))
            }
        }
    }

    // ---- events -------------------------------------------------------------

    /** The bot's counts may have moved with one of its items: both lists are announced. */
    private announceItem(bot: StoredBot, item: StoredBotItem): void {
        this.emitBotChanged(bot)
        if (bot.homeChatSessionId) this.emitItemsChanged(bot, bot.homeChatSessionId, item.id)
    }

    private emitBotChanged(bot: StoredBot): void {
        this.deps.emit({ type: 'bots-changed', namespace: bot.namespace, botId: bot.id })
    }

    private emitItemsChanged(bot: StoredBot, sessionId: string, itemId?: string): void {
        this.deps.emit({ type: 'bot-items-changed', namespace: bot.namespace, sessionId, botId: bot.id, ...(itemId ? { itemId } : {}) })
    }
}

function isUsableHomePath(path: string): boolean {
    return path.length > 0
        && path.length <= 4096
        && !/[\u0000-\u001f\u007f]/.test(path)
        && isAbsoluteHomePath(path)
        && !path.startsWith('~')
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

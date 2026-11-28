---
description: "Bots: long-lived agents that work on your behalf by opening, messaging and watching other sessions, keep a ledger of what they are doing, and ask you only for what is yours to decide."
---

# Bots

A bot is an agent that stays around. It has a home folder and one conversation (its **home chat**) where you talk to it. You give it a goal; it opens other sessions to do the work, watches them, collects the results and carries on until the job is done. It comes to you only for what is yours to decide, and then with a question that has options.

It is not a new kind of agent. A bot's home chat is an ordinary session in a folder of its own, plus a record on the hub that marks it as a bot. Claude Code is the brain: it is the only agent that has been run as a bot's home chat so far, so it is the only one offered. The workers a bot opens can be any agent on any machine.

On the hub, bots add four tables to the database (the bots, their ledger, the reply promises). A hub that is upgraded to a build with bots moves its database forward one version, and a build without bots refuses to open it: going back means going back to the database backup made before the upgrade, as with any other schema change.

## Create a bot

1. At the top of the session list, choose the robot icon (**New bot**), next to **New session**. On a narrow list it may sit under **More** (⋯).
2. Name it and, in a sentence, say what it is for.
3. Pick the **machine** it lives on. Its home folder and its home chat are created on that machine, so its runner has to be online. A hub can have as many machines as you like; each bot lives on one of them. To move a bot, create another on the other machine.
4. Optionally, under **Advanced**, set the home folder and the permission mode (see below).

HAPI creates the folder, writes the working rules into `AGENTS.md`, opens the home chat under the bot's name and sends the first message. On that first run the bot greets you, does one small thing for its job, and writes its own `SOUL.md`.

The home folder has to be a new folder, an empty one, or the home of a bot with the same name (so a bot created again under its old name keeps its notes). A folder that already holds something else is refused: the rules file would be read by every session started under it. The default is `~/.hapi/bots/<name>`. Where the runner of that machine was started with `--workspace-root`, a folder of your own has to lie inside those roots; the default folder is accepted regardless.

If the home chat cannot be opened, the bot is listed with **Error** and the reason. Its name is not held by the failed attempt, so you can create it again; the failed row can be archived from its menu. The same happens when a bot's home chat is deleted: the bot is listed with **Error** and its conversation, if any is left, is an ordinary session again.

The home folder is yours and the bot's:

| File | Who owns it | What it is |
|------|-------------|------------|
| `SOUL.md` | you and the bot | who it is, what it takes care of, how it works with you |
| `MEMORY.md`, `memory/` | you and the bot | its notes across conversations |
| `AGENTS.md`, `CLAUDE.md` | HAPI | the working rules; written once when the folder is created |

Edit `SOUL.md` and `MEMORY.md` as you like. The bot reads them at the start of every turn.

## What it does

- **Delegates.** Code changes, long jobs and large searches go to a worker: a new session, in a worktree when a repository is involved, with a remit that says what to deliver and what counts as done. The bot does not edit repositories itself.
- **Keeps a ledger.** One item per deliverable and per decision, with the worker attached to it and the result written back.
- **Ends its turn after delegating.** When a worker finishes, its reply arrives in the home chat as a new message and the bot picks up from there. The hub does the waiting, so the bot's session can stop or restart without losing the reply, and workers of any agent can report back.
- **Hears back exactly once, and not too early.** The hub reports a worker when it sees the worker's turn end, or when the worker says so itself. A worker that merely goes quiet is given half an hour to come back before it is reported as gone. A worker that took the job and has sat idle for two minutes without an end of turn being reported — ten minutes if it left something running in the background — is taken as finished; one that is waiting on a request is never taken for finished. A reply is never sent twice, not across a hub restart.
- **Tells you when a worker is stuck.** If a worker is waiting on a permission or an answer, the bot is told, decides whether it is its call, and either answers or puts the question to you.
- **Schedules itself.** It can create reminders and repeating tasks for its own conversation with `hapi task`, and the hub wakes it when they are due. It cannot put a schedule into another session.

## The ledger

Open the home chat and choose **Ledger**. It has three tabs:

- **Needs you.** Requests waiting in the bot's own conversation or in its workers come first; tap one to answer it where it was asked. Below are the bot's questions, each with its options. Tap an option or write a comment in your own words. Your answer puts the item back to work and wakes the bot with it.
- **Working.** Open items: number, title, status, the worker on it. Open an item for its history, to comment, or to mark it done, cancel it, or snooze it.
- **Done.** What was delivered.

Pause a bot from the ledger's header. While it is paused nothing starts a turn on its own: its schedules stop, and replies from its workers are kept until it resumes. What comes from you still reaches it — your answer from the ledger, your comments in the home chat.

Resuming restarts the schedules the pause stopped, each at the time it was due rather than at once. A prompt that was still waiting when the bot was paused had been taken back, and goes out again. A schedule you edited while the bot was paused, or one that would take the home chat past its limit of active tasks, stays paused.

**Archive** in the ledger's header removes the bot from the list and stops its schedules. Its conversations and its home folder stay; it just is not a bot any more.

## What a bot may do

- The peer-session tools (`list_peers`, `inspect_peer`, `ping_peer`, `spawn_peer`) can be switched off for everyone on the hub under Settings → General. With **Bots can still use them** on, they stay off for ordinary sessions and are given to bots' home chats only. A worker opened by a bot does not get them, so it cannot open further sessions itself.
- A bot's conversation starts fully automatic (Yolo) unless you pick another mode when you create it: nothing it does waits for approval. The working rules in its home folder tell it to come to you before anything irreversible, and for whatever is yours to decide. That is an instruction to the bot, not a lock: if you would rather approve what it does, create it in Accept Edits or Default. The mode is set when the bot is created; to change it, create the bot again.
- In a mode that prompts, a short list still goes through without asking, so that the bot's routine work does not stall: its own ledger and schedule commands (`hapi item …`, `hapi task …`), answering a worker's request (`hapi peer-answer …`), looking at another session (`hapi inspect-peer …`), and the peer tools `spawn_peer`, `ping_peer`, `inspect_peer`. Nothing else is pre-approved: no other command, no git, no command that can run another command. The rest asks first. (Claude Code 2.1.332 refuses a pre-approved command as soon as it contains a command substitution, a redirect or a second command; that is the version this was checked on.)
- A worker starts in the hub's usual spawn mode. Workers are told, in their remit, to stop and ask before anything irreversible — deleting, overwriting, force-pushing, merging, spending — and the bot is told never to approve those for you. That is an instruction to the worker, not a lock: with a mode that never asks, nothing but the worker's own judgement stops it. To answer a worker's permission request with `hapi peer-answer`, the bot has to say `--approve` or `--deny` explicitly.
- The ledger is the one record. Web, phone and the bot read the same items, and everything that arrives in the bot's conversation from outside — a worker's reply, your comment, a message from a chat — is marked as data, not instructions. When the bot is told that a worker is waiting on a request, the command that request is about is summarized with anything that looks like a credential left out.
- What one namespace may reach is what its login may reach. A bot links only to sessions of its own namespace, and the hub posts a reply only into a session of the caller's namespace. Within one namespace, sessions are not separated from each other: anything running with that namespace's CLI token can act as any of its sessions.

## For the agent

The bot's tools are two MCP tools, registered only in a bot's home chat, and the matching shell commands. The shell commands work in any session: with `--bot <id>` they address that bot's ledger, and only its home chat may change it — anywhere else they read.

| MCP tool | Shell | What it does |
|----------|-------|--------------|
| `bot_item` | `hapi item add / set / ask / comment / list / show / done / cancel` | Keep the ledger: create items, attach workers, write results back, put a question to the owner with options and a recommendation. |
| `bot_task` | `hapi task add / list / pause / resume / delete` | Schedule: once at a time (`--at`, up to 366 days ahead), every interval (`--every`), or a queue of prompts. The answer always says when the next run is. A bot schedules only its own conversation. |
| — | `hapi peer-answer <session> <request> --approve` / `--deny` | Answer a permission request a worker is waiting on. One of the two has to be said explicitly. |
| — | `hapi peer-answer <session> <request> --option <label or number>` / `--text …` / `--answer <n>=…` | Answer a question a worker asked. One answer per question: `--option` or `--text` for a single question, `--answer` for each question of several. Nothing partial is sent. |
| `spawn_peer` | `hapi spawn-peer … --item <n>` | Open a worker and attach it to item *n* (`item` / `--item`). In a bot, replies are delivered by the hub. |

In a bot's conversation `spawn_peer` and `ping_peer` hand the waiting to the hub (`replyVia: 'hub'`, shell `--receipt hub`); everywhere else they keep waiting in the session's own process, as described in [Peer sessions](./peer-sessions). A worker a bot opens gets a short **worker contract** appended to its remit: report what was done, changed, verified and left undone in the final message, and ask before anything irreversible. `list_peers` marks a session that is `[waiting]` on a request or running `[background]` tasks.

An item moves `planned → working → (waiting | needs_you) → done | canceled`. `waiting` is for something outside the bot — a worker, CI, a review, a time; `needs_you` is for you.

## HTTP API

All routes are under `/api` and scoped to the caller's namespace.

| Route | What it does |
|-------|--------------|
| `GET /bots`, `POST /bots` | List bots with their counts; create one. |
| `GET /bots/:botId`, `PATCH /bots/:botId`, `DELETE /bots/:botId` | Read, change (`purpose`, `paused`), archive. The permission mode is set at creation only. |
| `GET /bots/:botId/items`, `POST /bots/:botId/items` | List and create items. An item is addressed by id or by its number. |
| `PATCH /bots/:botId/items/:itemId` | Change title, detail, status, snooze or worker. |
| `POST /bots/:botId/items/:itemId/ask` | Bot only: put the item to the owner (question, options, recommendation). |
| `POST /bots/:botId/items/:itemId/comments` | Comment. The owner's comment reopens the item and wakes the bot. |
| `GET /bots/:botId/items/:itemId/events` | The item's history. |
| `GET /bots/:botId/needs-you`, `GET /bots/:botId/workers` | What waits on the owner; the sessions working for the bot. |
| `POST /sessions/:id/receipts` | Ask the hub to post a session's reply back into another one when its turn ends. The message answered has to be in that session already, and the other one in the caller's namespace. |

Calls made from inside the bot's conversation send `fromSessionId`; the hub accepts them as the bot's only when that is its home chat. The stream announces changes with `bots-changed` (the bot or its counts) and `bot-items-changed` (its ledger).

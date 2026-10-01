# Using Amira

[简体中文](zh/usage.md) · [Documentation](../README.md)

Run `amira` in the directory you want it to work in. A positional prompt becomes the first message; `--cwd` selects a different working directory. See [Getting started](getting-started.md) for provider setup.

## Terminal modes and the transcript

```sh
amira --fullscreen
amira --inline
amira --cwd /path/to/project "Explain this repository"
```

Full-screen mode is the default. Amira keeps the transcript on the alternate screen, scrolls and searches it itself, and prints the displayed session to the normal terminal on exit. Inline mode leaves completed messages and tool calls in the terminal's scrollback; use the terminal's scrolling, search and text selection. This is useful over SSH or in tmux. The flags override `tui.mode` in [Settings](settings.md).

The transcript contains your messages, streamed replies, thinking where the model supplies it, tool activity, questions and notices. In full-screen mode, PgUp/PgDn scroll; End returns to the newest output when the input is empty. Ctrl+F searches the transcript. Ctrl+Up selects a block; ↑/↓ move between blocks, Enter folds or unfolds, and `y` copies. Some terminals need the alternate bindings listed in [Keybindings](keybindings.md).

Ctrl+O cycles tool output detail in either mode; `/verbose` controls it in the interactive UI. Alt+C copies the last reply as Markdown. In full-screen mode dragging selects and copies text; Shift+drag uses the terminal's own selection. Type `?` with an empty input to see the keys currently bound.

## Sending, steering and queueing

Enter sends a message while idle. While a turn runs, Enter normally **steers** it: the message reaches the agent before its next model request, without interrupting a tool already running. Alt+Enter queues a message for after the current turn. Windows Terminal may reserve Alt+Enter; Ctrl+Q is another queue binding. Setting `tui.submitWhileWorking` to `"queue"` swaps the two actions.

Shift+Enter inserts a newline where the terminal supports it; Ctrl+Enter is the fallback. Type `/` for commands, `$` for skills and `@` followed by part of a path for file completion. See [Keybindings](keybindings.md) for editor, completion and history controls.

Esc stops the current turn; while a slash command such as `/ext install` is still running, it cancels that command first and keeps your draft. If steering or queued messages are waiting, they are combined in the order you typed them and sent together. Background sub-agents keep running; [Sub-agents](subagents.md) explains how to stop them. Ctrl+C likewise cancels a running command first, otherwise stops a turn, otherwise clears a nonempty input, otherwise quits. `/quit` also exits.

## Tools and approvals

The bundled tools can read, search, write and edit files, run shell commands, search the web and delegate work. Availability depends on the platform, model and loaded extensions. `/tools` lists the current tools; `/tools disable <name>` and `/tools enable <name>` change availability for this session. `--disable-tools` supplies a comma-separated list at startup. See [Settings](settings.md) and [Extensions](extensions.md) for persistent configuration.

Files are changed with one of two editing tools. `edit` replaces exact text in one file. `apply_patch` takes a patch in the Codex format (`*** Begin Patch` … `*** End Patch`) that can add, delete, update and move several files at once; it checks every hunk before writing anything and rolls back what it wrote if a write fails. Each model gets `edit` unless its provider settings choose otherwise; see [Editing tools](providers.md#editing-tools). `write` is always available. `/tools` lists the tool the current model does not use as disabled, with the reason, and `/tools enable` cannot turn it on; change the setting instead.

An extension can block a tool call or require approval before it runs. This is not a blanket confirmation for every edit or command: the extension decides which calls need approval. A request shows the tool, reason and a preview or arguments. Select an option with the arrows, then Enter; confirmations begin with no option selected. Esc denies the call and stops the turn.

When offered, `Don't ask again` allows that tool **for the same stated reason**, for the rest of the session; it does not save a persistent permission. Sub-agent approval requests are decided by their parent agent's model. Print mode cannot answer dialogs, so requested approvals are denied and questions are cancelled. RPC clients must answer UI requests explicitly.

## Sessions, compaction and rewind

Conversations are stored automatically and listed by working directory. On exit, Amira prints a command for continuing a nonempty session.

| Action | Command |
| --- | --- |
| Continue the newest session in this directory | `amira -c` or `amira --continue` |
| Pick a stored session | `amira -r` or `amira --resume` |
| Resume a known session | `amira -r <session-id>` |
| List sessions without the UI | `amira -p -r` |
| Pick or switch within the UI | `/resume` or `/resume <session-id>` |
| Start an empty conversation | `/clear` |
| Name the current session | `/rename <title>` |
| Continue in a copy of this session | `/fork` |
| Delete a stored session without the UI | `amira sessions rm <session-id>` (`-C <dir>` for another directory) |
| Compact older context now | `/compact` or `/compact <instructions>` |

Do not combine `-c` and `-r`. Session IDs begin with `s_`; use the actual ID shown in the list. `/clear` starts a new stored session, keeping the previous one available to resume. `/resume` keeps the current model selected; when no model is selected, the stored model can be used. Switching sessions stops background work belonging to the old conversation.

After a session's first successful turn, Amira asks the model for a short title (at most six words, in the conversation's language) in the background; it uses `compact.model` when set, otherwise the current model, and never holds up the conversation. Print mode and sub-agents do not request titles. The request's cost appears in `/cost` and `/status`. A `/rename` name always wins over the automatic one. Set `"sessions": { "autoTitle": false }` in user or project settings to turn it off. Titles show in `/status`, `/resume`, `amira -r` and the terminal title.

Typing in the `/resume` picker searches titles and the user and assistant text of whole conversations, compacted history included; matching is a case-insensitive substring, so Chinese or Japanese needs no spaces, and the matching text shows under the row. Ctrl+D deletes the selected session after a confirmation; the current session is never listed. Deleting removes the session file and the sub-agent sessions it started, except ones a fork still uses.

`/fork` copies the conversation into a new session that records where it came from, named `<title> (fork)`, and switches to it; the original stays as it was.

Automatic compaction normally starts at 80% of the model's context window. It reduces older context while keeping recent conversation. Compatible providers can use native compaction; otherwise Amira writes a text summary. Instructions passed to `/compact` force a text summary. See [Providers](providers.md) and [Settings](settings.md) for the conditions and options. `/context` shows what occupies the context window.

Press Esc twice in succession to open the rewind picker. Select a previous user message: that message and everything after it are removed from the active conversation, and the selected prompt returns to the editor for changes and resubmission. In the picker, F forks instead: a new session ends before the selected message, and the current one stays whole. **Rewind does not restore files or undo shell commands.** Only messages still present after compaction can be selected; it requires a stored session. A popup, text selection or dialog can consume Esc first, so follow the current hint line.

## Print mode

```sh
amira -p "Summarize the changes in this repository"
amira -p -c "Continue the review"
amira -p --json "Explain the failing test"
amira -p -- "-v means verbose?"
```

`-p` / `--print` runs without the interactive UI and needs a prompt, except when listing sessions with bare `-r`. Plain mode streams reply text to stdout and tool activity, warnings and errors to stderr. `--json` requires print mode and writes each event as one JSON line to stdout. These lines include session, turn, message, tool and sub-agent events, rather than one final JSON answer.

A quoted slash command such as `amira -p "/status"` runs the command instead of sending a model prompt. Skills can also run this way when available. Commands requiring a picker cannot obtain interactive answers; supply explicit arguments where supported.

Print mode waits for background sub-agents and the follow-up turns their results start. This wait has no fixed time limit; configured budgets still apply. Failed result-delivery turns can be retried up to three times after 10, 30 and 90 seconds. Ctrl+C aborts and stops waiting; a second Ctrl+C forces exit. The exit codes are 0 for completion, 1 for errors and 130 for an aborted turn.

## RPC automation

```sh
amira --rpc
amira --rpc-schema
```

RPC uses JSON Lines on stdin and stdout. It cannot be combined with `-p` or a positional prompt. `--rpc-schema` prints the full protocol schema and exits without starting a model turn. For an initial resume, pass `--resume <session-id>` or `-c`; bare `-r` is not supported in RPC mode.

Send one object per line, with `id`, `cmd` and command parameters at the top level. For example, on a connection with a model configured:

```json
{"id":1,"cmd":"prompt","text":"Explain the test layout"}
```

The immediate response contains the request ID, `ok: true` and a `turnId`; it acknowledges the start, not completion. Events interleave with responses. Wait for the matching `turn.end` to know the outcome. Failed commands respond with `ok: false` and an error containing `code` and `message`.

| Command | Purpose |
| --- | --- |
| `prompt` | Start a turn; fails with `busy` while work runs |
| `steer` | Add instructions before the next model call; start a turn if idle |
| `abort` | Stop a turn or compaction |
| `state` | Get status, model, session and pending UI requests |
| `session.read` | Read `messages` or `lastTurn` using the `what` parameter |
| `session.resume` | Switch to a stored session using `sessionId` |
| `session.rename` | Name the current session using `title`; a `session.title` event follows, as it does for an automatic title |
| `session.fork` | Fork into a new session, before the user message at the optional `index`; a `session.start` with reason `fork` follows |
| `model.set` | Switch model using `model` as provider/model |
| `command.list`, `command.complete`, `command.run` | Discover and run slash commands |
| `skill.list`, `skill.run` | Discover and run skills |
| `ui.respond` | Answer a UI request using `requestId` and `value` |
| `ui.action`, `ui.configure`, `ui.focus` | Support form actions, form presentation and client focus |

Read the generated schema for parameter shapes and UI answer types. For example, a confirmation uses a boolean `value`; explicit `null` cancels, while omitting `value` is invalid. Requests can remain open while later input lines answer them. If a slow client receives `events.lost`, use `state` and `session.read` to resynchronize. Keep reading stdout while work runs.

Closing stdin waits for active work, including background results and their follow-up turns; dialogs that nobody can answer are cancelled. For dialog-driven commands, keep stdin open until they finish.

## Status and costs

`/status` reports the model and provider, session ID and file, context use and window, output tokens, cache hit rate, last-reply speed, known costs, shell and Git workspace. Resumed sessions include usage from earlier runs. The status bar reports tree usage since the current run started; `/status` can include the stored session and its sub-agents.

`/cost` reports this session's replies by model, and compaction and session-title requests separately; it does not aggregate child-agent costs. Use `/status` and `/agents` for those. Costs depend on known model pricing and reported usage; unknown prices are identified, and totals with unpriced rows are partial estimates. Provider billing remains the source for actual charges.

Related: [Getting started](getting-started.md) · [Providers](providers.md) · [Sub-agents](subagents.md) · [Extensions](extensions.md) · [Settings](settings.md) · [Keybindings](keybindings.md).

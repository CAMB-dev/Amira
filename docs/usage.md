# Using Amira

[简体中文](zh/usage.md) · [Documentation](../README.md)

Run `amira` in the directory you want it to work in. A positional prompt becomes the first message; `--cwd` selects a different working directory. See [Getting started](getting-started.md) for provider setup.

## Thinking effort

Use `amira --thinking high` in interactive mode or `amira -p --thinking xhigh "Explain this repository"` in print mode. Accepted levels are `low`, `medium`, `high`, `xhigh` and `max`. The flag overrides both top-level `thinking` and `providers.<id>.models[].thinking` in [Settings](settings.md); without the flag, the model's setting wins over the top-level setting. With neither configured, requests send no effort and keep the server default. Only models with `caps.thinking` receive it, and `/status` shows it only then; sub-agents inherit the parent's selected effort, while title generation and compaction keep their defaults.

Responses and Anthropic adaptive mode send the level unchanged. Anthropic budget mode maps `xhigh` to 32,768 tokens, below `max` at 64,000, capped to leave room for the answer. Gemini maps `xhigh` like `high`, keeping its larger `max` budget for Gemini 2.5 Pro. Chat Completions currently does not send reasoning parameters.

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

## Images

Messages can carry PNG, JPEG, GIF and WebP images, in both terminal modes:

- **Paste or drop paths.** A paste made only of paths to existing image files (absolute or relative to the working directory, quoted when they contain spaces, or with backslash-escaped spaces as macOS and Linux terminals write dropped paths, or `file://` URIs) attaches them. Anything else, such as prose or other files, is pasted as text, and so is an image that cannot be attached, with a notice saying why.
- **Pick one in the `@` file list.** An image attaches; other files keep their `@path` reference.
- **Paste from the clipboard** with Alt+V (`paste.image`; see [Keybindings](keybindings.md) for the other keys). The clipboard's text wins when it has any. This uses PowerShell on Windows, `osascript` (or `pngpaste` when installed) on macOS, and `wl-paste` or `xclip` on Linux; without them a notice says what is missing, and paths still work.

An attachment shows as one placeholder, such as `[image 1: screen.png 120 KB]`, in the input and in the sent message. Backspace or Delete removes it whole; undo, cut and yank keep it. Remove attachments before editing the message in an external editor (Ctrl+G). A message with images is never run as a slash command or skill.

The images in one message are limited to **5 MB in total**. Sending them needs a model that accepts images; otherwise a warning appears and the message stays in the input. Images are stored inline (base64) in the session file, so resuming does not need the original files. Image prompts are recalled with ↑ during the run but are not written to the project's prompt history file.

## Tools and approvals

The bundled tools can read, search, write and edit files, run shell commands, search the web and delegate work. Availability depends on the platform, model and loaded extensions. `/tools` lists the current tools; `/tools disable <name>` and `/tools enable <name>` change availability for this session. `--disable-tools` supplies a comma-separated list at startup. See [Settings](settings.md) and [Extensions](extensions.md) for persistent configuration.

Files are changed with one of two editing tools. `edit` replaces exact text in one file. `apply_patch` takes a patch in the Codex format (`*** Begin Patch` … `*** End Patch`) that can add, delete, update and move several files at once; it checks every hunk before writing anything and rolls back what it wrote if a write fails. Each model gets `edit` unless its provider settings choose otherwise; see [Editing tools](providers.md#editing-tools). `write` is always available. `/tools` lists the tool the current model does not use as disabled, with the reason, and `/tools enable` cannot turn it on; change the setting instead.

`grep` and `glob` skip what git would: `.git`, `node_modules`, files excluded by `.gitignore` files, `.git/info/exclude` or the global excludes file, and directories that hold another repository or a linked worktree (such as `.claude/worktrees/*` inside a checkout). Submodules of the searched repository are searched. A path you pass explicitly is searched even if it is ignored itself. Results outside the working directory are shown as absolute paths marked `[outside working directory]`.

Approval requests come from the [permission policy](#permissions) and from extensions, which can block a tool call or require approval before it runs. A request shows the tool, the reason (with the mode or rule that caused it) and a preview or arguments. Select an option with the arrows, then Enter; confirmations begin with no option selected. Esc denies the call and stops the turn.

When offered, `Don't ask again` allows that tool **for the same stated reason**, for the rest of the session; it does not save a persistent permission. A sub-agent's permission questions go to you, not to its parent; questions an extension raises for a sub-agent are still decided by the parent agent's model. Print mode cannot answer dialogs, so requested approvals are denied and questions are cancelled. RPC clients must answer UI requests explicitly; once an RPC client closes stdin, approvals are denied.

## Permissions

The permission mode decides what the model may do without asking. It applies to the whole session, including sub-agents.

| Mode | What it does |
| --- | --- |
| `auto` (default) | Runs everything without asking, except where your rules or protected files say otherwise |
| `edits` | Changes files without asking; asks before shell commands your `allow` rules do not cover |
| `plan` | Read-only: no file changes and no shell commands; asks before tools it does not know to be read-only, such as MCP tools |

Press Shift+Tab in the UI to cycle `auto`, `edits` and `plan`; a mode other than `auto` shows next to the model in the input box's border. `--permission-mode <mode>` or `"permissions": {"mode": "edits"}` in settings chooses the mode at startup. Plan mode blocks every shell command for now, because Amira cannot yet prove that a command only reads.

Command rules allow, ask about or deny shell commands by their words:

```json
{
  "permissions": {
    "mode": "edits",
    "rules": [
      { "command": ["git", "status"], "decision": "allow" },
      { "command": ["git", "push"], "decision": "ask", "reason": "Review what goes out" },
      { "command": ["rm", "-rf"], "decision": "deny" }
    ]
  }
}
```

A rule matches the words of a command (its argv), not the text: `git status --short` matches `["git", "status"]`, `git statusx` does not. For `ask` and `deny` rules the command name also matches as a path or with a Windows extension (`/usr/bin/git`, `git.exe`), and in PowerShell under its built-in aliases (`rm`, `del` and `Remove-Item` are one command); they also match when other words come between theirs (`git -C repo push` matches `["git", "push"]`) and ignore case. `allow` rules must match the start of the command exactly, and only a command named without a path (`x/git status` is not `git status`) unless the rule itself names that path. When several rules match, `deny` wins over `ask` and `ask` over `allow`. `allow` only means "do not ask": it never lifts plan mode or a protected file.

Commands joined with `&&`, `||`, `;`, `|` or newlines are split and each part is checked. Commands Amira cannot check word by word ask instead: substitutions such as `$(...)` and backticks, variables, redirections into files, here-documents and here-strings, grouping, file name patterns (`*`, `?`, `[...]`), wrappers that run other commands (`eval`, `sudo`, `xargs`, `bash -c`, `Invoke-Expression`, `Start-Process`, interpreters), commands that define aliases (`alias`, `Set-Alias`, `git -c`, `git config alias.*`) and scripts. In `auto` mode they still run without asking unless you have `ask` or `deny` rules. Commands are read the way the shell that runs them reads them: bash or PowerShell, including the `bash` tool falling back to PowerShell on Windows.

Shell commands already start in the working directory; use `cd` only when a command needs another directory. Bash runs foreground and background commands with `pipefail`, so a failed pipeline component keeps a non-zero status: `bun test | tail` fails when the tests fail. A pipeline whose last command succeeds and whose earlier commands only succeeded or were killed by SIGPIPE (141), such as `git log | head`, is treated as successful; other non-zero pipeline statuses still fail. Only the command's final status changes: inside the command such a pipeline still fails, so a following `&&` does not run (`git log | head && echo done` prints no `done`). Limit output with the command's own options, such as `git log -n 5`, when more commands follow. PowerShell has no `pipefail` option, but its wrapper preserves a failing native command's `$LASTEXITCODE` through a native pipeline; cmdlet pipelines follow PowerShell's `$?` rules.

Rules make Amira ask or refuse; they are not a sandbox. A command can still reach a denied program another way, for example through a copy or link of it, or through a script the model wrote earlier. Use `deny` for mistakes worth stopping, not as a security boundary.

The user file's rules always apply. A project's `.amira/settings.json` or `.amira/settings.local.json` can only tighten: its mode counts when it is stricter than yours, its `ask` and `deny` rules apply, and its `allow` rules apply only after you trust the project (`amira ext trust`, the same trust its extension packages need). What a project file is not allowed to change is reported at startup. `--permission-mode` wins over every file. `/permissions` lists the mode, every rule with the file it comes from and what was left out; `/status` shows the mode and the number of rules.

Some files always ask before `write`, `edit` or `apply_patch` (or an extension tool that declares the paths it writes) changes them, in every mode: `.amira` directories (settings, packages and lock files) and Amira's user directory, `.git` (hooks, config and the rest of Git's metadata, including a linked worktree's Git directory), `.gitmodules`, the directory `core.hooksPath` names and your global Git config. Other names for the same file count too (a different case, `../`, absolute or MSYS paths, links). **Shell commands can still change these files: commands do not run in a sandbox yet.**

A refused call tells the model why and that asking you is the way forward. In print mode, and in RPC once no client can answer, anything that would ask is refused with the reason. Print mode also hides `ask_user` and other tools that need a UI from the model (sub-agents included), and its system prompt says the run is non-interactive, so the model decides for itself. Use `auto` mode or rules for unattended runs.

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
| Name or clear the current session name | `/rename [title]` |
| Continue in a copy of this session | `/fork` |
| Rewind to an earlier user message | `/rewind`, or `/rewind <n> [--yes]` |
| Delete a stored session without the UI | `amira sessions rm <session-id>` (`-C <dir>` for another directory) |
| Compact older context now | `/compact` or `/compact <instructions>` |

Do not combine `-c` and `-r`. Session IDs begin with `s_`; use the actual ID shown in the list. `/clear` starts a new stored session, keeping the previous one available to resume. `/resume` keeps the current model selected; when no model is selected, the stored model can be used. Top-level background jobs survive `/clear`, `/resume` and `/fork`, and the new session can list, read and stop them; jobs owned by a sub-agent still stop when that sub-agent ends. All background jobs stop when Amira exits.

After a session's first successful turn, Amira asks the model for a short title (at most six words and 60 characters, in the conversation's language) in the background; it uses `compact.model` when set, otherwise the current model, and never holds up the conversation. Print mode and sub-agents do not request titles. The request's cost appears in `/cost` and `/status`. A `/rename` name always wins over the automatic one; `/rename` without an argument clears that manual name and shows the latest automatic title again. Set `"sessions": { "autoTitle": false }` in user or project settings to turn it off. Titles show in `/status`, `/resume`, `amira -r` and the terminal title, alongside the directory name.

Typing in the `/resume` picker searches titles and the user and assistant text of whole conversations, compacted history included; matching is a case-insensitive substring, so Chinese or Japanese needs no spaces, and the matching text shows under the row. Ctrl+D deletes the selected session after a confirmation; the current session is never listed. Deleting removes the session file, its captured file history and saved artifacts, and the sub-agent sessions it started (with theirs), except ones a fork still uses. If another running Amira process has the session open, deletion refuses with a message; a crashed process leaves a lease that becomes stale when its PID is gone, so the session can still be removed.

`/fork` copies the current branch of the conversation into a new session that records where it came from, named `<title> (fork)`, and switches to it; messages abandoned by an earlier rewind are not copied, and the original stays as it was.

Automatic compaction normally starts at 80% of the model's context window. It reduces older context while keeping recent conversation. Compatible providers can use native compaction; otherwise Amira writes a text summary. Instructions passed to `/compact` force a text summary. See [Providers](providers.md) and [Settings](settings.md) for the conditions and options. `/context` shows what occupies the context window.

Press Esc twice in succession, or run `/rewind`, to open the rewind picker in either fullscreen or inline mode. Select a previous user message, then choose **Restore files too** or **Conversation only**. File restoration is selected by default when there are captured changes after that message; the picker previews how many files will be restored or removed and lists conflicts. That message and everything after it leave the active conversation, and the prompt returns to the editor for changes and resubmission. In the picker, F forks instead: a new session ends before the selected message on the current branch, so messages abandoned by earlier rewinds are not copied; the current one stays whole, and no files are restored. Only messages still present after compaction can be selected; a stored session is required. A popup, text selection or dialog can consume Esc first, so follow the current hint line.

`/rewind <n>` goes directly to before the n-th most recent user message and asks for confirmation showing that message, the number of messages it will cut, file restore/remove counts and conflicts. Like the picker's default, it restores captured files when there are any; a conflict refuses the whole rewind. In print mode, and when an RPC client cannot answer the confirmation, it refuses without changing the session; use `/rewind <n> --yes` only after checking the preview you intend to apply. `/rewind` without a number is available in the terminal UI because it needs the picker.

A turn starts with a user prompt. Rewinding to before it restores each affected file to its bytes before the first captured mutation after that prompt, and removes files that did not exist then. Capture covers only Amira's `write`, `edit` and `apply_patch` tools and extension tools that declare the paths they write, including file-tool writes by sub-agents in the same directory or a subdirectory of it. **Shell commands, formatters run by hooks, other processes, user edits and sub-agents in separate worktrees are not captured.** Before restoring anything, Amira compares all affected files with the journal's expected last contents. Any mismatch, including an external change between captured writes, refuses the entire restore and leaves the conversation unchanged. Resolve the listed conflicts or choose conversation-only rewind. Stop active sub-agents before rewinding.

File bytes, including binary pre-images, are kept by hash in `<session-id>.assets/files/` beside the session's JSONL recording. The journal records paths, pre/post hashes, prompt, turn and tool call. Settings `fileRewind.maxFileBytes` (default 10485760, 10 MiB) and `fileRewind.quotaBytes` (default 268435456, 256 MiB of unique images per session) bound storage. Both pre-images and post-images must fit the size cap: refusing oversized new contents also keeps future restores bounded. Failure to store an image or journal entry refuses the tool write. Paths are recorded as real paths, with symbolic links, junctions, letter case and short names resolved, so a file reached two ways is one file; if a recorded path later leads elsewhere (a directory on it replaced by a link, say), it counts as a conflict. A file with other hard links is restored in place, so every link sees the restored bytes; a hard-linked file that was deleted comes back as a separate file. Set `"fileRewind": { "enabled": false }` to opt out; the picker then says files will not be restored.

Captured history lasts as long as the session, across conversation branches and restarts. `/rewind-prune` explicitly discards all captured file history for the current session and frees its quota; earlier changes can no longer be restored, but later writes start a new history. There is no automatic eviction. Deleting a session (Ctrl+D in `/resume`, or `amira sessions rm <id>`) also deletes its captured file history; when deleting recordings by hand, remove the matching `<session-id>.assets` directory too. `/fork` gives the new session its own copy of the history, so either can be deleted. A restore records its plan and progress before checking out the conversation. Resuming the session finishes an interrupted restore after rechecking all files, including ones already restored; conflicts stop recovery without further writes, and Amira says so when the session opens. Until the restore finishes, file tools cannot write and the session cannot be forked. An interrupted core restore that can still finish must finish before choosing conversation-only rewind or an extension owner, even if capture is subsequently disabled; one that conflicts, or an error in this run such as a locked file, keep from finishing is abandoned by choosing conversation-only rewind, leaving the files as they are. File restoration concerns bytes, not empty directories or shell side effects.

The checkpoints extension can take exclusive ownership with `api.registerFileRestoration({ label, restore: async (index) => { /* restore bytes */ } })`. The picker shows its label; the host calls it before rewinding the conversation and does not run the core restore. The callback must restore files only (do not call `session.rewind` recursively), and throw on conflicts. Conversation-only rewind skips it. Unloading the extension releases ownership; only one extension can own restoration at a time.

## Context management

The session file always keeps every message and tool result whole. What each model request carries is a projection of that history: large outputs are previewed, repeated reads are shortened and, when the context gets full, old tool results can be cleared. Previews, `/context`, compaction summaries, sub-agent forks and parent consultations all use the same projection. Once a result has been sent in a shortened form, later requests repeat exactly the same text, so the provider's prompt cache keeps its prefix.

**Large outputs.** Tool output longer than 16,000 characters is saved whole as an artifact next to the session file, in `<session id>.assets/outputs/` (sessions without a file use the system temp directory). The model gets a preview of about 8,000 characters instead: a first line with the artifact ID (`a_…`), its size and how to read more, then the start and end of the output with a note where lines were left out. Sizes are counted in characters, with a Chinese, Japanese or Korean character counting as four, since each takes about a token: such output is saved sooner and gets a shorter preview, and `read` stops sooner. This applies to `bash` and `powershell`, to `grep` and `glob` (which save all results, before their own result limits) and to the results of MCP servers and other tools. `read` does not save artifacts: a long range stops at a whole line under the limit and says which `offset` to continue from. In the terminal UI a saved output shows its preview, with the header as a short muted line.

The model reads artifacts with `output_read`: `offset` and `limit` select lines, `grep` returns matching lines (`ignore_case` for case-insensitive), and `column` pages through very long lines. `read` also works on the artifact's file path. An artifact holds what the tool returned at that time; reading the source file shows it as it is now.

**Repeated reads.** When a `read` returns exactly the same text as the latest read of the same file and line range that is still in the context, only the new result is sent as a short note pointing to the earlier one. Earlier results are never rewritten. A changed range, a different range or an earlier read that was compacted or cleared is sent in full. The model can pass `force: true` to get the text anyway.

**Aging.** When the next request is expected to pass 70% of the context window, Amira clears old tool results in one batch until about 60% is left. Each cleared result is sent from then on as a short stub saying what it was and how to get it back: its artifact ID for `output_read`, or for a read the file to read again. The most recent two user turns are kept, or in a long turn its last two model steps, along with results that later calls are still working on. A round that would free fewer than 8,000 tokens (or, in a small window, less than the space between 70% and 60%) is skipped. Aging only rewrites history where the provider allows it: nothing before signed or encrypted reasoning that the request would send back is changed, so with such models compaction does the work. When a request is rejected as too long, one aging round is tried before compacting. The experimental `afterTurns` option also clears results older than that many user turns regardless of pressure; it is off by default.

**Keeping and pruning artifacts.** Artifacts live as long as their session; nothing deletes them automatically. A session keeps at most 256 MB of them; past the quota, outputs are only previewed and the preview says they could not be saved. `/prune` shows how many artifacts are active (mentioned in the context the model sees), inactive (mentioned only in compacted or rewound history, or a sub-agent's) and unused, grouped by the parent and each stored sub-agent session. `/prune unused`, `/prune inactive` and `/prune all` apply the same rules to every group; while a sub-agent is running, queued or idle (a persistent one waiting for its next message), pruning refuses until it finishes or is stopped, so nothing it may read is removed. Reading a pruned artifact says it was pruned.

| Action | Command |
| --- | --- |
| Show artifact usage | `/prune` |
| Delete unreferenced artifacts | `/prune unused` |
| Also delete ones only old history mentions | `/prune inactive` |
| Delete every artifact of this session | `/prune all` |

The defaults can be changed under `context` in settings:

```json
{
  "context": {
    "outputs": { "saveAbove": 16000, "previewChars": 8000, "quotaMB": 256 },
    "dedupeReads": true,
    "aging": {
      "enabled": true,
      "start": 0.7,
      "target": 0.6,
      "minSavedTokens": 8000,
      "keepTurns": 2,
      "keepSteps": 2,
      "afterTurns": 0
    }
  }
}
```

`saveAbove` is at least 4000 and `previewChars` at least 500 (it is never larger than `saveAbove`); `start` and `target` are shares of the context window between 0 and 1. Set `dedupeReads` or `aging.enabled` to `false` to turn those off.

## Print mode

```sh
amira -p "Summarize the changes in this repository"
amira -p -c "Continue the review"
amira -p --json "Explain the failing test"
amira -p --json --json-coalesce "Explain the failing test"
amira -p --json-out events.json "Explain the failing test"
amira -p -- "-v means verbose?"
```

`-p` / `--print` runs without the interactive UI and needs a prompt, except when listing sessions with bare `-r`. Plain mode streams reply text to stdout and tool activity, warnings and errors to stderr. `--json` requires print mode and writes each event as one ASCII-only JSON line to stdout; non-ASCII string characters are escaped as `\uXXXX`, so a Windows parent can decode the stream without a code-page mismatch. `--json-out <path>` implies `--json` and writes the same JSONL event stream to the file instead of stdout; a relative path is resolved from where Amira was invoked. These lines include session, turn, message, tool and sub-agent events, rather than one final JSON answer.

JSON print output omits empty `ui.render` events and includes a tool-call name only on its first delta unless the provider changes it. `--json-coalesce` merges consecutive text, thinking and same-tool-call argument deltas into larger JSONL chunks, each written once it reaches 4,096 characters or 100 ms; without it, each remaining event stays a separate line. When `--json-out` ends with an error, the event file still contains the stream and a short failure summary is printed to stderr.

A quoted slash command such as `amira -p "/status"` runs the command instead of sending a model prompt. Skills can also run this way when available. Commands requiring a picker cannot obtain interactive answers; supply explicit arguments where supported.

Print mode waits for top-level background shell jobs started during the run, up to `backgroundJobs.printWaitMs` (30 seconds by default), and delivers their end notices to the model for a follow-up turn. It also waits for background sub-agents and the follow-up turns their results start. If the job wait expires, Amira prints a note and stops those jobs on exit. Configured budgets still apply. Failed result-delivery turns can be retried up to three times after 10, 30 and 90 seconds. Ctrl+C aborts and stops waiting; a second Ctrl+C forces exit. The exit codes are 0 for completion, 1 for errors and 130 for an aborted turn.

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

`/status` reports the model and provider, session ID and file, context use and window, output tokens, cache hit rate, last-reply speed, known costs, shell, permission mode and rule count, and Git workspace. The speed shows reply and thinking tokens per second separately; `~` marks an estimate: tokens counted from the text because the provider reported no separate reasoning count, or thinking timed from the request because only a summary of it streamed. `(hidden reasoning)` means the model reasoned without streaming its thinking. Resumed sessions include usage from earlier runs. The status bar reports tree usage since the current run started; `/status` can include the stored session and its sub-agents.

`/cost` reports this session's replies by model, and compaction and session-title requests separately; it does not aggregate child-agent costs. Use `/status` and `/agents` for those. Costs depend on known model pricing and reported usage; unknown prices are identified, and totals with unpriced rows are partial estimates. Provider billing remains the source for actual charges.

Related: [Getting started](getting-started.md) · [Providers](providers.md) · [Sub-agents](subagents.md) · [Extensions](extensions.md) · [Settings](settings.md) · [Keybindings](keybindings.md).

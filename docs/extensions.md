# Using and writing extensions

[简体中文](zh/extensions.md) · [Documentation](../README.md)

Extensions add tools, commands and UI behavior. Installed packages can contain multiple extensions, skills and top-level CLI commands. They run code on your computer with your permissions.

## Find and manage packages

```sh
amira ext search
amira ext search workflow
amira ext list
amira ext help
```

Search uses the official index in [CAMB-dev/amira-extensions](https://github.com/CAMB-dev/amira-extensions). A cached copy is normally reused for an hour; `--refresh` fetches it again. `AMIRA_EXTENSIONS_INDEX` can point to another index URL or a local index file. The index lists packages and their sources; searching does not install them. That repository also holds the official extensions themselves, each with its README: workflow and swarm (see [Sub-agents](subagents.md#workflow-and-swarm-extensions)), lsp diagnostics, file checkpoints, hooks, todo, notify, share, browser, images and mermaid.

Use a name returned by search, a local directory, a git URL with an optional ref, or an npm package source:

```sh
amira ext install <name>
amira ext install ./my-extension
amira ext install https://github.com/owner/repo.git#main
amira ext install npm:package-name
amira ext update <name>
amira ext disable <name>
amira ext enable <name>
amira ext remove <name>
```

These commands accept multiple package names or sources. Update without names updates all packages in the selected scope. Install without sources restores missing packages from that scope's lock file. Disable keeps the package and its lock entry; remove deletes both. Use `--quiet` for just results or `--json` for result objects, one per line, with install, update and remove.

Install copies a local directory into the package scope; it is not a live link. After editing the source directory, install it again. Git commits and npm versions are pinned exactly in `packages.lock`; update resolves the source again and writes new pins.

Restart Amira or run `/reload` while idle to load package installs, updates, removals and enable/disable changes. `/help` lists the commands registered by loaded extensions.

### Managing packages inside Amira

`/ext` does the same work without leaving a session. On its own it opens a list of installed packages (with their scope, whether they are enabled or trusted, and whether the index has a newer version) followed by the packages available from the index. Enter on an installed package offers update, enable or disable, remove and details; Enter on an available one asks for user or project scope and installs it. `d` shows details. See [Keybindings](keybindings.md#dialogs) for the keys in the list.

```text
/ext
/ext search lsp
/ext install todo
/ext install todo --project
/ext update
/ext disable todo
/ext remove todo --project
```

`install`, `remove`, `disable` and `enable` take one name; `update` takes any number, or none for every package in the scope; `--project` selects the project scope for install, update and remove. The rules match the CLI: project installs still need the project to be trusted, and disable and enable apply to both scopes through user settings. Install and update show a progress panel while you keep typing. Esc or Ctrl+C cancels the running operation and keeps your draft; an install is all or nothing, and updates already finished are kept.

`/ext` never reloads on its own. When it changes something it suggests `/reload`, or running it after the current turn. `/reload` refuses to run until an `/ext` operation ends. A package installed into an untrusted project is loaded once you trust the project at the next start or with `amira ext trust` and a restart. In print and RPC modes the subcommands work as quoted slash commands; the list needs the interactive UI.

## User scope, project scope and trust

The default scope installs to `~/.amira/packages`, with a lock file at `~/.amira/packages.lock`. `AMIRA_HOME` moves that user directory. Add `--project` to install, update or remove in the current project's `.amira/packages`; its lock file is `.amira/packages.lock`.

```sh
amira ext install ./my-extension --project
amira ext update --project
amira ext remove <name> --project
amira ext trust
amira ext untrust
```

A trusted project package replaces a user package with the same name. Without trust, the project package is skipped and the user package can still load. On the first interactive start in a project with packages, Amira asks **Load them? [y/N]** and remembers the answer in user settings. Print and RPC modes cannot ask and leave out project packages without prior trust.

The same trust lets the project's `allow` [permission rules](usage.md#permissions) apply; its `ask` and `deny` rules apply either way.

Run trust or untrust from the project directory, then restart Amira. These decisions, and the disabled-package list, are stored in user settings; project settings cannot grant their own trust or re-enable packages. Disabling a name affects both scopes.

Use `--no-packages` to skip every installed package for one run. Explicit files supplied with `--extension` still load. Only install packages whose code you intend to run.

## Package manifest

A package describes its contributions in `amira-package.json`, or in the `amira` object inside `package.json`. Extension and skill paths stay inside the package. The manifest can declare:

| Field | Purpose |
| --- | --- |
| `name` | Lowercase npm-style package name |
| `version` | Semver version; defaults to `0.0.0` when omitted |
| `engines.amira` | Supported extension API version range |
| `extensions` | Extension module paths |
| `skills` | Skill directory paths |
| `commands` | Top-level CLI command names mapped to modules |

The engine range describes the extension API, not the CLI release version. The exported `API_VERSION` in [the public API](../packages/api/src/index.ts) gives the current value. Without an extension list, Amira looks for `index.ts`, then `src/index.ts`. A command-only package can omit an extension entry.

## A complete small extension

Create a directory named `hello-extension` containing these two files. It adds a user command and a status counter; it sends no model request.

`amira-package.json`:

```json
{
  "name": "hello-extension",
  "version": "1.0.0",
  "engines": { "amira": "^0.1.7" },
  "extensions": ["index.ts"]
}
```

`index.ts`:

```ts
import { defineExtension } from "@amira/api"

export default defineExtension((api) => {
  const configured = api.settings.extensions?.["hello-extension"]?.message
  const message = typeof configured === "string" ? configured : "Hello from an extension."
  let greetings = 0

  api.registerStatusItem({
    id: "hello-extension.count",
    align: "right",
    text: () => greetings > 0 ? `Hello: ${greetings}` : undefined,
  })

  api.registerCommand({
    name: "hello",
    description: "Print a greeting and update its status counter",
    run(_args, ctx) {
      greetings += 1
      ctx.print(message)
      api.requestRender()
    },
  })
})
```

From the project where you want to use it:

```sh
amira ext install ./hello-extension
amira
```

Run `/hello`. Each call prints the greeting in the transcript and updates the status item. The counter belongs to this loaded extension: restarting or reloading resets it, and it is not stored in the session.

Optionally customize the greeting in settings:

```json
{
  "extensions": {
    "hello-extension": { "message": "Welcome to this project." }
  }
}
```

Restart after changing this setting. You can also develop a standalone extension file with `amira --extension ./hello-extension/index.ts`. This loads the file directly without installing its manifest. The option is repeatable; relative paths are resolved from the directory where the command starts. Amira supplies the runtime import of `@amira/api`, including for standalone files; no separate runtime install of that package is needed.

## API guide

Default-export a function, usually wrapped in `defineExtension`. Amira calls it with `ExtensionAPI` when loading the extension. It may return a promise. Import the public extension API from `@amira/api`; see [packages/api/src](../packages/api/src) for complete types.

| API | What it adds or does |
| --- | --- |
| `registerTool`, `defineTool`, `textResult` | A model tool with a JSON schema and an async executor; return text or image content and optional renderer details |
| `registerCommand` | A slash command with arguments, completion and optional aliases; its command context prints output and controls the session |
| `registerSkill` | A skill the user invokes with a dollar-prefixed name |
| `registerInputHandler` | Handle matching ordinary input before it reaches the model |
| `registerStatusItem`, `requestRender` | Read live state into the status bar; request a redraw after state changes |
| `on`, `intercept` | Subscribe to typed events or intercept documented model/tool/context stages |
| `complete` | Make a host-accounted side model call without tools or hosted web search |
| `session` | Access the current top-level `SessionControl` outside commands, when the host has injected it |
| `ui` | Ask through select, confirm, input, form and review dialogs; the command context also exposes UI requests |
| `registerPanel` | Render live lines above the activity line |
| `registerView` | Register a full-screen view kind; commands open it through `openView` when the frontend supports it |
| `registerToolRenderer`, `decorateToolRenderer` | Present tool calls and results, or wrap an existing presenter |
| `serverToolView` | Turn provider-hosted tool blocks, such as native web search, into the same tool-call view shape used by presenters |
| `registerMarkdownRenderer`, `registerImageProvider` | Render matching reply code blocks or standalone images and supply terminal image data |
| `provideService`, `useService` | Share named extension services; look them up when needed because a provider may be absent or unloaded |
| `settings`, `cwd`, `home`, `apiVersion` | Read merged settings, provenance layers for each top-level key, the working directory, the user directory and API version |
| `backgroundJobs` | Start and inspect only this extension's background jobs; built-in frontend code uses the host-only `hostBackgroundJobs()` capability |
| `runCommand`, `openPipe`, `onExit` | Run managed subprocesses, open a long-lived piped process, or register short exit work |
| `notify`, `reportError` | Show a notice or report a background failure |
| `registerFileRestoration` | Take over rewind's file restoration (for example a checkpoints extension): the picker shows your label and the core restores nothing; one owner at a time, released on unload |

### Full-screen views

Register a `ViewDefinition` with `api.registerView()` and open it from a command with
`ctx.openView?.({ kind, data })`. Views return structured `ViewLine` objects; the frontend owns
the terminal, wrapping, scrolling, prompts and confirmations. The `subagent` kind and
`/agents` command are registered by the built-in agent extension. Without that extension,
opening a child from a transcript block reports that the live view is unavailable.

`title(data, opts)` returns `string | ViewLine` for the first line. A string keeps the
default `◆` marker; a semantic `ViewLine` supplies the whole title without an automatic
marker. The frontend truncates either form to the available title space.
`titleAside(data)` adds short text kept at its right end, such as `2 of 5`.

`ViewLine` supports semantic content without ANSI escape codes. Frontends own its styling:

- `{ kind: "segments", parts: ViewSegment[] }` combines styled text into one line,
  truncated by the frontend rather than wrapped. The exported `ViewSegment` type is
  `{ text: string, kind: "text" | "muted" | "accent" | "success" | "warning" | "error" }`.
- `{ kind: "user-message", text: string, note?: string }` renders like a transcript user
  message, including wrapping, background and spacing. Supply only the message text; do
  not add a `›` marker yourself. An optional note appears below it, inside the same band.

Keys can be one printable character or `left`, `right`, `tab`, and `shift-tab`. Keys with
the same label share one footer item (`←→ switch`); an empty label keeps a key, such as an
alias, out of the footer. Esc, q, Ctrl+C and scrolling keys remain frontend-owned. A handler receives `ViewControl` to
close, request a redraw, print a snapshot with `print(text, level?)`, prompt or confirm.
Printing uses the command output levels (`info`, `warning`, `error`); close first to return
to the conversation immediately.

Use `scrollKey(data)` to return the selected child's or tab's id. The frontend preserves
each id's scroll position and following state until the view closes. Without it, a view
has one scroll state. `follow: false` starts each new id at its top.

Read live snapshots through `api.session()` and subscribe to events with `api.on()`;
call `api.requestRender()` when your state changes. The TUI also redraws open views every
second for elapsed times. `header` and `render` receive the available width, current time
and an optional `renderTool(toolName, call, detail)` callback. It uses the host's current
tool presenter and fallback renderer; pass a `ToolCallView` and return the resulting lines
unchanged to preserve the host's presentation. Other frontends may omit it, so provide a
plain-line fallback. API version 0.1.15 adds these view capabilities.

### Declarative view widgets (Experimental)

D104 L3 adds an experimental `ui(data, ctx): UiNode` path to `ViewDefinition`, without changing `API_VERSION`. Import its types only from `@amira/api`; no TUI or tui-kit dependency is needed. Supply `ui` or the existing `render`. When `ui` is present it replaces the title, header and line-rendered screen content; `title` is still required for window/fallback presentation. Existing line-only views, including `/agents` and job views, keep their current behavior.

```ts
import type { ViewDefinition } from "@amira/api"

const review: ViewDefinition<{ messages: string[] }> = {
  kind: "review",
  title: () => "Review",
  ui: (data) => ({
    type: "column",
    children: [
      { node: { type: "text", id: "log", follow: true,
        lines: data.messages.map((text) => ({ kind: "text", text })) } },
      { size: 3, node: { type: "box", title: "Message the team",
        child: { type: "input", id: "message", placeholder: "Ask for a review…" } } },
    ],
  }),
  onEvent(event, data, view) {
    if (event.type === "submit") {
      data.messages.push(event.value)
      view.setState({ inputValues: { message: "" } })
    }
  },
}
api.registerView(review)
```

The exported `UiNode` union uses `type` as its discriminator. All content is semantic: text and `ViewSegment` meanings, not colors or raw escape sequences. Every displayed string is sanitized exactly like existing view lines, including titles, labels, cells, hints and input values. Long rows are cut with an ellipsis; text lines retain existing wrapping. The host owns theme, clipping, input and the terminal.

| Widget | Content and options |
| --- | --- |
| `column`, `row` | `children: { node, size?, min? }[]`, `gap?`, `divider?` |
| `box` | `child`, `title?: ViewLine \| string`, `aside?`, `border?: "round" \| "none"`, `tone?: "normal" \| "accent" \| "focus"` |
| `text` | `lines: ViewLine[]`, optional `id`, `follow?` (default false) |
| `tree` | `id`, `items: UiTreeItem[]` |
| `tabs` | `id`, `tabs: { key, label, body }[]`; only the active body is laid out |
| `table` | Optional `id`, `columns: { key, label, size?, align?: "left" \| "right" }[]`, `rows: { key, cells: Record<string, string \| ViewSegment[]> }[]` |
| `bar` | `left: ViewSegment[]`, optional `right: ViewSegment[]` |
| `progress` | `value` from 0 to 1 (clamped), optional maximum bar `width` and `label` |
| `rule` | Optional `label` |
| `input` | `id`, optional `placeholder` and `hint`; use a visible label such as a box title |
| `spacer` | Optional default main-axis `size` in cells |

`Size` is `number | \`${number}%\` | "fill"`: fixed cells, a percentage of the main-axis budget after gaps/dividers, or an equal share of the remaining budget. Omitted sizes mean fill (except a spacer's explicit size). Each divider adds one cell beyond `gap`. Feasible minima are reserved before shrinking excess requests proportionally; minima themselves shrink only when their sum cannot fit, rounding cells in source order. Rectangles never become negative, and box borders disappear below eight columns or three rows. Table headers and cells share one column allocation with one-cell gaps. Use `ctx.width` to choose a different composition for narrow terminals.

`UiTreeItem` has a stable `key`, semantic `row`, optional semantic `aside`, `detail: ViewLine[]`, `children`, `rail`, and `expandable`. Details and children appear only while expanded. `expandable: true` shows disclosure before children have loaded; handle a toggle to load them. Trees start collapsed. Use separate boxes next to or below a tree for worker cards: details are lines, not arbitrary widget subtrees.

`UiContext` extends `ViewRenderOptions` with host-kept `state: UiState`. Maps are keyed by stable, view-wide unique widget IDs: `selected` holds tree/table item keys, `expanded` holds arrays of tree item keys, `activeTabs` holds tab keys, `scroll` holds `{ top, following }`, and `inputValues` holds strings. `focused` is an optional widget ID. State survives rerenders, same-kind data replacement and inactive tabs until the view closes. Missing selections or tabs fall back to the first visible item or tab; absent focus falls back to the first visible widget. Treat context state as read-only and keep `ui` free of side effects: the host may rebuild it within a frame after repairing selection, tabs or focus so dependent details agree with the controls. Unstable content fails safely after eight attempts. ID-less text/tables can be wheel-scrolled, but stable IDs are needed for keyboard focus and explicitly managed state.

`onEvent(event, data, view)` receives `select`/`activate` with `{ id, key }`, `toggle` with `{ id, key, expanded }`, `tab` with `{ id, key }`, `submit` with `{ id, value }`, or a declared `key` with `{ key, focused? }`. Events use the `type` discriminator. Declare shortcuts in `keys` (for example, `keys: [{ key: "x", label: "stop" }]`); declarative views receive them through `onEvent` rather than the legacy `run` callback. Undeclared keys do not emit events. The host changes state before invoking the handler, so `view.setState(patch)` can override the default. Patches are shallow: each supplied top-level map replaces that map, not individual entries. Use `{ ...ctx.state.selected, [id]: key }` when preserving other entries. `view.focus(id)` focuses a visible widget. Existing `close`, `requestRender`, `print`, `prompt` and `confirm` methods remain available. Submitting does not automatically clear an input.

Tab/Shift+Tab traverse visible trees, identified tables/text, tab strips and inputs. Tree Up/Down selects, Right expands, Left collapses or selects the parent, and Enter activates. Tables select with Up/Down and activate with Enter. Tab strips switch with Left/Right; input Enter submits. Paging/Home/End scroll the focused scrollable, and the wheel scrolls the widget under the pointer without moving focus or selection. Text follows growth only with `follow: true` or after scrolling to the end; scrolling up stops following. Widget keys take precedence over declared shortcuts; remaining declared keys reach `onEvent`. Esc, q and Ctrl+C retain the host's close rules, **including q inside a declarative input**. Only the existing prompt overlay temporarily takes these keys. Prompt/confirm overlays suspend widget input and own the cursor.

Views redraw on input, data updates and `requestRender`; no widget animation timer is added. Expanded tree rows are indexed once per preparation pass and only viewport rows are painted. The test-only semantic dashboard proof and its 180×52/80×24 snapshots live under `packages/tui/test/ui-runtime`; run `bun packages/tui/test/ui-runtime/benchmark.ts` for the reproducible 500-item nested-tree benchmark at 180×50.

### Tool capabilities

Declare a tool's host-visible capabilities in `traits` instead of relying on its name. `readOnly: true` allows the tool in plan mode; `writesFiles: true` marks a file writer, while `writesFiles: "paths"` declares that `getWrittenPaths(params, { cwd })` returns every path the call may write, relative to `cwd` or absolute. A writer with a valid path report receives the same protected-path checks as built-in file tools, and the host captures its pre- and post-images for rewind; a missing or invalid report is treated conservatively and asks for approval. A tool that already uses `ctx.mutateFiles` should set `usesMutationHook: true` so the host does not add a second rewind boundary.

Set `shell: "bash"` or `shell: "powershell"` for a command-running tool; use `shellKind()` as well when the actual shell is selected at runtime. Set `editor: "edit"` or `editor: "apply_patch"` when the tool is an editing-tool replacement, `artifactReader: true` for a tool that reads saved output, `toolSearch: true` for the deferred-tool loader, or `interactive: true` for a tool that needs a UI. `readKey(params, { cwd })` can identify repeatable direct file reads for context deduplication. Omitted traits remain unknown: permission checks, rewind and workspace refresh keep their conservative behavior, and MCP tools currently declare no known traits.

Traits are trusted: an extension runs as your own code, so a tool that claims `readOnly` or reports fewer paths than it writes is believed, for its own name. A declaration cannot weaken a built-in name, though. A tool registered under `write`, `edit`, `apply_patch`, `bash`, `powershell` or `ask_user` (an `override`, say) keeps the capabilities that name implies whatever it declares: `write`, `edit` and `apply_patch` are always file writers checked against the paths their arguments name as well as any they report, `bash` and `powershell` are always shell tools under your command rules (bash read both ways unless `shellKind()` answers), and none of them counts as read-only in plan mode. A tool that both writes files and runs a shell is checked as both. Rewind captures a declared writer's reported paths only, and `usesMutationHook: true` tells the host the tool captures its own writes through `ctx.mutateFiles`; a tool that says so and does not is not captured. While the host captures a declared writer, the whole call holds the session's file-capture queue: other file writes (sub-agents in the same directory included) wait for it, so keep such a tool short and never have it wait for another agent's file writes.

`serverToolView(block)` returns the provider tool's name, arguments, result text and native search details (sources included), plus `rejected: "aborted"` when a block never finished. Use its `ToolCallView` fields with an existing tool presenter or another frontend; it is render-only and must not be sent back as a local tool result.

A command opens the rewind picker that double Esc opens with `ctx.openRewind()`; it is set only where the frontend has the picker (the terminal UI) and returns false when the picker cannot open now, for example during a turn.

Extension-specific settings belong under `extensions` with the extension name. The settings snapshot is deeply frozen; validate your own section. `api.settings.layers(key)` returns the explicit values for a top-level key in precedence order, each with `scope` (`user`, `project`, `project-local` or `flags`), `file` and `value`; missing keys return an empty list. The host supplies a fresh snapshot and layer map whenever it reloads settings, including `/reload`, so an extension can reconcile long-lived resources without reading settings files itself. Print mode cancels UI dialogs; RPC clients answer them through the protocol. Panels, views, tool presenters, Markdown renderers, image providers and services are experimental APIs.

`runCommand` resolves once the command has exited. Pass `onChunk` to get output as it arrives, for example to show progress from a long `git` command. Abort through `signal` (or let `timeoutMs` expire) and the whole process tree is killed; the result then reports `aborted` or `timedOut`. By default, `output` keeps only the last 1,000,000 characters; override that limit with a positive-integer `maxOutputChars` (invalid values reject the call). `onChunk` still receives everything, and `truncated` reports whether `output` was cut. A cut never splits a UTF-16 surrogate pair.

`complete({ messages, system?, model?, maxTokens?, signal?, label? })` makes one model request outside the conversation, with no tools and hosted web search off, and resolves with the reply's text, message and usage. It defaults to the session's current model (`model` takes a `provider/model` reference). Every such request spends your tokens: its usage is saved in the session and shown in `/cost` under `label` (the extension's source when unset) and counts toward the agent tree's `budget`; once the budget is spent the call rejects without a request. A reasoning model gets at least 2,048 output tokens (within its limit) so it can answer after thinking. Provider errors reject the promise and an aborted `signal`, or unloading the extension, rejects it with an `AbortError`. `session()` returns the top-level session's `SessionControl` once the host has built it; `rename(title, { source: "auto", sessionId })` never replaces a name set with `/rename` and does nothing when `sessionId` is no longer the current session.

### Session thinking effort

API 0.1.20 adds `SessionControl.setThinking(level: ReasoningEffort | undefined): void`. Get the control from a command's context or `api.session()`; the latter can return `undefined` before the host injects it. Accepted levels are `low`, `medium`, `high`, `xhigh` and `max`. The override is session-only, writes no settings, and takes precedence over `--thinking`, the per-model setting and the top-level setting, in that order. Passing `undefined` explicitly suppresses all of those sources so no effort is sent and the server default applies; it does not remove the runtime override.

`setThinking` throws while a turn, compaction or reload is running. The choice is retained for later thinking models and inherited by sub-agents spawned after the change. Like the current model, it carries over to the conversation that `/clear`, `/resume`, a rewind or a fork switches to; it is kept in memory only, so a new Amira process starts from the flag and settings again.

`ui.select(title, options, { initial, signal })` accepts an optional `initial` option label to highlight when opening the picker. Without a matching label, it highlights the first option. Dismissing a picker returns `undefined`; the built-in effort picker leaves the current choice unchanged.

`SessionControl.info()` returns these `SessionInfo` fields:

| Field | Meaning |
| --- | --- |
| `thinking?: ReasoningEffort` | The effort sent to the current model; absent when unset or the model does not support thinking |
| `thinkingLevel?: ReasoningEffort` | The effective choice regardless of the current model's capability; retained when switching to a non-thinking model |
| `supportsThinking?: boolean` | Whether the current model supports thinking; the Amira host supplies a boolean |

The typed event `thinking.changed` has payload `{ thinking?: ReasoningEffort }` and is emitted on runtime effort changes. Its `thinking` field has the same capability-gated meaning as `info().thinking`, not `thinkingLevel`. For live displays, read `api.session()?.info()` and redraw on `thinking.changed`, as well as model and session changes. Ignore events with a `parentSessionId` when displaying only the top-level session. The built-in status bar shows effort beside the model name only when `info().thinking` is set.

### Session traces

The host records per-session observability traces (D103); the viewer lives in a separate repository. This is not an extension that must be loaded, and it does not change the agent loop or `API_VERSION`. A persisted session at `<session file>` has a companion `<session file>.trace.jsonl`; each persisted child has its own companion beside its session file under `subagents/`, including nested descendants. Ephemeral sessions and sessions whose conversation file has not been created produce no trace file.

`SessionControl.trace(sessionId?: string): Promise<TraceRecord[]>` reads the current session by default, or a descendant listed by `subagents()`. Get the control from `api.session()` or a command's `ctx.session`. Unrelated IDs, sessions without traces and missing files return `[]`; this is not an arbitrary file-reading API. The result is a snapshot of completed records, including completed recorder buffers flushed for the read, not synthesized intervals for work still running. It does not drain the event bus, so events not yet delivered to the recorder may be absent; calling it from an event listener does not wait on that listener. Readers skip malformed or torn lines and runs with unsupported versions.

```ts
import { summarizeTrace } from "@amira/api"

const session = api.session()
if (session) {
  const records = await session.trace()
  const summary = summarizeTrace(records)
  const child = session.subagents()[0]
  const childRecords = child ? await session.trace(child.id) : []
}
```

Writes are asynchronous batches scheduled at least once per second and flushed at session end and process shutdown; they never make a turn wait for disk I/O. A recording failure is reported once per session and does not fail the agent. Trace persistence is best-effort: abrupt termination or an overloaded subscriber can lose events. Resume appends a new header to the existing trace rather than truncating it. Fork copies the conversation, not its trace; the fork starts its own trace when recorded. Deleting a session removes its trace and the traces of owned descendants, while preserving descendants still shared with another session.

#### Record format and privacy

`@amira/api` exports `TRACE_VERSION = 1`, `TraceRecord`, `ToolOutcome`, `TraceSummary` and `summarizeTrace`. Each JSONL line is one record, with a `trace` header first in every recording run. The following table lists all fields besides the `type` discriminator; fields in the optional column may be omitted. `Usage` is the public token/search/USD-cost usage type, and model strings use `provider/model` form.

| `type` | Required fields | Optional fields |
| --- | --- | --- |
| `trace` | `v: 1`, `sessionId: string`, `startedAt: number` | `parentSessionId: string`, `role: string`, `title: string` |
| `turn` | `turnId: string`, `start: number`, `end: number`, `reason: "done" \| "error" \| "aborted"`, `steps: number` | `failure: { kind: string; message: string }` |
| `model` | `model: string`, `start: number`, `end: number` | `turnId: string`, `firstToken: number`, `usage: Usage`, `stopReason: string`, `retries: { at: number; delayMs: number; kind: string }[]` |
| `tool` | `toolCallId: string`, `name: string`, `start: number`, `end: number`, `durationMs: number`, `outcome: ToolOutcome`, `argsChars: number`, `resultChars: number`, `argsPreview: string`, `resultPreview: string` | `turnId: string`, `approvalWaitMs: number`, `approval: "user" \| "rule"`, `artifact: string`, `writtenPaths: string[]` |
| `status` | `at: number`, `status: "idle" \| "working" \| "blocked" \| "error"` | `reason: string` |
| `subagent` | `childSessionId: string`, `start: number`, `end: number`, `status: string`, `durationMs: number` | `toolCallId: string`, `role: string`, `title: string`, `groupId: string`, `queuedAt: number`, `error: string`, `usage: Usage` |
| `compact` | `start: number`, `end: number`, `reason: string` | `tokensBefore: number`, `tokensAfter: number`, `usage: Usage`, `native: boolean`, `fallback: boolean` |
| `side` | `at: number`, `model: string` | `label: string`, `usage: Usage` |

All timestamps (`startedAt`, `start`, `end`, `at`, `firstToken`, `queuedAt`) come from event-envelope `ts` values in epoch milliseconds, not append times. Durations and retry delays are milliseconds. Interval records are appended when they finish, so file order is not start-time order. Turns pair `turn.start/end`; model records pair `message.start/end` and retain retries within that request. `firstToken` is the first reliably observed message delta, whether text, thinking or a tool call; it can be absent when deltas are missing or dropped. A failed turn uses the structured failure's kind and summary, or kind `"other"` for an unclassified error.

Tool argument previews are compact JSON; result previews contain text blocks only. Each preview is at most 300 Unicode code points, without splitting a surrogate pair. `argsChars` counts compact-JSON code points and `resultChars` counts emitted result-text code points; the latter may already describe an artifact preview rather than the original output. `artifact` is the saved-output ID, not its path. Images, result details and full arguments/results are not copied into traces; full content stays in session/artifact storage. Previews and paths can still contain sensitive text, so treat traces as private session data.

`ToolOutcome` is `"ok" | "error" | "denied" | "aborted" | "invalid" | "unknown-tool"`. Rejection takes precedence: `tool.execute.end.rejected` values `blocked`, `aborted`, `invalidArgs` and `unknownTool` map to `denied`, `aborted`, `invalid` and `unknown-tool`, respectively. Otherwise, `result.isError` selects `error` or `ok`; result text is not used to guess an abort. Starts and ends are matched by session, turn, call ID and tool name, using FIFO for repeated keys. Identical ID/name calls in the same parallel batch cannot be disambiguated if they finish out of order, so their associated starts/previews may be ambiguous.

`tool.execute.end.waitedMs?: number` measures only a real wait for an approver and becomes trace `approvalWaitMs`. A genuine zero-length wait is retained as `0`. The field is absent for calls that never waited, direct policy denials, missing approvers and tool-question waits. `durationMs` measures execution only, excluding approval, pre-execution checks and pre/post-call interceptors; calls rejected before execution report zero. The tool start/end event interval can additionally include scheduling and post-processing, so it need not equal `durationMs`. Concurrent approval waits can overlap and are not additional wall time.

A parent's `subagent` record describes a completed direct child and its own usage, not recursive descendant usage. `queuedAt` exists only if `subagent.start` announced a queued child; execution `start` comes from the child's actual `session.start`. A child cancelled before that announcement has `start === end`, denoting no execution interval. Reported child `durationMs` is lifetime after admission and can include idle periods for persistent children. Each child's own trace contains its turn/model/tool details.

A compaction record never contains the summary text. Successful records carry the trigger reason and optional tokens/usage; `native` and `fallback` are booleans, not the original model reference or fallback explanation. Failed attempts use `reason: "failure:blocked"`, `"failure:empty"` or `"failure:error"`; without a preceding start they have `start === end`. The `side` variant is reserved in the format, but the host currently emits no side-usage event, so no `side` records are written. Stored `side_usage` entries and budget updates are not polled or converted into traces; use `sideRequests()` for stored side-request accounting.

#### Trace summaries

`summarizeTrace(records: TraceRecord[]): TraceSummary` is pure and does not mutate its input. Pass one session's trace, including its resume headers; do not concatenate parent and child traces, because the parent's subagent records already report child usage. Time metrics overlap and must not be added together to reconstruct wall time.

| Summary fields | Accounting |
| --- | --- |
| `start?`, `end?`, `wallTimeMs` | Earliest and latest represented event times, including queue/retry times; wall time is their difference, not the distance between array endpoints. Resume downtime counts here. Empty input has no bounds and zero time. |
| `modelTimeMs` | Sum of model request intervals, including retry delays. |
| `modelWaitMs`, `modelStreamMs`, `modelUnknownMs` | Start-to-first-token and first-token-to-end sums where `firstToken` exists; otherwise the entire interval is unclassified in `modelUnknownMs`. |
| `toolTimeMs` | Union of tool start/end intervals; overlapping parallel calls count once. |
| `toolDurationMs`, `approvalWaitMs` | Independently summed reported tool durations and real approval waits; simultaneous waits can overlap. |
| `idleMs` | Gaps between turn intervals within each header-delimited run; excludes resume downtime and time outside the first/last turn. |
| `usage`, `subagentUsage`, `totalUsage` | Own model/compact/side usage, direct children's own usage, and the combination. Reasoning tokens are retained; a total cost is absent if any included usage has unknown cost, and unpriced searches remain unpriced. |
| `tools[name]` | `count`, `totalMs`, `avgMs`, `maxMs` based on reported `durationMs`, plus `outcomes` with all six disposition counts, including zeros. |
| `failures` | Every non-OK tool and failed/aborted turn, ordered by completion `at`, with source identifiers, outcome/reason and available bounded tool preview or turn failure summary. |
| `retries` | Count of recorded model retry entries. |
| `subagents` | Completed direct children with ID, optional role/title, start/end, reported lifetime duration, status, optional usage and known USD `cost`. |

Usage totals cover only reported usage, not all billable work. In particular, absent side-usage events, parent-model consultations without model events and unreported failed-request usage cannot be reconstructed from traces. Read a child's trace separately when you need its detailed timing or descendants.

### Workspace providers

API 0.1.16 adds `api.registerWorkspaceProvider(provider)`. One provider may be registered per
host; a second registration throws an error naming the current owner. The returned function
unregisters it, and unload, failed load and reload release it automatically.

```ts
import type { WorkspaceProvider } from "@amira/api"

const provider: WorkspaceProvider = {
  async probe(cwd, signal, kind = "full") {
    // Honor signal; use api.runCommand for processes. A dirty probe may reuse metadata.
    return { cwd }
  },
  // Optional: a cheap metadata fingerprint, with no process spawn.
  stamp(cwd) { return undefined },
}
api.registerWorkspaceProvider(provider)
```

`WorkspaceFacts` is the `workspace.changed` payload: `cwd`, and optional `repoRoot`, `branch`,
`head`, `isWorktree` and `dirty`. Return the exact requested `cwd`; mismatches are rejected.
Return `undefined` when facts are unavailable. The provider never emits events or supplies
`sessionId`, `seq` or `ts`; the host owns those fields and binds results to the active top-level
session. Session switches, session end and provider removal abort pending probes and discard
late results even if the provider ignores cancellation.

The host waits 500 ms initially, coalesces overlapping requests, and emits only changed facts.
A changed stamp triggers a full probe after a turn. With an unchanged stamp it requests a dirty
probe after tools that may write files, or after 60 seconds without a check. Only explicit
`writesFiles: false` skips the write hint; unknown and child tools remain conservative. Without
a stamp the host requests a full probe after each turn. Stamps must also reflect a repository
appearing or disappearing. A provider may answer a dirty request with full facts.

The built-in agent extension provides Git probing. With `--no-builtins` and no replacement
provider there are no workspace events or branch labels; `/status` gives up waiting after two
seconds and reports unknown Git facts. Reload replays the current session's last workspace
event. The deprecated `@amira/core` exports stay usable: `gitInfo` remains a standalone
one-shot Git probe that needs no provider, and `trackWorkspace` (re)starts the host tracker on
its bus, which emits nothing until a provider is registered there.

### Background jobs

`ExtensionAPI.backgroundJobs` is an extension-scoped view: it can start jobs and list, read, wait for, stop and subscribe only to jobs that the same extension started. It cannot configure the host registry, stop all jobs, close sessions or hand jobs between roots. Built-in frontend code such as the `/jobs` command and TUI panel uses the host-only `hostBackgroundJobs()` capability, so it can see session jobs started by tools; tool executors should use the session-scoped `ctx.backgroundJobs` capability instead, which carries ownership and visibility.

Start a job with `command`, `argv`, `cwd`, `env` and `shell`. The session host records the owning sub-agent automatically, while a main session can see its own jobs and all jobs in its sub-agents; a sub-agent can see only its own jobs. `list`, `get`, `running`, `output`, `tail` and `stop` enforce that visibility, and inaccessible jobs are treated as missing.

`readNew` maintains a cursor per reader name, so independent readers can consume the same output incrementally. `waitFor` waits for a regular-expression pattern, process exit, a timeout, or an abort signal. `subscribe` reports changes only for the extension's jobs. Call `stop` with a grace period first and call it again with `0` when a forced stop is required.

The host registry exposes `maxRunning`, `configure`, `stopAll` and `isLimitError` to built-in host code. A sub-agent's session-owned jobs are stopped automatically after its `subagent.end` event is delivered. Top-level session-owned jobs survive `/clear`, `/resume` and `/fork`: the replacement root session can list, read and stop them, and their end notices are delivered there. Jobs started directly through `ExtensionAPI.backgroundJobs` are not assigned to a caller session; they are stopped when the extension that started them unloads (its `subscribe` listeners are removed too) or Amira exits. Unloading an extension, including on `/reload`, does not stop jobs that sessions' tools started. Extensions must use the narrowed API rather than reaching into `@amira/proc` globals.

Registrations return removal functions and are tracked by the host. Unloading removes them; a failed extension load rolls back its registrations. For matching command, tool, skill, status or panel names, an intentional replacement needs `override: true`; consult the specific type for collision rules. Do not replace another extension's registrations accidentally.

Events include `session.start` (with the initial optional `title`), `workspace.changed`, `tool.execute.start` and `tool.execute.end` (both carry the tool's `traits` and, for a writer, the `writtenPaths` it reported). Event listeners receive an envelope containing event data and the session ID, so filter by session when maintaining session-specific state. On reload, newly registered listeners receive current session/workspace/budget events and the latest `ui.focus` and `ui.waiting` state. Waiting is replayed as a visibility change, without announcing a new question. Native resources you create yourself need their own cleanup.

`api.terminal` is a stable structured capability: `setTitle(title: string)`, `setProgress(state: "none" | "indeterminate" | "paused")` and `bell()`. It exposes no raw writes or escape sequences. Print and RPC frontends leave these methods as no-ops. The TUI sanitizes and limits titles to 128 terminal cells, coalesces effects at a microtask boundary outside frame writes, respects `tui.title`, `tui.progress` and `tui.bell`, detects progress support and restores the terminal on exit.

The built-in `@amira/ext-terminal-status` owns title composition, working/waiting progress and bell policy; `--no-builtins` disables it. The TUI emits `ui.waiting` after questions (including local rewind dialogs), forms and overlays change: `{ pending: number, hidden: boolean, change: "opened" | "resolved" | "visibility" }`. `hidden` means an overlay covers a pending answer. Hidden question openings ring once; visibility changes do not ring. Focus reports arrive as `ui.focus`; completion and visible questions ring when unfocused, or after 15 seconds of a turn if focus is unknown. Aborted turns do not ring.

Use `/reload` after editing the extension entry file. Modules imported by that file stay cached, so restart Amira after changing helper modules. Keep render callbacks cheap and call `requestRender` after changing visible state.

Related: [Getting started](getting-started.md), [Sub-agents](subagents.md), [Usage and sessions](usage.md), [Settings](settings.md), [Keybindings](keybindings.md).

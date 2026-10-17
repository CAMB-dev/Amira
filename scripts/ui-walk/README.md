# Headless TUI walkthroughs

Drive **the real Amira TUI from this checkout**, one shell command at a time, without opening a terminal window. Each named session has a background daemon, Bun PTY, xterm screen, temporary working directory and temporary home. PNGs show the current screen in colour; no model API credentials are needed.

This is developer tooling, not a published package. Requires **Bun 1.4+** and `bun install`. Bun 1.4.2's `Bun.spawn({ terminal })` was probed successfully on Windows (ConPTY), so no native PTY addon, compiler, Python, browser or GUI is used. Bun uses its built-in PTY implementation on Linux/macOS too; those hosts still need a working PTY device.

## Worked example for an agent

Run from the checkout. Use unique names for parallel walks. Put screenshots outside the repository and outside the session directory if you want them to survive `stop`.

```sh
bun scripts/ui-walk/walk.ts start model-walk --cols 100 --rows 32 --scenario scripts/ui-walk/scenarios/dialogs.json -- --fullscreen
bun scripts/ui-walk/walk.ts wait model-walk --text "ui-walk/main" --timeout 15000
bun scripts/ui-walk/walk.ts keys model-walk text:/model enter
bun scripts/ui-walk/walk.ts wait model-walk --idle 400
bun scripts/ui-walk/walk.ts text model-walk
bun scripts/ui-walk/walk.ts keys model-walk text:main
bun scripts/ui-walk/walk.ts wait model-walk --idle 400
bun scripts/ui-walk/walk.ts shot model-walk /tmp/model-100x32.png
bun scripts/ui-walk/walk.ts resize model-walk 60 24
bun scripts/ui-walk/walk.ts wait model-walk --idle 400
bun scripts/ui-walk/walk.ts shot model-walk /tmp/model-60x24.png
bun scripts/ui-walk/walk.ts keys model-walk esc
bun scripts/ui-walk/walk.ts keys model-walk 'text:Ask me how to present the results.' enter
bun scripts/ui-walk/walk.ts wait model-walk --text "Summary" --timeout 15000
bun scripts/ui-walk/walk.ts shot model-walk /tmp/questions.png
bun scripts/ui-walk/walk.ts stop model-walk
```

On Windows replace `/tmp/...` with an absolute path under `$env:TEMP` (PowerShell) or the Git Bash temporary directory. Shell quotes around `text:`/`paste:` arguments preserve spaces and newlines; they are not typed into the TUI. Inspect PNGs with your agent's image/file-reading tool. Use `text` for inexpensive navigation checks and `shot` when visual details matter.

`wait --idle` means **terminal output** has been quiet, not that a model turn has completed. Stream delays, dialogs and background tasks can all be quiet. Prefer a distinctive `--text` marker for turn completion. It searches the visible screen, not off-screen scrollback. `start` reports daemon readiness; wait for the model label before typing into a newly started TUI.

## Commands

All commands use `bun scripts/ui-walk/walk.ts`:

| Command | Meaning |
| --- | --- |
| `start <name> [--cols 100 --rows 32] [--theme dark] [--scenario file] [--extension local-dir ...] [--idle-timeout 600000] [-- amira args]` | Create a named isolated session. Names: 1–64 letters, digits, `-`, `_`. Default scenario: `transcript.json`; fullscreen interface. Prints daemon PID, application PID and temp root as JSON. |
| `keys <name> <keys...>` | Type named keys/chords or literal text, in order. |
| `resize <name> <cols> <rows>` | Resize both PTY and xterm; wait for the application's redraw afterward. |
| `wait <name> [--idle ms \| --text string] [--timeout ms]` | Wait for output silence (default 300 ms) or visible text. Default timeout 30 seconds. Timeout errors include numbered screen text. |
| `shot <name> <out.png>` | Write an opaque PNG of the active viewport; prints the absolute path. Parent directories are created by Bun. |
| `text <name>` | Current visible rows, numbered from 1; trailing whitespace trimmed. |
| `ansi <name>` | Reconstructed visible screen with ANSI cell attributes (no cursor/scrollback). Not a raw output log. |
| `stop <name>` | Stop this session's tree and servers, then remove its files. Reports any locked leftover path; a later call retries cleanup offline. Already-stopped sessions succeed idempotently. |
| `list` | Show live sessions and retry safe pending cleanup for stopped generations. Reports locked leftover paths; never kills a stale PID. |
| `help` | Print the command reference. |

Dimensions are bounded to 500 columns × 200 rows. Millisecond arguments are positive integers up to one hour. No command requires a visible terminal. Commands exit nonzero on invalid input, provider/startup failure, expired sessions or unmet wait conditions. A session keeps living when the shell invocation ends.

### Keys

- `enter`, `esc`/`escape`, `tab`, `backspace`, `space`
- `up`, `down`, `left`, `right`, `home`, `end`, `insert`, `delete`, `pageup`, `pagedown`, `f1`–`f12`
- `ctrl+o`, `ctrl+c`, `ctrl+space`, `alt+v`, `shift+tab`, modified navigation such as `ctrl+shift+left`
- `text:/model`, `'text:hello world'`, `'paste:multi-line text'`

`paste:` sends bracketed-paste start/end markers. `text:` sends literal bytes. Arrow/home/end encoding follows xterm's application-cursor mode. A standalone `esc` token includes a short delay for the input reader's Escape/Alt ambiguity timeout, so `esc text:hello enter` cancels a picker and then sends a prompt rather than becoming Alt+h. Unknown keys and unsupported chords fail rather than silently typing a typo. If invoking through a JSON client rather than a shell, `text:"..."` and `paste:"..."` accept JSON-string payloads.

After `--`, supported Amira arguments are `--fullscreen` (accepted as a no-op), `--no-builtins`, `--thinking <level>`, `--permission-mode <mode>`, `--disable-tools <names>`, `--shell <mode>` and an initial prompt. A second `--` introduces a dash-prefixed prompt. Provider/model selection, cwd, extensions, package loading, resume and noninteractive modes are deliberately not overridable through passthrough arguments. Use the harness's `start --extension` option before `--` to opt into local test extensions.

### Trusted local test extensions

`start --extension <local-directory>` is repeatable and opt-in. For example:

```sh
bun scripts/ui-walk/walk.ts start extension-walk --extension ./local-workflow --extension ./local-swarm -- --fullscreen
```

Use **trusted test code only**. Each directory is copied to `home/.amira/extensions/local-<index>` inside that session's temporary root. The real extension host loads its entry points before the fixture extension, so canned tool overrides remain inert. Different sessions get independent copies; the source directories are not changed. Package entry points come from `amira-package.json` or the `amira` field in `package.json`, with the ordinary `index.ts` / `src/index.ts` fallback. A directory without a manifest also supports that fallback. Invalid paths, files, symlinks, empty extension lists, missing entry points and incompatible API engine ranges are rejected.

No dependencies are installed, no package commands are run, and package settings, skills and themes are not activated. Existing dependencies and local imports are copied with the directory, except `.git` and `node_modules/@amira` (development links created by `link-amira`, replaced by the host's API); all other symlinks in the copy are rejected rather than following paths outside the extension. Provide a self-contained directory with any needed dependencies already present. `@amira/api` is provided by the real host without installation.

The isolated home/cwd, fake provider, fetch guard and tool-call blocking remain enabled. A loaded extension's tool is not automatically allowed to execute: unmatched calls are still blocked. Extensions execute in-process and can perform arbitrary I/O outside those guards, so this option is **not an untrusted-code sandbox**. Do not load extensions that launch GUIs, contact live APIs or access your real Amira home. Known real Amira home paths (`~/.amira` and `AMIRA_HOME`) are rejected as extension directories without inspecting real-home metadata; do not supply aliases to a relocated home.

## Architecture and isolation

### Session daemon

On POSIX, `walk.ts` launches an unref'd, detached Bun daemon with ignored stdio. On Windows, agent shell hosts close their entire Job Object after each tool call, killing even ordinary detached children. The launcher therefore uses same-user local WMI `Win32_Process.Create`, through `powershell.exe -NoProfile -NonInteractive`, with no-window startup flags. This creates the daemon outside that command's Job Object, without a scheduled task, admin rights or persistent service. A system process handle is held during startup so timeout cleanup cannot target a reused PID. Windows needs its standard PowerShell/CIM service; restricted hosts that disallow local WMI process creation fail explicitly, not silently skip tests.

Each daemon owns a PTY child running `packages/cli/src/main.ts`, an xterm/headless buffer, a loopback HTTP command server and a loopback fake-provider server. The Windows PTY child is deliberately not detached: Bun 1.4's `detached` flag bypasses ConPTY. It is hidden and contained by the daemon's Job Object instead. Ports are OS-assigned, not calculated from names. Requests use a random bearer token stored in owner-only files where the OS supports permissions.

The registry is under the OS temp directory, scoped by user and checkout-path hash. Each start gets a fresh UUID **generation** and a physically distinct `name.generation` directory; config and address files record that generation. An atomic `name.starting` claim serializes launches for the same name, and only that launcher releases it. Daemons never delete shared name state: normal, delayed-failure and guardian cleanup check ownership and remove only their generation directory. A failed start can therefore be retried immediately under the same name without its old timer touching the replacement. Different names have independent screens, scenario cursors, homes, working directories, ports and process trees. Commands for one session can be issued while another waits. Waits do not prevent concurrent input to the same session.

A ten-minute **command-idle** timeout is the default; active waits keep the session alive. Output alone does not extend the lease. `stop` kills only the session's tracked tree (Windows kill-on-close Job Object; POSIX process group), closes both servers and removes its generation root. Windows starts fail explicitly if Job Object containment cannot be established. If Amira exits unexpectedly, the next command within the grace period reports its exit and cleans up; with no further commands the daemon cleans up after **five seconds**, or its shorter idle timeout. Those calls cannot renew the exit grace. It never kills by executable/image name, and `packages/proc` behaviour is unchanged.

Filesystem errors cannot strand shutdown: process/provider teardown runs once, the command server stops even when directory removal fails, and failed removal promises are not cached. A temporary lock makes the first `stop` report the error and exact leftover path. The daemon retries cleanup for **at most five seconds after that failure**, then exits even if the lock remains. During those retries its servers are already closed; use a new CLI call, not the cached HTTP endpoint.

Before recursive removal, cleanup saves a generation-owned sibling `name.generation.cleanup.json` record outside the directory being removed. That proof survives partial removal of `config.json` and `address.json`. Once the lock is released, `stop`, another command for the stopped name, or `list` can finish removing the directory and record **without inspecting or killing any recorded PID**. This never targets an unmarked unreachable session or a replacement generation.

On POSIX, a separate detached **guardian** owns a private pipe whose write end is held only by the daemon. Amira first runs a tooling entry point that waits for an IPC start message; the daemon sends it only after the guardian is armed. Disconnect before that handshake kills the waiting child without loading the CLI. Afterward, daemon termination—including SIGKILL—closes the lifetime pipe; the guardian kills the freshly spawned Amira process group, removes only its generation directory, and exits. Normal cleanup sends SIGKILL before disarming the guardian. This uses Bun processes/pipes and POSIX process groups, not native addons or parent-PID polling. It guarantees cleanup for an individual daemon death while the guardian and OS remain operational; it cannot protect descendants that deliberately leave the group, simultaneous external termination of both daemon and guardian, or a machine crash. Fixtures do not execute shell tools or create escaping descendants. POSIX pipe lifecycle logic is unit-tested with injected kill/cleanup handles; this checkout's runtime verification was on Windows.

A machine crash, a Windows daemon crash, or a launcher crash during its start claim can leave unreachable temporary state. Inspect and remove that **specific generation directory or `.starting` claim** manually; never kill processes from stale recorded PIDs. On Windows the Job Object still prevents Amira from surviving its daemon's death.

### Offline provider and tool fixtures

The daemon writes ordinary **provider settings** and an ordinary **extension** into the isolated `AMIRA_HOME`. The fake provider requires the session's bearer secret on every endpoint, before body parsing or cursor advancement; Amira sends it through the provider's ordinary `headers.Authorization` setting. Unauthenticated requests cannot consume scripted replies. Amira uses its real OpenAI-chat provider, HTTP/SSE parsing, event bus, transcript, dialogs and child-session machinery. No product code is patched and no API exports or `API_VERSION` are changed.

The child receives an allowlisted environment, not inherited API keys, `AMIRA_*`, proxy settings or real user/package configuration. `HOME`, `USERPROFILE`, `AMIRA_HOME`, XDG/config/cache/temp directories and cwd point into the session root. A fresh empty catalog prevents a models.dev refresh. A tooling-only Bun preload rejects every product `fetch` outside the exact fake-provider origin and rejects redirects. There are no live model calls.

For provider UI walkthroughs, `scenarios/providers.json` lists 200 models through authenticated `GET /v1/models`. Its optional `models` fixture also seeds a fake catalog vendor, **UI walk demo** (`ui-walk-demo`), with context windows and prices for known models; unknown models have no price. Open `/provider add ui-walk-demo` and use the session token from that generation's `config.json` as the fake API key. Never use real credentials. The exact-origin fetch guard still blocks all external catalog and provider requests.

The fixture extension registers inert overrides for the scenario's file/shell tool names, retaining the built-in presenters. Before-call hooks allow only matching fixture calls; after-call hooks supply their canned results. Matches require tool-call ID, name and deep-equal arguments. Thus displayed reads/edits/checks are simulations; they do not read or mutate real files or run commands. Unmatched file/shell/network calls are blocked before execution. `ask_user` and safe sub-agents use real UI/orchestration paths; agents must explicitly use `isolation: "none"` and a `ui-walk/` model. Unsupported tools remain blocked or unavailable.

Fixtures are trusted developer data, not a sandbox for arbitrary executable code or extensions. Do not modify the harness to load untrusted scripts. The fetch preload is a guard against accidental product HTTP, not an OS network sandbox.

### Screen and screenshots

`@xterm/headless` consumes all PTY output and sends terminal query responses back to the application. Snapshots wait for xterm's asynchronous write queue. Cursor moves, alternate screens, scroll regions, indexed/true colours and resizes are interpreted by xterm rather than stripped with a regex.

The renderer snapshots cells into SVG and rasterises using **resvg WASM**. There is no native addon or browser. Cells are 10×20 px (100×32 → 1000×640; 60×24 → 600×480). It draws RGB/default/indexed colours, bold, italic, underline, inverse, dim/invisible text, cursor and width-two CJK cells. U+2500–U+259F are rendered as **cell-sized geometry**, not font glyphs: light/heavy/double and mixed joins, rounded corners, visible dashed/diagonal lines, full/half/eighth/quadrant blocks and stippled shades. Lines meet at cell edges without font-baseline gaps, and fractional block coverage is integrated per pixel. It explicitly loads system font bytes: Consolas/Cascadia Mono on Windows, Menlo on macOS, DejaVu Sans Mono on Linux, with one available Microsoft YaHei/PingFang/Noto CJK-family fallback and Segoe UI Symbol/Apple Symbols for selection marks where available. Only the selected families' bytes are loaded, not every installed CJK font. Fonts and WASM are loaded lazily once per daemon; subsequent shots reuse them.

Install a CJK fallback (e.g. Noto Sans CJK on Linux) for readable Chinese/Japanese/Korean. Without one, xterm still reserves two cells, but the glyph may be missing. Screenshots fail clearly if no supported system font exists.

Compared with Windows Terminal: the ANSI/default palette is xterm's, not the user's Windows Terminal profile; shaping, font hinting, emoji/ZWJ width and fallback can differ. Images, sixel/Kitty graphics, hyperlink clickability, native scrollback selection, mouse interactions and Windows Terminal chrome/notifications are not reproduced. Cursor snapshots use a fixed visible phase (no blink timing); cursor visibility uses one isolated read-only xterm 6 internal field because headless's public API omits DEC mode 25. This is a reproducible TUI inspection surface, not a pixel-identical Windows Terminal emulator.

## Scenarios

Scenario files are JSON. `prompt` is a suggested prompt for the agent, not automatically sent. Main turns route to model `main`; named child models have independent routes and child sessions have independent cursors. Once a route is exhausted, the provider returns a short completion rather than calling a real model.

A reply can contain:

```json
{
  "name": "custom",
  "description": "A local scripted walk",
  "prompt": "Say hello",
  "routes": {
    "main": [
      {
        "thinking": "I will show a fixture.",
        "text": "## Hello\n\nA **streamed** reply: 你好.\n",
        "delayMs": 25,
        "chunkSize": 12,
        "toolCalls": [{
          "id": "read-1",
          "name": "read",
          "args": { "path": "example.ts" },
          "result": { "content": [{ "type": "text", "text": "canned file contents" }] }
        }]
      },
      { "text": "Done." }
    ]
  }
}
```

`toolCalls[].result` supplies canned execution results; omit it for real dialog/child orchestration tools. `repeat` repeats reply text for long-output walks. `error: { "status": 429, "message": "...", "retryAfter": 0 }` causes an HTTP error; the next request advances the script, including retries. `streamError` injects a body-stream error. Every HTTP request (including a retry or continuation after tools) advances that session/route's script, so add a final reply after a tool-call reply. `delayMs` applies per SSE chunk, not per whole turn. Tool result `details` can exercise the real presenters.

See each shipped fixture's `description` and `prompt`: transcript, dialogs, subagents, long-output and errors. Workflow/swarm tools are optional extensions, not part of the default CLI built-ins; opt into trusted local copies with `start --extension` to load their real panels. This harness does not pretend their panels are real when those extensions are not loaded. Their calls can be represented as canned results only if the appropriate safe fixture tool is registered. Sub-agent transcripts and task panels are real.

## Tests

The final verification commands from the repository root are (`check` runs architecture, typecheck, repository-wide Biome, and the parallel tests exactly as CI):

```sh
bun run check
bun test scripts/ui-walk --timeout=30000
```

Extension tests cover repeatable directory copies, independent homes, manifest entry points, API compatibility and rejected paths/symlinks; a real-TUI test loads two local extensions through the CLI, invokes their commands and checks copied state, fetch blocking, tool blocking and isolation from a default session. The key tests cover literal/paste encoding and chords. Renderer tests decode real PNGs and check size, exact colours, cursor, styles, wide characters, resize/alternate-screen viewport and ANSI round-tripping. Provider tests use only loopback HTTP and verify that missing/wrong secrets leave scripted cursors untouched. Geometry tests check edge continuity, joins and integrated block coverage across the entire Unicode range. Session regressions cover failed-start name reuse past the old cleanup deadline, unexpected Amira exit reporting/server/process cleanup, and command-free exit-grace expiry. Guardian tests inject a private pipe and process-group cleanup handles to cover POSIX parent death and normal disarming without native code. Shutdown tests inject temporary/persistent removal failures on all OSes. Ownership-recovery tests run everywhere; on Windows they additionally hold a real file open without delete sharing, verify the first stop fails while both processes/servers shut down, then verify released-lock stop recovery and persistent-lock bounded exit/list recovery. The fast E2E starts independent real TUI sessions through separate CLI launcher processes, closes the launchers' process trees like an agent shell host, then streams a scenario reply, checks visible text, resizes, checks authorization and verifies cleanup/isolation. It only skips if Bun's PTY constructor reports an unavailable PTY implementation/device (e.g. a Linux container without permitted `/dev/ptmx`); it is enabled on this Windows ConPTY host. No optional env flag disables that E2E.

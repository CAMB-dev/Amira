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
| `ui` | Ask through select, confirm, input, form and review dialogs; the command context also exposes UI requests |
| `registerPanel` | Render live lines above the activity line |
| `registerView` | Register a full-screen view kind; commands open it through `openView` when the frontend supports it |
| `registerToolRenderer`, `decorateToolRenderer` | Present tool calls and results, or wrap an existing presenter |
| `serverToolView` | Turn provider-hosted tool blocks, such as native web search, into the same tool-call view shape used by presenters |
| `registerMarkdownRenderer`, `registerImageProvider` | Render matching reply code blocks or standalone images and supply terminal image data |
| `provideService`, `useService` | Share named extension services; look them up when needed because a provider may be absent or unloaded |
| `settings`, `cwd`, `home`, `apiVersion` | Read merged settings, the working directory, the user directory and API version |
| `runCommand`, `openPipe`, `onExit` | Run managed subprocesses, open a long-lived piped process, or register short exit work |
| `notify`, `reportError` | Show a notice or report a background failure |
| `registerFileRestoration` | Take over rewind's file restoration (for example a checkpoints extension): the picker shows your label and the core restores nothing; one owner at a time, released on unload |

`serverToolView(block)` returns the provider tool's name, arguments, result text and native search details (sources included), plus `rejected: "aborted"` when a block never finished. Use its `ToolCallView` fields with an existing tool presenter or another frontend; it is render-only and must not be sent back as a local tool result.

A command opens the rewind picker that double Esc opens with `ctx.openRewind()`; it is set only where the frontend has the picker (the terminal UI) and returns false when the picker cannot open now, for example during a turn.

Extension-specific settings belong under `extensions` with the extension name. The settings snapshot is deeply frozen; validate your own section. Print mode cancels UI dialogs; RPC clients answer them through the protocol. Panels, views, tool presenters, Markdown renderers, image providers and services are experimental APIs.

`runCommand` resolves once the command has exited. Pass `onChunk` to get output as it arrives, for example to show progress from a long `git` command. Abort through `signal` (or let `timeoutMs` expire) and the whole process tree is killed; the result then reports `aborted` or `timedOut`. By default, `output` keeps only the last 1,000,000 characters; override that limit with a positive-integer `maxOutputChars` (invalid values reject the call). `onChunk` still receives everything, and `truncated` reports whether `output` was cut. A cut never splits a UTF-16 surrogate pair.

Registrations return removal functions and are tracked by the host. Unloading removes them; a failed extension load rolls back its registrations. For matching command, tool, skill, status or panel names, an intentional replacement needs `override: true`; consult the specific type for collision rules. Do not replace another extension's registrations accidentally.

Events include `session.start`, `workspace.changed`, `tool.execute.start` and `tool.execute.end`. Event listeners receive an envelope containing event data and the session ID, so filter by session when maintaining session-specific state. On reload, newly registered listeners receive current session/workspace/budget events to rebuild state. Native resources you create yourself need their own cleanup.

Use `/reload` after editing the extension entry file. Modules imported by that file stay cached, so restart Amira after changing helper modules. Keep render callbacks cheap and call `requestRender` after changing visible state.

Related: [Getting started](getting-started.md), [Sub-agents](subagents.md), [Usage and sessions](usage.md), [Settings](settings.md), [Keybindings](keybindings.md).

# Task B implementation report

Completed the English and Simplified Chinese user documentation against the code in this worktree. No application source, Git history or branch was changed. No real provider request, API key or real user Amira directory was accessed. Mock tests use isolated temporary homes. Work remains uncommitted for review.

## Files written

- README.md and README.zh-CN.md: source installation, first run, daily controls, all user-document links and the existing Apache-2.0 license information.
- docs/getting-started.md and docs/zh/getting-started.md: the code-derived welcome card, provider/model forms, a first task, completion, approvals and resuming.
- docs/providers.md and docs/zh/providers.md: protocols, provider commands, credentials, metadata, context windows, compatibility and local proxies.
- docs/usage.md and docs/zh/usage.md: terminal modes, dialogue controls, tools, approvals, sessions, compaction, rewind, print, RPC and costs.
- docs/subagents.md and docs/zh/subagents.md: roles, context, background lifecycle, limits, viewer, worktrees and merging; accurately marks unavailable workflow/swarm implementations.
- docs/extensions.md and docs/zh/extensions.md: package management, trust, manifest, a complete tested example and public API guide.
- docs/keybindings.md: other-language/related navigation; narrowed the pre-existing image-package claims to the image host behavior that can be verified in this checkout.
- docs/zh/keybindings.md: complete Chinese key reference with matching navigation.
- docs/verify-docs.ts: reproducible inline-code-span and local-link audit, using ripgrep against source/tests rather than the documentation itself.
- docs/verify-examples.ts: reproducible JSON/schema checks, EN/ZH example equality, manifest/engine validation, actual ExtensionHost execution and extracted-example TypeScript check. All generated files and the isolated Amira home are in an OS temporary directory, cleaned afterward.
- docs/verification-output.txt, docs/example-output.txt, docs/test-output.txt: exact outputs from the consolidated checks.
- docs/IMPLEMENTATION-REPORT.md: this report, including the complete code-span audit output below.

## Verification results

No new application tests were needed for documentation-only changes. Existing behavior tests and executable documentation examples provide evidence; existing application tests also pass before these prose changes. The example verifier would fail if the two language examples diverge, the manifest/API engine is invalid, schema examples are invalid, the documented greeting/counter lifecycle changes or the example no longer typechecks.

Bun version: 1.4.2. The following command cleared every AMIRA_LIVE_* variable before invoking the test runner, whose preload creates a temporary AMIRA_HOME:

```powershell
Get-ChildItem Env:AMIRA_LIVE_* | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
bun test packages/cli/test/cli.test.ts packages/cli/test/resume.test.ts packages/cli/test/rpc.test.ts packages/cli/test/control.test.ts extensions/agent/test/agent.test.ts extensions/agent/test/agents-command.test.ts extensions/agent/test/roles.test.ts extensions/agent/test/worktree.test.ts packages/core/test/subagents.test.ts packages/tui/test/keybindings.test.ts packages/tui/test/key-reference.test.ts packages/tui/test/file-picker.test.ts
```

Exact result, exit 0 (individual test output is preserved in test-output.txt):

```text
194 pass
0 fail
1352 expect() calls
Ran 194 tests across 12 files. [74.03s]
```

The provider/extensions section author also ran these mock suites, with AMIRA_LIVE_* cleared:

```text
bun test packages/ai/test/providers.test.ts packages/core/test/provider-config.test.ts packages/cli/test/provider-admin.test.ts packages/cli/test/provider-cli.test.ts extensions/commands/test/provider.test.ts
34 pass
0 fail
214 expect() calls
Ran 34 tests across 5 files. [833.00ms]

bun test packages/core/test/extension-api.test.ts packages/cli/test/packages.test.ts packages/ai/test/native-compaction.test.ts packages/cli/test/native-web-search.test.ts
31 pass
0 fail
151 expect() calls
Ran 31 tests across 4 files. [1142.00ms]
```

The first provider run inside the restricted sandbox had 30 passing tests and four Windows ACL EPERM failures (200 assertions, 636.00ms). All four involved temporary credential-file permissions. The user-authorized elevated rerun passed all 34. This was an environment limitation, not a code change.

Consolidated executable example command, exit 0:

```text
bun docs/verify-examples.ts
PASS: 10 JSON blocks parse; 6 settings examples accepted without warnings.
PASS: EN/ZH extension examples identical; manifest and engine accepted.
PASS: configured greeting, command execution, status counter, unload and reload reset.
PASS: extracted extension example typechecks against this checkout's API (TypeScript).
```

The persisted verifier generates absolute TypeScript paths and no baseUrl, so it works with this checkout's TypeScript 7. An initial temporary verifier used the removed baseUrl option; that temporary configuration was corrected before typechecking. The consolidated verifier initially tried to validate the package manifest's extensions array as a settings object; its own classification was fixed, then rerun successfully.

Final script lint and whitespace commands, both exit 0:

```text
bunx --no-install biome check docs/verify-docs.ts docs/verify-examples.ts
Checked 2 files in 10ms. No fixes applied.

git diff --check
(no output)
```

The scripts initially needed import/format fixes; a scoped Biome --write applied those, and the final check passed. Source install/global-link commands were not executed because dependencies already exist and registration would modify user-level Bun state. bun link --help was inspected (exit 0), and packages/cli/package.json declares the amira bin; root package.json declares bun run amira's script. No full application check or visual terminal session was necessary to validate these prose changes; the welcome/form descriptions were read directly from UI implementation and tests.

## Manual disposition of the 18 unmatched spans

The audit checks vocabulary, not semantics. A literal source hit (or documented normalized token) is not proof of a full invocation, key binding or setting's behavior. Every command, Amira setting and binding was separately checked in its owner implementation/tests. Fenced snippets are excluded from the inline scan; configuration examples and the extension example receive the executable checks above. CLI syntax fences were reviewed against args.ts, provider-cli.ts and ext-command.ts. Prompt text, model IDs, paths, environment variable names, custom roles and custom extension commands can be examples rather than built-in vocabulary.

| Unmatched span | Evidence or disposition |
| --- | --- |
| --resume <session-id> | Placeholder invocation: packages/cli/src/args.ts defines --resume, parses an optional ID and validates its combinations. packages/cli/test/resume.test.ts verifies IDs and session selection. |
| .amira/agents/test-reviewer.md | Illustrative role filename, not a bundled role. extensions/agent/src/roles.ts loads Markdown files from the project agents directory and validates the frontmatter shown in the example. |
| Amira · <folder> ⎇ <branch> | Formatted title example with placeholders. packages/tui/src/terminal-status.ts:58–63 constructs it dynamically; terminal-status tests cover updating/restoring it. |
| Enter queue · Ctrl+Q steer | Dynamically generated hint. packages/tui/src/app.ts:481,685–703 combines key labels with the two actions; packages/tui/test/keybindings.test.ts verifies platform queue labels. |
| Enter steer · Alt+Enter queue · Esc interrupt | Same dynamic construction; it is a representative non-Windows default, not an unconditional exact UI string. Current labels depend on terminal and key overrides. |
| Esc Esc rewind | Dynamically generated from the interrupt label in packages/tui/src/app.ts:702; rewind implementation is at 1430–1505 and is covered by CLI control tests. |
| budget.tokens | Dotted settings path: Settings.budget references Budget; packages/api/src/subagents.ts:175–177 declares tokens. Core subagent tests verify token-budget behavior. |
| bun run amira | Root package.json scripts.amira is bun packages/cli/src/main.ts. This is Bun script syntax, so the complete shell invocation need not appear in application code. |
| code --wait | Pre-existing external-editor example, not an Amira command. packages/tui/src/app.ts:1682–1687 reads VISUAL/EDITOR as a command. VS Code installation and --wait behavior were not exercised. |
| hello-extension | Newly defined example package name. The extracted manifest and module load successfully, run commands, update status and typecheck in verify-examples.ts. |
| merge.reviewThreshold.files | Nested shape declared in packages/api/src/settings.ts:85; extensions/agent/src/index.ts reads the threshold. Worktree/agent tests verify review and merging. |
| merge.reviewThreshold.lines | Same nested shape and review implementation as the files threshold. |
| reply 3 of 9 | Representative block-selection label with generated count/index. packages/tui/src/transcript-pane.ts selection logic and fullscreen-view.ts format it from actual blocks; counts are illustrative. |
| set-clipboard on | Retained external tmux recipe from the existing key reference. Amira uses OSC 52; tmux's own configuration semantics are outside this repository and were not exercised. |
| terminal.integrated.commandsToSkipShell | Retained external VS Code setting from the existing key reference. packages/tui/src/keybindings.ts mentions commandsToSkipShell and implements alternate bindings; current VS Code configuration semantics were not exercised. |
| terminal.integrated.macOptionClickForcesSelection | Retained external VS Code setting from the existing key reference. There is no implementation of this setting in Amira, and current macOS VS Code behavior could not be verified in this Windows checkout. |
| ↓ 124 rows below | Representative scroll label. packages/tui/src/fullscreen-view.ts:169–176 formats an actual count plus row/rows; 124 is illustrative. |
| ↓ new output · 124 rows below | Same dynamic counter, with the new-output state set while scrolled above the end. |

## Missing targets and unavailable behavior

- docs/settings.md and docs/zh/settings.md are intentional links to the separate settings-reference task. They do not exist in this standalone worktree and must be supplied when the tasks are integrated. This task did not write those files.
- No bundled workflow/swarm implementation, start command or confirmation procedure exists here. References in API comments are generic extension capabilities. The subagent pages state this explicitly and describe the available host limits rather than inventing a workflow.
- No real service's model availability, live API protocol compatibility, billing, key acceptance or successful first task was tested. The examples must be filled with the user's actual endpoint/model values. No actual source installation/global command registration or screenshot-based UI validation was performed.
- Pre-existing external editor/terminal recipes above are translated and labeled as external limitations here; their upstream configuration semantics were not independently checked.
- The optional images extension is not present in this checkout. Its claimed local/HTTP handling, private-network protection, 10 MB limit and specific terminal-version requirements in the old key reference could not be checked. The image-setting rows in both languages now document the verifiable host requirement, protocols and fallback behavior instead.

## Code contradictions and constraints found

1. packages/api/src/settings.ts:77 calls maxConcurrent a per-parent limit. packages/core/src/subagents.ts enforces a tree-wide active limit, covered by the limit-across-the-tree test. Docs describe the implementation.
2. settings.ts:78–79 says a main-session agent call can override background mode. extensions/agent/src/index.ts applies mainAlwaysBackground and ignores a blocking request under the default main-session background policy. Agent tests confirm it; docs describe that policy.
3. packages/cli/src/trust.ts:55 captures project trust at startup, and the reload closure at 65 retains it. CLI extension-management messages suggest restart or /reload even for trust/untrust, but /reload alone does not refresh this captured trust. Docs prescribe restart for trust changes. Disabled package names are reread on reload.
4. packages/core/src/extensions.ts:154–156 invalidates the entry file on reload, while its imported helper modules stay cached. This is an explicit implementation constraint; docs prescribe restart for helper edits.
5. packages/cli/src/provider-admin.ts:254 clears the running AI client's stored-key fallback when switching from auth to environment/no-key, but retains the disk credential. packages/ai/src/client.ts:119 uses stored keys as a startup fallback again. Credential-source transitions can therefore behave differently before and after restart. No guessed workaround is documented.
6. packages/ai/src/server-tools.ts recognizes Azure OpenAI using hostname/path heuristics rather than a strict official-host allowlist. Docs say recognized vendor endpoints and explicitly require proxy opt-in, rather than asserting strict endpoint validation.

## Integration followups

- Task C apply_patch: update the tools descriptions only after that implementation is integrated and tested. This standalone checkout has no apply_patch tool, so these pages do not claim one.
- Task D interactive /ext: add the picker and actions to both extension pages after integration. The agreed design is user/project scope selection, user scope by default for command operations, --project for project scope, globally disabled names stored in user settings, and an offered /reload notice with no automatic reload. Trust changes still require restart unless the trust lifecycle is deliberately changed.
- Integrate the separate English/Chinese settings references to satisfy the two expected missing targets; rerun the audit afterward.

## Terminology

Chinese prose uses 引导 (steer), 排队 (queue), 轮次 (turn), 对话记录 (transcript), 子 agent (sub-agent), provider, 压缩 (compaction), 上下文窗口 (context window), 扩展 (extension), skill and worktree. Commands, key specifications, paths, setting names, code and quoted UI strings remain in English. Chinese paragraphs occupy one source line each.

## Complete code-span audit output

Command: bun docs/verify-docs.ts. Exit 0; exact stdout is also saved in verification-output.txt. REVIEW means manual disposition is required, not a verified feature or a test failure. The script reports the intentionally missing settings targets without suppressing them.

```text
Documentation code-span audit (inline spans; fenced examples require separate review)
Pages: 14; distinct spans: 429
FOUND "\"auto\"" => "\"auto\"" in extensions\commands\test\provider.test.ts
FOUND "\"fork\"" => "\"fork\"" in packages\cli\src\rpc-schema.ts
FOUND "\"fresh\"" => "\"fresh\"" in extensions\agent\test\worktree.test.ts
FOUND "\"fullscreen\"" => "\"fullscreen\"" in packages\cli\test\cli.test.ts
FOUND "\"inline\"" => "\"inline\"" in extensions\web\test\fetch.test.ts
FOUND "\"off\"" => "\"off\"" in extensions\commands\src\index.ts
FOUND "\"on\"" => "\"on\"" in packages\core\test\config.test.ts
FOUND "\"queue\"" => "\"queue\"" in packages\tui\test\keybindings.test.ts
FOUND "\"steer\"" => "\"steer\"" in packages\cli\test\rpc.test.ts
FOUND "$" => "$" in packages\proc\test\standby.test.ts
FOUND "$100 is the price" => "$100 is the price" in packages\tui\test\command-popup.test.ts
FOUND "$<name> [arguments]" => "$<name> [arguments]" in extensions\commands\test\commands.test.ts
FOUND "$AMIRA_HOME/keybindings.json" => "keybindings.json" in packages\tui\test\keybindings.test.ts
FOUND "$EDITOR" => "$EDITOR" in packages\tui\src\app.ts
FOUND "$VISUAL" => "$VISUAL" in packages\tui\test\app.test.ts
FOUND "$zzz" => "$zzz" in packages\tui\test\command-popup.test.ts
FOUND "+" => "+" in extensions\web\test\search.test.ts
FOUND "--cwd" => "--cwd" in packages\cli\test\cli.test.ts
FOUND "--disable-tools" => "--disable-tools" in packages\cli\test\cli.test.ts
FOUND "--extension" => "--extension" in packages\cli\src\args.ts
FOUND "--fullscreen" => "--fullscreen" in packages\cli\test\cli.test.ts
FOUND "--inline" => "--inline" in packages\api\src\settings.ts
FOUND "--json" => "--json" in packages\cli\test\ext-progress.test.ts
FOUND "--keep-key" => "--keep-key" in packages\cli\src\provider-command.ts
FOUND "--key-stdin" => "--key-stdin" in packages\cli\test\provider-cli.test.ts
FOUND "--model" => "--model" in packages\cli\test\cli.test.ts
FOUND "--no-key" => "--no-key" in packages\cli\test\provider-cli.test.ts
FOUND "--no-packages" => "--no-packages" in packages\cli\test\packages.test.ts
FOUND "--print" => "--print" in extensions\mcp\src\index.ts
FOUND "--project" => "--project" in packages\core\test\packages.test.ts
FOUND "--quiet" => "--quiet" in packages\cli\test\ext-progress.test.ts
FOUND "--refresh" => "--refresh" in packages\cli\src\ext-command.ts
REVIEW "--resume <session-id>" [docs/usage.md, docs/zh/usage.md]
FOUND "--rpc-schema" => "--rpc-schema" in packages\cli\test\rpc.test.ts
FOUND "--yes" => "--yes" in packages\cli\test\provider-cli.test.ts
FOUND "-c" => "-c" in LICENSE
FOUND "-p" => "-p" in LICENSE
FOUND "-r" => "-r" in extensions\web\src\search.ts
FOUND ".amira/agents/" => ".amira/agents/" in extensions\agent\src\roles.ts
REVIEW ".amira/agents/test-reviewer.md" [docs/subagents.md, docs/zh/subagents.md]
FOUND ".amira/packages" => ".amira/packages" in packages\cli\src\ext-command.ts
FOUND ".amira/packages.lock" => "packages.lock" in packages\cli\test\packages.test.ts
FOUND ".amira/settings.json" => ".amira/settings.json" in packages\api\src\settings.ts
FOUND ".rej" => ".rej" in extensions\web\test\search.test.ts
FOUND "/" => "/" in NOTICE
FOUND "/agents" => "/agents" in packages\tui-kit\test\fullscreen.test.ts
FOUND "/agents <n|id>" => "/agents <n|id>" in extensions\agent\test\agents-command.test.ts
FOUND "/agents stop <n|id>" => "/agents stop <n|id>" in extensions\agent\src\agents-command.ts
FOUND "/agents stop all" => "/agents stop all" in extensions\agent\test\agents-command.test.ts
FOUND "/agents view" => "/agents view" in extensions\agent\test\agents-command.test.ts
FOUND "/agents view <n|id>" => "/agents" in extensions\agent\test\agents-command.test.ts
FOUND "/agents worktrees" => "/agents worktrees" in extensions\agent\test\agents-command.test.ts
FOUND "/clear" => "/clear" in extensions\commands\test\commands.test.ts
FOUND "/compact" => "/compact" in extensions\commands\test\commands.test.ts
FOUND "/compact <instructions>" => "/compact" in extensions\commands\test\commands.test.ts
FOUND "/context" => "/context" in extensions\commands\test\commands.test.ts
FOUND "/cost" => "/cost" in extensions\commands\test\commands.test.ts
FOUND "/hello" => "/hello" in packages\cli\test\packages.test.ts
FOUND "/help" => "/help" in extensions\commands\test\commands.test.ts
FOUND "/model" => "/model" in extensions\commands\test\commands.test.ts
FOUND "/model <provider/model>" => "/model" in extensions\commands\test\commands.test.ts
FOUND "/model provider/model" => "/model provider/model" in extensions\commands\test\commands.test.ts
FOUND "/provider" => "/provider" in extensions\commands\test\provider.test.ts
FOUND "/provider add" => "/provider add" in packages\cli\test\control.test.ts
FOUND "/provider add openai-chat" => "/provider" in extensions\commands\test\provider.test.ts
FOUND "/provider edit <id>" => "/provider edit <id>" in extensions\commands\src\provider-command.ts
FOUND "/provider key <id>" => "/provider key <id>" in extensions\commands\src\index.ts
FOUND "/provider remove <id>" => "/provider" in extensions\commands\test\provider.test.ts
FOUND "/quit" => "/quit" in extensions\commands\test\commands.test.ts
FOUND "/reload" => "/reload" in extensions\commands\test\commands.test.ts
FOUND "/resume" => "/resume" in extensions\agent\src\index.ts
FOUND "/resume <session-id>" => "/resume" in packages\cli\src\control.ts
FOUND "/status" => "/status" in extensions\status\test\status.test.ts
FOUND "/tools" => "/tools" in extensions\commands\test\commands.test.ts
FOUND "/tools disable <name>" => "/tools disable <name>" in extensions\commands\src\index.ts
FOUND "/tools enable <name>" => "/tools" in extensions\mcp\test\fixtures\server.ts
FOUND "/verbose" => "/verbose" in packages\tui\test\app.test.ts
FOUND "0" => "0" in NOTICE
FOUND "0.0.0" => "0.0.0" in extensions\agent\package.json
FOUND "3" => "3" in LICENSE
FOUND "<details>" => "<details>" in packages\tui\test\transcript-pane.test.ts
FOUND "?" => "?" in packages\core\test\agent-review.test.ts
FOUND "? keys" => "? keys" in packages\tui\test\app.test.ts
FOUND "@" => "@" in package.json
FOUND "@amira/api" => "@amira/api" in extensions\web\test\util.ts
FOUND "@word" => "@word" in packages\tui\test\file-picker.test.ts
FOUND "AMIRA_EXTENSIONS_INDEX" => "AMIRA_EXTENSIONS_INDEX" in packages\cli\src\ext-command.ts
FOUND "AMIRA_HOME" => "AMIRA_HOME" in scripts\test-env.ts
FOUND "AMIRA_MODEL" => "AMIRA_MODEL" in scripts\test-env.ts
FOUND "API_VERSION" => "API_VERSION" in packages\core\test\agent.test.ts
FOUND "Add a provider" => "Add a provider" in extensions\commands\test\provider.test.ts
REVIEW "Amira · <folder> ⎇ <branch>" [docs/keybindings.md, docs/zh/keybindings.md]
FOUND "Apply what fits (.rej files for the rest)" => "Apply what fits (.rej files for the rest)" in extensions\agent\src\worktree.ts
FOUND "Base URL" => "Base URL" in extensions\commands\test\provider.test.ts
FOUND "Defaults for models the catalog does not know" => "Defaults for models the catalog does not know" in extensions\commands\src\provider-form.ts
FOUND "Discard" => "Discard" in extensions\agent\test\worktree.test.ts
FOUND "Don't ask again" => "Don't ask again" in packages\cli\test\cli.test.ts
REVIEW "Enter queue · Ctrl+Q steer" [docs/keybindings.md]
FOUND "Enter send · ? keys" => "Enter send · ? keys" in packages\tui\test\app.test.ts
REVIEW "Enter steer · Alt+Enter queue · Esc interrupt" [docs/keybindings.md]
FOUND "Environment variable" => "Environment variable" in extensions\commands\src\provider-form.ts
REVIEW "Esc Esc rewind" [docs/keybindings.md]
FOUND "Esc send queued" => "Esc send queued" in packages\tui\test\app.test.ts
FOUND "ExtensionAPI" => "ExtensionAPI" in extensions\web\src\index.ts
FOUND "Fetch models" => "Fetch models" in extensions\commands\src\provider-form.ts
FOUND "Id" => "Id" in extensions\agent\test\agents-command.test.ts
FOUND "Keep" => "Keep" in extensions\agent\test\agents-command.test.ts
FOUND "Keep in the worktree" => "Keep in the worktree" in extensions\agent\src\worktree.ts
FOUND "Merge" => "Merge" in extensions\agent\test\worktree.test.ts
FOUND "Message Amira" => "Message Amira" in packages\tui-kit\test\editor.test.ts
FOUND "Models" => "Models" in extensions\commands\test\provider.test.ts
FOUND "No key (a local server)" => "No key (a local server)" in extensions\commands\src\provider-form.ts
FOUND "Other…" => "Other…" in extensions\builtin-tools\test\ask-user.test.ts
FOUND "Read it from an environment variable" => "Read it from an environment variable" in extensions\commands\src\provider-form.ts
FOUND "Save" => "Save" in packages\cli\test\rpc-form.test.ts
FOUND "Shift+Enter newline" => "Shift+Enter newline" in packages\tui\test\app.test.ts
FOUND "Test connection" => "Test connection" in extensions\commands\test\provider.test.ts
FOUND "Which protocol does the provider speak?" => "Which protocol does the provider speak?" in extensions\commands\test\provider.test.ts
FOUND "Y" => "Y" in LICENSE
FOUND "abort" => "abort" in extensions\web\test\search.test.ts
FOUND "adaptive" => "adaptive" in packages\ai\src\dialects\anthropic-request.ts
FOUND "agent" => "agent" in extensions\web\test\fetch.test.ts
FOUND "agent_result" => "agent_result" in extensions\agent\test\agent.test.ts
FOUND "agents.<role>.model" => "agents.<role>.model" in extensions\agent\test\roles.test.ts
FOUND "agents/" => "agents/" in packages\tui\test\app.test.ts
FOUND "alt" => "alt" in LICENSE
FOUND "alt+c" => "alt+c" in packages\tui\src\keybindings.ts
FOUND "alt+down" => "alt+down" in packages\tui\src\keybindings.ts
FOUND "alt+end" => "alt+end" in packages\tui\src\keybindings.ts
FOUND "alt+enter" => "alt+enter" in packages\tui\test\keybindings.test.ts
FOUND "alt+f" => "alt+f" in packages\tui\src\keybindings.ts
FOUND "alt+home" => "alt+home" in packages\tui\src\keybindings.ts
FOUND "alt+up" => "alt+up" in packages\tui\src\keybindings.ts
FOUND "amira" => "amira" in package.json
FOUND "amira --continue" => "--continue" in packages\cli\src\args.ts
FOUND "amira --extension ./hello-extension/index.ts" => "--extension" in packages\cli\src\args.ts
FOUND "amira --resume" => "--resume" in packages\api\src\events.ts
FOUND "amira -c" => "amira -c" in packages\cli\test\resume.test.ts
FOUND "amira -p \"/status\"" => "-p" in LICENSE
FOUND "amira -p -r" => "amira -p -r" in packages\cli\test\resume.test.ts
FOUND "amira -r" => "amira -r" in packages\cli\test\resume.test.ts
FOUND "amira -r <session-id>" => "-r" in packages\api\src\events.ts
FOUND "amira-package.json" => "amira-package.json" in packages\core\test\packages.test.ts
FOUND "anthropic-messages" => "anthropic-messages" in packages\cli\test\config.test.ts
FOUND "apiKeyEnv" => "apiKeyEnv" in extensions\web\test\search.test.ts
FOUND "apiKeyEnvFallbacks" => "apiKeyEnvFallbacks" in packages\ai\test\client.test.ts
FOUND "apiVersion" => "apiVersion" in extensions\builtin-tools\test\index.test.ts
FOUND "ask_user" => "ask_user" in packages\cli\test\ask-user.test.ts
FOUND "auto" => "auto" in packages\tui-kit\test\capabilities.test.ts
FOUND "background: true" => "background: true" in extensions\agent\test\agents-command.test.ts
FOUND "backspace" => "backspace" in packages\tui-kit\src\keys.ts
FOUND "budget" => "budget" in extensions\agent\test\agent.test.ts
FOUND "budget.costUsd" => "budget.costUsd" in packages\core\test\config.test.ts
REVIEW "budget.tokens" [docs/subagents.md, docs/zh/subagents.md]
REVIEW "bun run amira" [README.md, README.zh-CN.md, docs/getting-started.md, docs/zh/getting-started.md]
FOUND "busy" => "busy" in extensions\commands\test\provider.test.ts
FOUND "c" => "c" in NOTICE
FOUND "cancel" => "cancel" in extensions\agent\test\agents-command.test.ts
FOUND "caps" => "caps" in packages\ai\test\anthropic-live.test.ts
FOUND "caps.webSearch" => "caps.webSearch" in packages\ai\src\server-tools.ts
FOUND "catalogId" => "catalogId" in packages\core\test\config.test.ts
FOUND "cmd" => "cmd" in extensions\agent\test\agents-command.test.ts
FOUND "code" => "code" in LICENSE
REVIEW "code --wait" [docs/keybindings.md, docs/zh/keybindings.md]
FOUND "coder" => "coder" in extensions\web\src\fetch.ts
FOUND "command.complete" => "command.complete" in packages\cli\test\rpc.test.ts
FOUND "command.list" => "command.list" in packages\cli\test\rpc.test.ts
FOUND "command.run" => "command.run" in packages\proc\src\worker.ts
FOUND "commands" => "commands" in extensions\commands\test\provider.test.ts
FOUND "compact.model" => "compact.model" in packages\core\src\agent.ts
FOUND "compaction" => "compaction" in extensions\commands\test\commands.test.ts
FOUND "compat" => "compat" in extensions\commands\test\provider.test.ts
FOUND "context" => "context" in extensions\builtin-tools\test\diff.test.ts
FOUND "contextWindow" => "contextWindow" in extensions\commands\test\provider.test.ts
FOUND "copy.reply" => "copy.reply" in packages\tui\src\app.ts
FOUND "ctrl" => "ctrl" in packages\tui-kit\test\editor.test.ts
FOUND "ctrl++" => "ctrl++" in packages\tui\test\keybindings.test.ts
FOUND "ctrl+c" => "ctrl+c" in packages\tui\test\keybindings.test.ts
FOUND "ctrl+d" => "ctrl+d" in packages\tui\src\keybindings.ts
FOUND "ctrl+down" => "ctrl+down" in packages\tui\src\keybindings.ts
FOUND "ctrl+end" => "ctrl+end" in packages\tui\src\keybindings.ts
FOUND "ctrl+enter" => "ctrl+enter" in packages\tui-kit\test\input.test.ts
FOUND "ctrl+f" => "ctrl+f" in packages\tui\test\app.test.ts
FOUND "ctrl+g" => "ctrl+g" in packages\tui\test\app.test.ts
FOUND "ctrl+home" => "ctrl+home" in packages\tui\src\keybindings.ts
FOUND "ctrl+k" => "ctrl+k" in packages\tui\src\keybindings.ts
FOUND "ctrl+l" => "ctrl+l" in packages\tui-kit\test\input.test.ts
FOUND "ctrl+o" => "ctrl+o" in packages\tui\src\keybindings.ts
FOUND "ctrl+q" => "ctrl+q" in packages\tui\test\keybindings.test.ts
FOUND "ctrl+r" => "ctrl+r" in packages\tui\src\keybindings.ts
FOUND "ctrl+s" => "ctrl+s" in packages\tui\src\keybindings.ts
FOUND "ctrl+shift+z" => "ctrl+shift+z" in packages\tui\src\keybindings.ts
FOUND "ctrl+t" => "ctrl+t" in packages\tui\test\app.test.ts
FOUND "ctrl+u" => "ctrl+u" in packages\tui\src\keybindings.ts
FOUND "ctrl+up" => "ctrl+up" in packages\tui\src\keybindings.ts
FOUND "ctrl+w" => "ctrl+w" in packages\tui\src\keybindings.ts
FOUND "ctrl+y" => "ctrl+y" in packages\tui\test\app.test.ts
FOUND "ctrl+z" => "ctrl+z" in packages\tui\src\keybindings.ts
FOUND "cwd" => "cwd" in extensions\web\test\util.ts
FOUND "decorateToolRenderer" => "decorateToolRenderer" in extensions\builtin-tools\test\index.test.ts
FOUND "defaultModel" => "defaultModel" in packages\ai\test\cost.test.ts
FOUND "defineExtension" => "defineExtension" in extensions\web\src\index.ts
FOUND "defineTool" => "defineTool" in extensions\web\src\index.ts
FOUND "delete" => "delete" in scripts\test-env.ts
FOUND "description" => "description" in LICENSE
FOUND "dialog.cancel" => "dialog.cancel" in packages\tui\src\app.ts
FOUND "dialog.choose" => "dialog.choose" in packages\tui\src\dialog.ts
FOUND "dialog.down" => "dialog.down" in packages\tui\src\dialog.ts
FOUND "dialog.next-question" => "dialog.next-question" in packages\tui\src\dialog.ts
FOUND "dialog.no" => "dialog.no" in packages\tui\src\dialog.ts
FOUND "dialog.prev-question" => "dialog.prev-question" in packages\tui\src\dialog.ts
FOUND "dialog.toggle" => "dialog.toggle" in packages\tui\test\dialog.test.ts
FOUND "dialog.up" => "dialog.up" in packages\tui\test\keybindings.test.ts
FOUND "dialog.yes" => "dialog.yes" in packages\tui\test\dialog.test.ts
FOUND "down" => "down" in extensions\mcp\test\teardown.test.ts
FOUND "edit.external" => "edit.external" in packages\tui\src\app.ts
FOUND "edit.kill-to-end" => "edit.kill-to-end" in packages\tui\src\app.ts
FOUND "edit.kill-to-start" => "edit.kill-to-start" in packages\tui\src\app.ts
FOUND "edit.kill-word" => "edit.kill-word" in packages\tui\src\app.ts
FOUND "edit.redo" => "edit.redo" in packages\tui\src\app.ts
FOUND "edit.undo" => "edit.undo" in packages\tui\src\app.ts
FOUND "edit.yank" => "edit.yank" in packages\tui\src\keybindings.ts
FOUND "end" => "end" in LICENSE
FOUND "engines.amira" => "engines.amira" in packages\core\src\packages\index-file.ts
FOUND "enter" => "enter" in extensions\agent\src\index.ts
FOUND "esc" => "esc" in LICENSE
FOUND "escape" => "escape" in packages\tui-kit\examples\demo.ts
FOUND "events.lost" => "events.lost" in packages\api\src\events.ts
FOUND "exit" => "exit" in scripts\test-env.ts
FOUND "explorer" => "explorer" in packages\cli\test\cli.test.ts
FOUND "extensions" => "extensions" in package.json
FOUND "f1" => "f1" in packages\tui-kit\test\input.test.ts
FOUND "f12" => "f12" in packages\tui-kit\src\input.ts
FOUND "f3" => "f3" in packages\tui-kit\src\input.ts
FOUND "false" => "false" in extensions\agent\test\worktree.test.ts
FOUND "find" => "find" in extensions\agent\test\worktree.test.ts
FOUND "find.close" => "find.close" in packages\tui\src\fullscreen-view.ts
FOUND "find.next" => "find.next" in packages\tui\src\fullscreen-view.ts
FOUND "find.prev" => "find.prev" in packages\tui\src\fullscreen-view.ts
FOUND "full" => "full" in extensions\agent\test\presenter.test.ts
FOUND "google-gemini" => "google-gemini" in packages\ai\test\buffered-abort.test.ts
REVIEW "hello-extension" [docs/extensions.md, docs/zh/extensions.md]
FOUND "help" => "help" in extensions\agent\test\roles.test.ts
FOUND "history.next" => "history.next" in packages\tui\src\app.ts
FOUND "history.prev" => "history.prev" in packages\tui\test\app.test.ts
FOUND "history.search" => "history.search" in packages\tui\test\app.test.ts
FOUND "home" => "home" in scripts\test-env.ts
FOUND "https://api.anthropic.com" => "https://api.anthropic.com" in packages\ai\test\compaction-live.test.ts
FOUND "https://api.openai.com/v1" => "https://api.openai.com/v1" in packages\ai\test\replay.test.ts
FOUND "https://generativelanguage.googleapis.com/v1beta" => "https://generativelanguage.googleapis.com/v1beta" in packages\ai\test\probe.test.ts
FOUND "id" => "id" in LICENSE
FOUND "index.ts" => "index.ts" in extensions\skills\test\skills.test.ts
FOUND "insert" => "insert" in packages\tui-kit\test\editor.test.ts
FOUND "intercept" => "intercept" in extensions\web\test\fetch.test.ts
FOUND "interrupt" => "interrupt" in extensions\status\test\status.test.ts
FOUND "isolation" => "isolation" in extensions\agent\test\roles.test.ts
FOUND "isolation: \"worktree\"" => "isolation: \"worktree\"" in extensions\agent\test\roles.test.ts
FOUND "isolation: worktree" => "isolation: worktree" in extensions\agent\test\roles.test.ts
FOUND "j" => "j" in LICENSE
FOUND "k" => "k" in LICENSE
FOUND "lastTurn" => "lastTurn" in packages\cli\test\rpc.test.ts
FOUND "left" => "left" in scripts\test-env.ts
FOUND "maxOutput" => "maxOutput" in extensions\commands\test\provider.test.ts
FOUND "maxTokensField" => "maxTokensField" in packages\ai\src\dialect.ts
FOUND "max_completion_tokens" => "max_completion_tokens" in packages\ai\test\probe.test.ts
FOUND "max_tokens" => "max_tokens" in packages\ai\test\anthropic-stream.test.ts
REVIEW "merge.reviewThreshold.files" [docs/subagents.md, docs/zh/subagents.md]
REVIEW "merge.reviewThreshold.lines" [docs/subagents.md, docs/zh/subagents.md]
FOUND "message" => "message" in extensions\web\test\search.test.ts
FOUND "messages" => "messages" in extensions\commands\src\format.ts
FOUND "meta" => "meta" in packages\net\test\fetch-public.test.ts
FOUND "model" => "model" in packages\ai\test\buffered-abort.test.ts
FOUND "model.set" => "model.set" in packages\cli\test\rpc.test.ts
FOUND "models" => "models" in extensions\commands\test\provider.test.ts
FOUND "n" => "n" in package.json
FOUND "name" => "name" in LICENSE
FOUND "newline" => "newline" in packages\api\src\process.ts
FOUND "no command matches /zzz" => "no command matches /zzz" in packages\tui\test\command-popup.test.ts
FOUND "none" => "none" in extensions\agent\test\worktree.test.ts
FOUND "notify" => "notify" in packages\api\src\events.ts
FOUND "null" => "null" in extensions\agent\src\roles.ts
FOUND "o" => "o" in NOTICE
FOUND "off" => "off" in LICENSE
FOUND "ok: false" => "ok: false" in extensions\agent\test\worktree.test.ts
FOUND "ok: true" => "ok: true" in packages\cli\test\rpc.test.ts
FOUND "on" => "on" in LICENSE
FOUND "onExit" => "onExit" in extensions\builtin-tools\test\index.test.ts
FOUND "openPipe" => "openPipe" in packages\proc\src\index.ts
FOUND "openView" => "openView" in extensions\agent\test\agents-command.test.ts
FOUND "openai-chat" => "openai-chat" in extensions\commands\test\provider.test.ts
FOUND "openai-responses" => "openai-responses" in packages\core\test\config.test.ts
FOUND "option" => "option" in extensions\commands\test\provider.test.ts
FOUND "override: true" => "override: true" in packages\api\src\extension.ts
FOUND "p" => "p" in LICENSE
FOUND "package.json" => "package.json" in packages\cli\test\packages.test.ts
FOUND "packages.lock" => "packages.lock" in packages\cli\test\packages.test.ts
FOUND "pagedown" => "pagedown" in packages\tui-kit\test\input.test.ts
FOUND "pageup" => "pageup" in packages\tui-kit\test\fullscreen.test.ts
FOUND "panels.toggle" => "panels.toggle" in packages\tui\src\app.ts
FOUND "popup.accept" => "popup.accept" in packages\tui\test\app.test.ts
FOUND "popup.close" => "popup.close" in packages\tui\test\app.test.ts
FOUND "popup.complete" => "popup.complete" in packages\tui\src\keybindings.ts
FOUND "popup.down" => "popup.down" in packages\tui\test\app.test.ts
FOUND "popup.up" => "popup.up" in packages\tui\test\command-popup.test.ts
FOUND "prompt" => "prompt" in extensions\agent\test\agent.test.ts
FOUND "provideService" => "provideService" in packages\api\src\extension.ts
FOUND "provider/model" => "provider/model" in extensions\agent\src\roles.ts
FOUND "q" => "q" in LICENSE
FOUND "queue" => "queue" in extensions\web\test\fetch.test.ts
FOUND "redraw" => "redraw" in packages\tui-kit\test\fullscreen-images.test.ts
FOUND "registerCommand" => "registerCommand" in packages\api\src\extension.ts
FOUND "registerImageProvider" => "registerImageProvider" in packages\api\src\extension.ts
FOUND "registerInputHandler" => "registerInputHandler" in extensions\builtin-tools\test\index.test.ts
FOUND "registerMarkdownRenderer" => "registerMarkdownRenderer" in packages\tui\test\app.test.ts
FOUND "registerPanel" => "registerPanel" in extensions\builtin-tools\test\index.test.ts
FOUND "registerSkill" => "registerSkill" in packages\cli\test\control.test.ts
FOUND "registerStatusItem" => "registerStatusItem" in extensions\builtin-tools\test\index.test.ts
FOUND "registerTool" => "registerTool" in extensions\web\src\index.ts
FOUND "registerToolRenderer" => "registerToolRenderer" in extensions\web\src\index.ts
FOUND "registerView" => "registerView" in packages\api\src\commands.ts
REVIEW "reply 3 of 9" [docs/keybindings.md, docs/zh/keybindings.md]
FOUND "reportError" => "reportError" in extensions\skills\src\index.ts
FOUND "requestId" => "requestId" in extensions\commands\test\provider.test.ts
FOUND "requestRender" => "requestRender" in extensions\status\test\status.test.ts
FOUND "reviewer" => "reviewer" in extensions\agent\test\roles.test.ts
FOUND "right" => "right" in NOTICE
FOUND "runCommand" => "runCommand" in extensions\agent\test\worktree.test.ts
FOUND "s_" => "s_" in packages\ai\test\openai-responses-compaction.test.ts
FOUND "scroll.bottom" => "scroll.bottom" in packages\tui\test\keybindings.test.ts
FOUND "scroll.down" => "scroll.down" in packages\tui\src\fullscreen-view.ts
FOUND "scroll.page-down" => "scroll.page-down" in packages\tui\src\fullscreen-view.ts
FOUND "scroll.page-up" => "scroll.page-up" in packages\tui\src\fullscreen-view.ts
FOUND "scroll.top" => "scroll.top" in packages\tui\test\keybindings.test.ts
FOUND "scroll.up" => "scroll.up" in packages\tui\src\fullscreen-view.ts
FOUND "search.accept" => "search.accept" in packages\tui\src\app.ts
FOUND "search.cancel" => "search.cancel" in packages\tui\test\app.test.ts
FOUND "search.newer" => "search.newer" in packages\tui\src\history-search.ts
FOUND "search.older" => "search.older" in packages\tui\src\app.ts
FOUND "select.back" => "select.back" in packages\tui\src\fullscreen-view.ts
FOUND "select.copy" => "select.copy" in packages\tui\src\fullscreen-view.ts
FOUND "select.exit" => "select.exit" in packages\tui\src\fullscreen-view.ts
FOUND "select.next" => "select.next" in packages\tui\src\fullscreen-view.ts
FOUND "select.open" => "select.open" in packages\tui\src\fullscreen-view.ts
FOUND "select.prev" => "select.prev" in packages\tui\src\fullscreen-view.ts
FOUND "select.start" => "select.start" in packages\tui\src\fullscreen-view.ts
FOUND "select.toggle" => "select.toggle" in packages\tui\src\keybindings.ts
FOUND "session.read" => "session.read" in packages\cli\test\rpc.test.ts
FOUND "session.resume" => "session.resume" in extensions\commands\src\index.ts
FOUND "session.start" => "session.start" in extensions\commands\src\index.ts
FOUND "sessionId" => "sessionId" in extensions\commands\test\commands.test.ts
REVIEW "set-clipboard on" [docs/keybindings.md, docs/zh/keybindings.md]
FOUND "settings" => "settings" in scripts\test-env.ts
FOUND "settings.json" => "settings.json" in extensions\commands\src\provider-form.ts
FOUND "shift" => "shift" in packages\cli\test\ask-user.test.ts
FOUND "shift+down" => "shift+down" in packages\tui\src\keybindings.ts
FOUND "shift+enter" => "shift+enter" in packages\tui-kit\test\input.test.ts
FOUND "shift+f3" => "shift+f3" in packages\tui\src\keybindings.ts
FOUND "shift+tab" => "shift+tab" in packages\tui\test\keybindings.test.ts
FOUND "shift+up" => "shift+up" in packages\tui\src\keybindings.ts
FOUND "skill.list" => "skill.list" in packages\cli\src\rpc-schema.ts
FOUND "skill.run" => "skill.run" in packages\cli\test\rpc.test.ts
FOUND "skills" => "skills" in extensions\commands\test\commands.test.ts
FOUND "space" => "space" in package.json
FOUND "src/index.ts" => "src/index.ts" in packages\api\test\net.test.ts
FOUND "state" => "state" in LICENSE
FOUND "steer" => "steer" in packages\cli\test\control.test.ts
FOUND "streamUsage" => "streamUsage" in packages\core\test\config.test.ts
FOUND "subagents.background" => "subagents.background" in extensions\agent\test\agent.test.ts
FOUND "subagents.maxConcurrent" => "subagents.maxConcurrent" in packages\cli\src\session.ts
FOUND "subagents.maxDepth" => "subagents.maxDepth" in packages\cli\src\session.ts
FOUND "submit" => "submit" in LICENSE
FOUND "submit.queue" => "submit.queue" in packages\tui\test\keybindings.test.ts
FOUND "submit.steer" => "submit.steer" in packages\tui\test\keybindings.test.ts
FOUND "tab" => "tab" in extensions\web\test\fetch.test.ts
REVIEW "terminal.integrated.commandsToSkipShell" [docs/keybindings.md, docs/zh/keybindings.md]
REVIEW "terminal.integrated.macOptionClickForcesSelection" [docs/keybindings.md, docs/zh/keybindings.md]
FOUND "text.clear" => "text.clear" in packages\tui\src\fullscreen-view.ts
FOUND "textResult" => "textResult" in extensions\agent\test\presenter.test.ts
FOUND "thinking" => "thinking" in packages\tui\test\app.test.ts
FOUND "tool-output" => "tool-output" in extensions\builtin-tools\src\truncate.ts
FOUND "tool.execute.end" => "tool.execute.end" in extensions\agent\test\agent.test.ts
FOUND "tool.execute.start" => "tool.execute.start" in extensions\agent\src\index.ts
FOUND "tools" => "tools" in extensions\agent\test\roles.test.ts
FOUND "true" => "true" in LICENSE
FOUND "tui" => "tui" in extensions\skills\test\skills.test.ts
FOUND "tui.bell" => "tui.bell" in packages\core\test\config.test.ts
FOUND "tui.images" => "tui.images" in packages\tui\test\app.test.ts
FOUND "tui.mode" => "tui.mode" in packages\core\test\config.test.ts
FOUND "tui.progress" => "progress" in scripts\test-env.ts
FOUND "tui.reflow" => "tui.reflow" in packages\tui\test\app.test.ts
FOUND "tui.shellOutputLines" => "tui.shellOutputLines" in packages\tui\test\format.test.ts
FOUND "tui.submitWhileWorking" => "tui.submitWhileWorking" in packages\core\test\config.test.ts
FOUND "tui.submitWhileWorking: \"queue\"" => "submitWhileWorking: \"queue\"" in packages\core\test\config.test.ts
FOUND "tui.title" => "title" in extensions\commands\test\provider.test.ts
FOUND "turn.end" => "turn.end" in packages\cli\test\rpc.test.ts
FOUND "turnId" => "turnId" in packages\cli\test\rpc.test.ts
FOUND "ui" => "ui" in LICENSE
FOUND "ui.action" => "ui.action" in packages\api\src\ui.ts
FOUND "ui.configure" => "ui.configure" in packages\cli\test\rpc.test.ts
FOUND "ui.focus" => "ui.focus" in packages\api\src\events.ts
FOUND "ui.respond" => "ui.respond" in extensions\agent\test\agents-command.test.ts
FOUND "up" => "up" in LICENSE
FOUND "useService" => "useService" in packages\api\src\services.ts
FOUND "value" => "value" in packages\api\test\form.test.ts
FOUND "version" => "version" in LICENSE
FOUND "web.nativeSearch" => "web.nativeSearch" in packages\ai\src\client.ts
FOUND "webSearch" => "webSearch" in extensions\web\test\presenters.test.ts
FOUND "web_fetch" => "web_fetch" in extensions\agent\test\roles.test.ts
FOUND "web_search" => "web_search" in extensions\agent\test\roles.test.ts
FOUND "what" => "what" in scripts\test-env.ts
FOUND "workspace.changed" => "workspace.changed" in packages\api\src\events.ts
FOUND "worktree" => "worktree" in extensions\status\test\status.test.ts
FOUND "x" => "x" in LICENSE
FOUND "y" => "y" in LICENSE
FOUND "~/.amira/auth.json" => "~/.amira/auth.json" in extensions\commands\test\provider.test.ts
FOUND "~/.amira/keybindings.json" => "~/.amira/keybindings.json" in packages\tui\src\keybindings.ts
FOUND "~/.amira/packages" => "~/.amira/packages" in packages\cli\src\ext-command.ts
FOUND "~/.amira/packages.lock" => "packages.lock" in packages\cli\test\packages.test.ts
FOUND "›" => "›" in packages\tui-kit\test\fullscreen.test.ts
FOUND "←" => "←" in packages\tui\test\subagent-view.test.ts
FOUND "↑" => "↑" in packages\tui-kit\test\box.test.ts
FOUND "→" => "→" in packages\cli\test\ask-user.test.ts
FOUND "↓" => "↓" in packages\tui-kit\test\box.test.ts
REVIEW "↓ 124 rows below" [docs/keybindings.md, docs/zh/keybindings.md]
REVIEW "↓ new output · 124 rows below" [docs/keybindings.md, docs/zh/keybindings.md]
FOUND "⎇" => "⎇" in packages\tui\test\terminal-status.test.ts
FOUND "└" => "└" in extensions\agent\test\agents-command.test.ts
FOUND "▌" => "▌" in packages\tui-kit\test\fullscreen-images.test.ts
FOUND "●" => "●" in extensions\agent\test\agents-command.test.ts
Summary: 411 spans have source matches; 18 need manual review.
Missing local link targets: docs/settings.md, docs/zh/settings.md

```

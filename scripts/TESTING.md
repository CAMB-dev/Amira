# Tests

Run `bun run check` for architecture, types, lint and the full test suite.
`bun test` and `bun run test` remain serial. Four-worker runs, both with and without
per-file VM isolation, sometimes finished below three minutes but also produced
intermittent native Git and PowerShell failures. Six workers additionally hit process
startup timeouts. Parallelism is therefore not enabled; no retries, raised timeouts or
removed assertions are used to disguise those failures. The under-three-minute target
remains unmet in the reliable serial configuration.

For a focused test, use `bun test <path>`. Use a 600,000 ms command timeout for each full
run, especially on Windows.

## Timing a run

Bun 1.4.2 records both file wall times and individual test durations without a separate
process per file:

```sh
mkdir -p node_modules/.cache/test-speed
bun test --timings=node_modules/.cache/test-speed/files.json --update-timings \
  --reporter=junit --reporter-outfile=node_modules/.cache/test-speed/tests.xml
```

The JSON's `files` map contains milliseconds. JUnit `testcase` times are seconds.
Use serial runs for before/after file comparisons; parallel file times include competition
for machine resources. Avoid running other benchmarks or test invocations at the same time.
The measurements below were taken on Windows with Bun 1.4.2.

## Isolation

The shared preload redirects `HOME`, `USERPROFILE`, `AMIRA_HOME` and `XDG_CONFIG_HOME`
to an owned temporary home before application imports. Tests may still select their own
temporary homes. Child processes inherit the isolated environment; executable lookup
through `PATH` is preserved.

A process-local filesystem guard rejects writes to the launching shell's Amira homes
and records attempts even if application code catches the error. Its tests use fake
protected directories, never the real home. It does not watch, snapshot, change
permissions on, or restore the real home: another running Amira may legitimately write
there. This is a regression guard, not an OS sandbox; arbitrary native subprocesses
and uninstrumented child runtimes are not intercepted. Pre-captured filesystem functions,
pre-existing hard links and symlink races are also outside its scope. Cleanup is confined
to the owned temporary home; Windows may leave its directory behind while a standby
still holds it open. That does not bypass the real-home write checks.

Git integration fixtures copy prepared repository templates into independent temporary
repositories. Mutable refs, indexes, objects and worktree registrations are never shared
between tests. The clones, fetches, merges and locks under test still use real Git.

Prefer readiness signals or bounded condition waits to fixed sleeps. The historical
file-picker race (`d0fb241`, `f9cc40e`) required waiting for scheduled ingestion/search,
not sleeping for 1 ms. Tests specifically covering timeout behavior retain that coverage.

## Measurements

Measured on Windows with Bun 1.4.2. The baseline serial suite passed in **433.75 s**
(3,052 pass, 13 skip). An intermediate post-optimization serial profile passed in
**402.56 s**. Final command wall times below use a monotonic stopwatch.

The original `bun run check` stopped after about 12 seconds, before tests, because
Biome checked an untracked local settings file with CRLF endings. That private file
is excluded from linting rather than reformatted; there is no successful baseline
full-check duration to compare against.

| Final verification command | Seconds | Result |
|---|---:|---|
| Typecheck | 0.96 | Passed |
| Biome on changed files | 0.26 | Passed |
| Architecture check | 8.24 | Passed |
| Full serial bun test #1 | 383.19 | Passed |
| Full serial bun test #2 | 378.26 | Passed |
| bun run check | 393.14 | Passed |

resume-final-test-1: 3063 pass, 14 skip, 0 fail.

resume-final-test-2: 3063 pass, 14 skip, 0 fail.

resume-final-check: 3063 pass, 14 skip, 0 fail.

The under-three-minute target remains unmet. One exploratory four-worker check
finished in 153.22 s, but repeat runs failed. Both per-file VM isolation and registry
reuse were tried; six workers were also unreliable. No parallel configuration is
retained, and the underlying native-process failures remain undiagnosed. Independent
test activity was observed during some exploratory measurements; it was not stopped.

The file-picker hardening passed 20 repetitions (460 tests); its remaining timing race
was identified from scheduling and history, not independently reproduced. A reproduced
slow Windows process probe and a background-job startup assumption were made deterministic.

Validation is for Windows/Bun 1.4.2. A supplementary WSL/Bun 1.3.14 run exposed that
older runtime's cached os.homedir() behavior; that compatibility issue is not fixed.

The following files are ranked by baseline duration; the after column is the first
final serial verification run. Individual-test durations below are from baseline JUnit.

## Slowest files (baseline rank)

| File | Before (s) | Final serial #1 (s) |
|---|---:|---:|
| `extensions/builtin-tools/test/powershell.test.ts` | 70.57 | 63.58 |
| `packages/packages/test/git-cache.test.ts` | 45.07 | 38.53 |
| `packages/packages/test/packages.test.ts` | 24.47 | 23.57 |
| `extensions/builtin-tools/test/jobs.test.ts` | 20.69 | 20.04 |
| `extensions/agent/test/worktree.test.ts` | 19.37 | 15.57 |
| `extensions/commands/test/commands.test.ts` | 18.65 | 2.70 |
| `extensions/agent/test/agent.test.ts` | 17.31 | 18.38 |
| `packages/proc/test/standby.test.ts` | 14.55 | 4.43 |
| `extensions/builtin-tools/test/bash.test.ts` | 12.73 | 11.61 |
| `packages/proc/test/pipe.test.ts` | 11.64 | 9.99 |
| `extensions/commands/test/ext.test.ts` | 9.58 | 10.09 |
| `packages/tui/test/app-turns.test.ts` | 9.58 | 9.44 |
| `packages/tui/test/app-rendering.test.ts` | 9.39 | 9.28 |
| `extensions/builtin-tools/test/shell.test.ts` | 8.41 | 8.37 |
| `packages/tui/test/fullscreen.test.ts` | 8.38 | 8.44 |
| `packages/cli/test/rpc.test.ts` | 8.06 | 7.70 |
| `packages/proc/test/jobs.test.ts` | 7.97 | 6.46 |
| `extensions/agent/test/agents-command.test.ts` | 7.52 | 7.42 |
| `packages/cli/test/session-management.test.ts` | 6.92 | 6.54 |
| `packages/cli/test/control.test.ts` | 4.76 | 4.80 |
| `packages/tui/test/app-input.test.ts` | 4.43 | 4.37 |
| `extensions/agent/test/workspace.test.ts` | 4.38 | 4.18 |
| `packages/tui/test/app-subagents.test.ts` | 4.35 | 4.32 |
| `packages/cli/test/resume.test.ts` | 4.07 | 3.76 |
| `packages/tui/test/file-picker.test.ts` | 3.69 | 2.19 |
| `packages/tui-kit/test/markdown-stream.test.ts` | 3.65 | 2.80 |
| `packages/tui/test/app-commands.test.ts` | 3.55 | 3.50 |
| `packages/tui/test/app-fullscreen.test.ts` | 3.35 | 3.34 |
| `packages/cli/test/jobs-subagent.test.ts` | 3.05 | 3.04 |
| `packages/cli/test/ext-progress.test.ts` | 3.02 | 3.23 |

## Slowest individual tests (baseline)

| Seconds | File | Test |
|---:|---|---|
| 9.08 | `packages/proc/test/standby.test.ts` | an idle standby does not keep the process alive, and dies with it |
| 6.54 | `extensions/builtin-tools/test/powershell.test.ts` | PowerShell 7 (pwsh) > a returning try records the status after its finally blocks |
| 6.33 | `packages/packages/test/packages.test.ts` | update keeps going past a package that fails, which keeps its files and pin; unchanged ones stay as they are |
| 5.95 | `extensions/agent/test/agents-command.test.ts` | /agents lists the worktrees sub-agents kept, to merge, keep or discard each over its diff |
| 5.80 | `packages/packages/test/git-cache.test.ts` | many packages from one repository: one ls-remote and one download per command |
| 5.79 | `packages/packages/test/git-cache.test.ts` | a tag that moved or went away upstream is followed without cloning again |
| 5.64 | `extensions/builtin-tools/test/powershell.test.ts` | PowerShell 7 (pwsh) > declarations and dot-sourced state work as natively |
| 5.05 | `packages/packages/test/git-cache.test.ts` | two amira processes share the cache: the second waits for the lock and downloads nothing |
| 4.94 | `packages/packages/test/packages.test.ts` | installs from a git repository, pins the commit, restores the pin and updates past it |
| 4.27 | `packages/packages/test/git-cache.test.ts` | an annotated tag, a branch and an abbreviated commit resolve like a clone would |
| 4.21 | `packages/packages/test/git-cache.test.ts` | a fetch that fails keeps the cache: a later offline restore still works |
| 4.21 | `packages/cli/test/rpc.test.ts` | amira --rpc drops deltas when the client stops reading stdout |
| 4.20 | `packages/cli/test/session-management.test.ts` | amira sessions rm refuses a session leased by another process |
| 4.14 | `extensions/builtin-tools/test/powershell.test.ts` | Windows PowerShell 5.1 > declarations and dot-sourced state work as natively |
| 4.08 | `extensions/builtin-tools/test/powershell.test.ts` | Windows PowerShell 5.1 > a returning try records the status after its finally blocks |
| 4.04 | `packages/packages/test/packages.test.ts` | update leaves a package in a repository's subdirectory alone when only other parts changed |
| 4.01 | `extensions/commands/test/commands.test.ts` | /permissions lists the mode and the rules with their sources; /status counts them |
| 4.01 | `extensions/commands/test/commands.test.ts` | /cost and /status keep unpriced searches unknown after priced replies |
| 3.91 | `packages/packages/test/git-cache.test.ts` | offline: pinned commits come from the cache; an update fails and keeps the old version |
| 3.88 | `packages/packages/test/git-cache.test.ts` | cache clean and prune: unused caches go, used and busy ones stay |
| 3.60 | `extensions/builtin-tools/test/powershell.test.ts` | PowerShell 7 (pwsh) > a top-level return exits on $? as pwsh -Command does, not on errors handled before it |
| 3.57 | `packages/proc/test/pipe.test.ts` | long-lived piped processes never hold a short command's pipes open |
| 3.53 | `extensions/commands/test/ext.test.ts` | /ext local file git install, reinstall, update, disable, enable and remove use the core |
| 3.45 | `extensions/builtin-tools/test/bash.test.ts` | the first call in a fresh process times out with no surviving grandchildren |
| 3.43 | `packages/packages/test/git-cache.test.ts` | the first install makes a blobless cache of the repository; an update fetches into it |
| 3.36 | `packages/tui/test/app-rendering.test.ts` | an image slower than its time is committed as its alt text, and what follows goes on |
| 3.04 | `packages/cli/test/jobs-subagent.test.ts` | a sub-agent's background job runs while it works and is stopped when it ends; the top-level session's keeps running |
| 3.04 | `extensions/builtin-tools/test/shell.test.ts` | through cmd, an empty or missing gate line runs nothing |
| 3.02 | `extensions/builtin-tools/test/powershell.test.ts` | PowerShell 7 (pwsh) > abort stops a long command promptly |
| 3.01 | `extensions/builtin-tools/test/powershell.test.ts` | Windows PowerShell 5.1 > abort stops a long command promptly |

# Tests

Run `bun run check` for architecture, types, lint and the full test suite.
`bun run test` uses **three workers** with longest-file-first scheduling
(`bun test --parallel=3 --timings=scripts/test-timings.json`); `check` calls that script.
Bare `bun test` remains the serial diagnostic command. Bun 1.4.2's `--parallel` implies
per-file VM isolation: do not add `--no-isolate` or `--concurrent`. The latter also runs
tests within a file concurrently, which these fixtures are not designed for.
Four and six workers still have unexplained native-process failures and are not the
defaults. See the current diagnosis and verification below; the earlier job's timings
are historical, not measurements of a fix for those failures.

For a focused test, use `bun test <path>`. Use a 600,000 ms command timeout for each full
run, especially on Windows. Repeat native integration tests in **fresh invocations**:
`--rerun-each` can reuse a home after the preload's `afterAll` has removed it. During
diagnosis that produced PowerShell `uv_spawn ENOENT` on later repetitions, not a missing
PowerShell installation.

## Four/six-worker diagnosis (2026-10-05)

**Incomplete: no causal fix is claimed; retain three workers.** Windows, Bun 1.4.2,
Git 2.55.0.windows.5. All suite runs below used `--timings=scripts/test-timings.json`,
fresh invocations and no overlapping benchmarks from this job. Other machine activity
was not controlled. No retries, skips, relaxed assertions, API changes or line-cap raises
were added. Temporary instrumentation, including the interrupted job's WIP imports of
an ignored local tracing module, was removed before verification.

Three unchanged runs at each count were alternated:

| Workers | Run 1 (s) | Run 2 (s) | Run 3 (s) |
|---|---:|---:|---:|
| 4 | 128.22, pass | 132.62, fail | 120.04, fail |
| 6 | 117.94, fail | 130.51, fail | 111.97, pass |

Failure inventory, including subsequent instrumented runs:

| Group | Evidence / remaining question |
|---|---|
| Silent Git clone | Baseline four-worker `packages.test.ts`: `update leaves a package in a repository's subdirectory alone when only other parts changed`, clone exit 1 for `amira-packages-EcY5Dh/mono-exts`; reported output empty. A traced six-worker `git-cache.test.ts` cancellation/reinstall case captured **all** stderr: only `Cloning into bare repository '.../amira-git-cache-mNUTLZ/home/cache/git/acc5b0e8ab609dded62356d4.git.tmp-32192'...`, exit 1. Git Trace2 ends at starting upload-pack; no normal exit event. The command's own recorded tree kill followed its reported exit, not preceded it. Cause still unproved. |
| Git pack child | Another six-worker `git-cache.test.ts` case (`offline without a cache`) failed in clone for `amira-git-cache-kn2CdI/exts`: full captured stderr included `fatal: fetch-pack: invalid index-pack output`; clone exit 128. Upload-pack Trace2 records `pack-objects` PID 34936 exiting **66**, without a corresponding startup trace. Do not equate this truncated code with a particular Windows status or blame repository corruption/antivirus without evidence. |
| Standby timeout | `proc/standby.test.ts`, `the timeout counts from the release, not from the spawn`, failed twice in the six-worker baseline and in two traced runs. Child-side timestamps show prompt gate receipt, the 200 ms sleep completing in 201 ms, then `beforeExit`; Bun's exit fields were still null when the 1,200 ms release timer fired. A native sample already showed exit status 0, but that alone does not prove the process handle was signalled. Late shutdown versus late notification is unresolved. **12/12** fresh isolated repetitions passed. |
| Bash process lifecycle | Four-worker baseline: `abort kills background grandchildren with no survivors` found **0**, expected **3**, after its readiness budget. A later six-worker run also returned success before `sleep 30`'s timeout and reported `settled: true` for the deliberately surviving pipe-holder case. Native sampling saw the long sleep / pipe holder exit 1; the reason for their early termination remains unknown. |
| Context measurement | One instrumented six-worker run timed out `context management shrinks a long session's requests and keeps them consistent` at 5,375.94 ms against 5,000 ms. Did not recur in the subsequent repeats; no deadline change or causal conclusion from this one load-sensitive observation. |
| Earlier EPERM, fetch and resume-picker failures | Direct Git spawn EPERM, the earlier fetch-only failure, and resume-picker exit 1 did **not** recur. Clone failures are not proof that all earlier symptoms share a cause. |

Fixture inspection found unique `mkdtemp` roots and copied, not shared, mutable Git
repositories. Package Git strips repository-location environment variables. No captured
Git error named `index.lock`, `packed-refs.lock`, rename/unlink EPERM or a conflicting
fixture path. This narrows the search; it does not establish cross-file safety.

A concrete unresolved lifecycle risk: the lost-worker case in `proc/pipe.test.ts` kills
its child by PID, but `trackUntilExit` retains that PID after a worker-error event. A later
`killLivePipes()` submits it to `taskkill /T /F` again. A silent clone failure overlapped
that later call; **PID reuse / a cross-kill was not demonstrated**. The next focused probe
should establish process identity across worker loss and cleanup, not add Git retries.

Instrumentation progression (diagnostic times, **not** an optimized before/after):

- Five-file native subset, four workers: **93.65, 92.22, 88.46 s**, all green. A fourth
  run interrupted by the proxy disconnect is excluded.
- Full six-worker lifecycle/stream + Git Trace2: **143.76 fail, 179.40 fail, 149.62 pass**.
- With a read-only native process sampler: **108.94 pass, 131.74 pass, 113.34 fail**;
  a subsequent series was **111.66 fail, 114.48 fail, 111.15 pass**.
- Retaining query handles from spawn until Bun's exit callback: four workers **134.70,
  137.68 s**, six workers **119.52, 113.00 s**, all green. Retained handles affect PID reuse
  and timing: these passes are **not** a fix or grounds to raise the default.

Full logs, JUnit reports, raw stream/lifecycle logs and Git Trace2 are retained locally in
`node_modules/.cache/test-parallel-followup/` (ignored). Its native sampler records observed
process instances, not a complete kernel event trace; very short-lived children can be
missed. WMI process-stop tracing was denied access. No processes were killed by image name.
The timing seed is unchanged: instrumented durations are not comparable scheduling data.

Final uninstrumented verification at **three workers**, one round, no reruns:

| Command | Wall seconds | Result |
|---|---:|---|
| Typecheck | 1.03 | Pass |
| Biome on the three TS files restored from WIP tracing | 0.28 | Pass |
| Architecture check | 8.02 | Pass |
| `bun run check` #1 | 159.91 | Pass; tests 150.28 s |
| `bun run check` #2 | 161.84 | Pass; tests 152.19 s |
| `bun run check` #3 | 161.16 | Pass; tests 151.46 s |

Each full check: **3,112 pass, 14 existing skips, 0 failures, 275 files**. All three
checks meet 180 s on this run. There is **no implementation speedup to attribute**:
these are fresh measurements of the unchanged three-worker configuration, versus the
previous job's 208.54–215.68 s. They do not qualify four/six workers. After verification,
only this Markdown record was updated with results; all diagnostic jobs were stopped.

## Previous parallel-safety follow-up

Measured on the same Windows machine with Bun 1.4.2, without overlapping suite benchmarks.
The original test-speed job's measurements and reasons for retaining serial runs are
preserved below. This follow-up changes only test timing/fixtures and scripts: no
production code, public exports, API version or line caps changed; no assertions were
weakened and no skips were added.
There are no retries or global timeout increases, and no separate serial group is needed
for the selected three-worker configuration.

### Reproduction and failure groups

Three unchanged runs at each worker count were alternated before editing:

| Command | Run 1 (s) | Run 2 (s) | Run 3 (s) |
|---|---:|---:|---:|
| `bun test --parallel=4` | 155.22, fail | 156.06, pass | 153.74, pass |
| `bun test --parallel=6` | 145.69, fail | 138.44, fail | 149.94, fail |

Every failing test from those runs is listed here. Deadlines belong to the integration
tests, not the commands being tested; the latter's timeout assertions remain unchanged.

| Group / test | Error and cause | Change |
|---|---|---|
| CLI `session-management`: `amira sessions rm refuses a session leased by another process` | 5,000 ms timeout. A diagnostic launcher measured the first real Windows `process.kill(pid, 0)` at 3.84–3.93 s; replacing only that probe reduced the child from 3.98–4.18 s to 0.15–0.17 s. | Keep the real foreign-process probe and CLI, with a documented 15 s test budget. No stub in the shipped test. |
| Package `git-cache-regressions`: `cache regression: old git fallback blocks legacy promisors even when a transport is allowed` | 5,000 ms timeout across real Git init/config/tree subprocesses. Fixture paths are unique; this is not a shared template or network request. | 30 s for this real-Git case only. Mock-only cases keep their old deadlines. |
| Builtin `shell`: `a gated command does not run when stdin closes without a line` | 5,000 ms timeout. Direct MSYS startup plus the intentional 1.5 s gate observation exceeded it; successful focused runs took 7.88–10.63 s. | The same 30 s budget as its sibling gate integration tests. The gate observation and exit/marker assertions remain. |
| TUI `file-picker`: `outside a repository the files are walked, skipping .git and node_modules`; `in a repository git lists the files, leaving out what .gitignore ignores` | 5,000 ms timeouts. Even the walk first awaits native Git. The former does two listings; the latter also initializes a repository. | 40 s and 30 s respectively, allowing the existing 15 s listing deadlines plus native startup. Pure picker/search tests are unchanged. |
| Core `git`: `deprecated gitInfo still probes git standalone, without any provider` | 30,000 ms timeout. Four probes launch fourteen Git commands plus init. | 60 s for the multi-process scenario; command deadlines and all Git assertions unchanged. |
| Secondary cleanup errors | File-picker `afterAll`: `EBUSY ... rm amira-files-*`; shell unhandled assertion: expected 125, received 143. Timed-out work was still active during cleanup; Bun killed a dangling child before its assertion resumed. | Allow the actual subprocess waits above to finish; do not retry cleanup/assertions or accept a killed exit code. |

The unchanged serial baseline also failed `packages/proc/test/jobs.test.ts`:
`ended jobs are forgotten oldest end first; one that just ended is kept for its waiters`
expected `"exited"`, received `undefined`. It reproduced **10/20** times in a focused
81 ms run. The fake jobs could all end in the same millisecond, whereas the test expected
distinct chronological end times. The test now sets those times explicitly with a
scoped/restored `Date.now` spy; **100/100** repetitions passed. Production tie-breaking is
unchanged; this test covers ordering by distinct end timestamps, not a new tie policy.

A focused five-file native run reproduced the lease and gate timeouts. After the changes,
three fresh runs passed **74/74** tests each in **22.18, 19.32, 19.36 s**. No evidence of
cross-file path/port collisions, shared session leases or a shared background-job registry
was found with per-file VM isolation enabled.

### Higher-concurrency stress: not the selected configuration

A subsequent full six-worker run passed in **137.97 s**, but later stress runs were not
all green. These are not claimed fixed by choosing three workers:

- `packages/cli/test/resume.test.ts`: `slash resume picker with Ctrl+C leaves sessions
  unchanged` returned **code 1, empty stderr** once (156.68 s full run). The cause is still
  unconfirmed. It did not recur in **280 focused repetitions**, including six simultaneous
  runners, or the next two full six-worker runs. The assertion now includes captured stdout
  for diagnosis, without accepting another exit code.
- `packages/core/test/trace.test.ts`: `process.exit emergency hook saves delivered records
  without an async flush` exceeded its **10 s** deadline twice (11.77–12.45 s), followed by
  an unhandled expected-0/received-143 assertion after Bun killed the child. It must run
  a real subprocess; its documented test budget is now **30 s**, without changing the
  emergency-flush assertions.
- The later six-worker runs took **149.76 s** and **148.84 s**. The latter also failed
  `extensions/commands/test/ext.test.ts`'s `/ext local file git install, reinstall, update,
  disable, enable and remove use the core` with **`EPERM ... uv_spawn 'git'`**, and
  `packages/packages/test/git-cache.test.ts`'s `the first install makes a blobless cache
  of the repository; an update fetches into it` with **`PackageError: cannot download
  file:///...: Cloning into bare repository ...`**. Their causes remain unconfirmed;
  do not promote six workers based on its best timing. No retries were added.

A seeded **four-worker** release check also failed (165.96 s):
`packages/packages/test/packages.test.ts`'s `update follows the index when a package moved
to another directory of its repository` received `git fetch failed (exit 1)` instead of
a successful update. The unexplained native failures are therefore **not specific to six
workers**. Four was rejected as the default, rather than rerun until three checks passed.

Temporary process-tree tracing across three focused four-file native runs found no
cross-worker kills among the tracked processes, but did not reproduce the Git failure;
it does not establish or rule out its cause. All production instrumentation was removed.
Those runs did reproduce another test assumption twice:
`extensions/builtin-tools/test/jobs.test.ts`'s `SIGPIPE-only background pipelines succeed
and other pipeline failures fail` received `starting`/null exit code (or `isError: false`
for an unfinished failing pipeline). A background start is only observed for 1.5 s;
it does not promise completion. The test now awaits `job_output`'s bounded completion
signal before asserting the **same** final success/failure status and exit codes. It
passed in the subsequent full-suite diagnostic run; no startup-window assertion was
removed from the separate tests that cover that behavior.

### Scheduling

Four workers without timing hints passed two complete checks in **188.07 s** and
**186.89 s**, but missed the three-minute target; a third check was interrupted
by an environment disconnect and is not counted. The known long native files starting late
leave workers idle near the end. `scripts/test-timings.json` seeds Bun's built-in scheduler
with rounded millisecond estimates for the twelve longest files from the successful
four-worker JUnit profile. This changes order only, not discovery or concurrency. Unlisted
and newly added tests still run. The first seeded full-suite trial passed in **146.45 s**.

The seed is deliberately small and read-only in normal runs (no `--update-timings` in the
scripts). If the slow files change, profile to a local cache as below, then update the
seed deliberately. Keep three workers and per-file isolation; timing hints do not make
four/six workers qualified or make intra-file concurrent tests safe. The three-worker
trial passed in **214.01 s**. The under-three-minute target is not met by that run;
reliability takes precedence over the faster, failing higher-concurrency configurations.

### Follow-up timings

The suite contains 3,112 tests in 275 files (3,098 pass and 14 pre-existing skips on a
successful run). Wall times use a monotonic stopwatch, including command startup.

| Command | Before (s) | After (s) | Result |
|---|---:|---:|---|
| Bare serial `bun test` | 394.21 | 404.50 (intermediate) | Before failed the fake-clock case; after the deadline/clock fixes passed. This measurement predates the pipeline-wait fix. The bare command remains serial. |
| Test phase inside `check` (Bun-reported time) | 392.50, serial | 191.61–197.50, parallel | Successful before/after suite measurements. |
| `bun test --parallel=4` (no seed) | 153.74–156.06 | 154.03 | Before failed 1/3; after passed. |
| Four workers, seeded order | — | 146.45 | Trial passed, but the later release check failed; not retained. |
| `bun run test` (three workers, seeded order) | — | 214.01 | Full-suite trial passed; target not met. |
| `bun run check` | 402.50 | 208.54–215.68 | Three consecutive final runs passed; median 210.91 s, about 48% faster. |

Final verification on the unchanged three-worker script, with no retries:

| Command | Wall seconds | Result |
|---|---:|---|
| Typecheck | 2.56 | Passed |
| Biome on changed TS/JSON files | 0.44 | Passed; no fixes applied |
| Architecture check | 14.42 | Passed |
| `bun run check` #1 | 210.91 | Passed; test phase 197.47 s |
| `bun run check` #2 | 215.68 | Passed; test phase 197.50 s |
| `bun run check` #3 | 208.54 | Passed; test phase 191.61 s |

Each final check includes all 275 test files: **3,098 pass, 14 existing skips, 0 failures**.
After the gate, only this Markdown record was updated with its measurements. Validation
is for Windows/Bun 1.4.2, not a claim of unlimited-concurrency safety or a cross-platform
performance guarantee. Remaining work is to diagnose the native failures at four/six
workers and reach the three-minute target without hiding them.

Raw reproduction logs, JUnit timings and diagnostic output are retained locally under
`node_modules/.cache/test-parallel/` (ignored, not part of the repository). To reproduce,
alternate three fresh `bun test --parallel=4` / `bun test --parallel=6` commands, without
other test runs in flight; do not infer reliability from the fastest run alone.

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

## Previous test-speed measurements

The remainder of this document records the preceding serial optimization job, before the
parallel-safety follow-up above.

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

The under-three-minute target remains unmet. One exploratory four-worker check
finished in 153.22 s, but repeat runs failed. Both per-file VM isolation and registry
reuse were tried; six workers were also unreliable. No parallel configuration is
retained, and the underlying native-process failures remain undiagnosed.

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

# Tests

Run `bun run check` for architecture, types, lint and the full test suite. With Bun 1.4.2,
`bun run test` runs four process workers (`bun test --parallel=4 --no-isolate`). Each
worker reuses its module registry, like bare serial `bun test`, rather than resetting the
VM between files. Tests within a worker remain serial: many fixtures deliberately change
process-local environment, clocks or mocks and must restore them. Homes and fixture
repositories are separate across workers. Four workers bound the load from the real Git,
shell and process-tree integration tests; no retries or tests are disabled to obtain
parallelism. Six workers proved unreliable under Windows process-startup load.

For a focused test, use `bun test <path>`. Bare `bun test` remains the serial diagnostic
run. Use a 600,000 ms command timeout for full runs, especially on Windows.

## Timing a run

Bun 1.4.2 records both file wall times and individual test durations without a separate
process per file:

```sh
mkdir -p node_modules/.cache/test-speed
bun test --timings=node_modules/.cache/test-speed/files.json --update-timings \
  --reporter=junit --reporter-outfile=node_modules/.cache/test-speed/tests.xml
```

The JSON's `files` map contains milliseconds. JUnit `testcase` times are seconds.
Add `--parallel=4 --no-isolate` to measure the configured parallel suite. Measure serial runs for
before/after file comparisons; parallel file times include competition for machine
resources. Avoid running other benchmarks or test invocations at the same time.

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

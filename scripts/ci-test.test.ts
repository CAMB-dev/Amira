import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { annotations, inspectRun, parseJUnit, runCiTests, type TestRun, warning } from "./ci-test"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnWork } from "./spawn-test"

// Bun 1.4.2 --parallel=3: file suites contain recursive describe suites; their
// counters include descendants. Failures are children, not attributes of testcase.
const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="1" failures="2" skipped="1" time="0.4">
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" failures="2" skipped="1">
    <testsuite name="outer &amp; &lt;one&gt;" file="a.test.ts" tests="3" failures="2" skipped="1">
      <testcase name="first &#10; %" classname="outer" file="a.test.ts"><failure message="oops">Error: oops&#10;</failure></testcase>
      <testsuite name="inner" file="a.test.ts" tests="1" failures="1" skipped="0">
        <testcase name="second &quot; &apos; &#x1F600;" classname="inner &gt; outer" file="a.test.ts"><failure>bad</failure></testcase>
      </testsuite>
      <testcase name="skip" file="a.test.ts"><skipped message="TODO" /></testcase>
    </testsuite>
  </testsuite>
  <testsuite name="b.test.ts" file="b.test.ts" tests="1" failures="0" skipped="0">
    <testcase name="ok" file="b.test.ts" />
  </testsuite>
</testsuites>`

function single(file = "a.test.ts", fail = true): string {
  return `<testsuites name="bun test" tests="1" failures="${+fail}" skipped="0">
    <testsuite name="${file}" file="${file}" tests="1" failures="${+fail}" skipped="0">
      <testcase name="case" file="${file}">${fail ? '<failure message="oops">oops</failure>' : ""}</testcase>
    </testsuite>
  </testsuites>`
}

function result(xml = single(), exitCode = 1, files = 1): TestRun {
  const parsed = parseJUnit(xml)
  return {
    exitCode,
    signalCode: null,
    output: `\n ${parsed.tests - parsed.failures.length - parsed.skipped} pass\n ${parsed.skipped ? `${parsed.skipped} skip\n ` : ""}${parsed.failures.length} fail\nRan ${parsed.tests} tests across ${files} files. [10.00ms]\n${exitCode === 1 ? 'error: script "test" exited with code 1\n' : ""}`,
  }
}

test("parses real parallel Bun nested suites, multiple files, entities and full test names", () => {
  const parsed = parseJUnit(report)
  expect(parsed.tests).toBe(4)
  expect(parsed.files).toEqual(["a.test.ts", "b.test.ts"])
  expect(parsed.failures).toEqual([
    { file: "a.test.ts", name: "outer & <one> > first \n %", status: "fail" },
    { file: "a.test.ts", name: "outer & <one> > inner > second \" ' 😀", status: "fail" },
  ])
})

test("parses Bun's GitHub Actions suite metadata without counting it as tests", () => {
  const xml = single().replace(
    "<testcase",
    '<properties><property name="ci" value="https://github.com/fixture/repo/actions/runs/123" /><property name="commit" value="0123456789" /></properties><testcase',
  )
  expect(parseJUnit(xml).failures).toEqual(parseJUnit(single()).failures)
})

test("CI runs static checks once before the retry script and retains the shared annotation log", async () => {
  const source = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(source) as {
    jobs: { check: { steps: { name?: string; run?: string; if?: string; env?: Record<string, string> }[] } }
  }
  const check = workflow.jobs.check.steps.find((step) => step.name === "Run checks and tests")!
  expect(check.run).toContain("set -o pipefail")
  expect(check.run).toContain(
    '(bun run architecture:check && bun run typecheck && bun run lint && bun scripts/ci-test.ts) 2>&1 | tee "$RUNNER_TEMP/check.log"',
  )
  const annotations = workflow.jobs.check.steps.find((step) => step.name === "Annotate check failures")!
  expect(annotations.if).toBe("failure() || cancelled()")
  expect(annotations.run).toContain('log="$RUNNER_TEMP/check.log"')
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, not JavaScript.
  expect(check.env?.CI_TEST_SUMMARY_FILE).toBe("${{ runner.temp }}/ci-test-summary.txt")
  expect(annotations.run).toContain(
    'bun scripts/ci-test.ts --annotate "$log" "$RUNNER_TEMP/ci-test-summary.txt"',
  )
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(pkg.scripts.check).toBe(
    "bun run architecture:check && bun run typecheck && bun run lint && bun run test",
  )
  expect(pkg.scripts.test).toBe("bun test --parallel=3 --timings=scripts/test-timings.json")
})

test("annotations share nine lines, with persisted summary before deduplicated failures and tail", () => {
  const log = [
    "error: old diagnostic",
    "(fail) first [1.00ms]",
    "(fail) first [2.00ms]",
    "(fail) second [3.00ms]",
    ...Array.from({ length: 15 }, (_, index) => `tail ${index}%`),
  ].join("\n")
  const lines = annotations(log, "CI test retry summary: failed\n")
  expect(lines).toHaveLength(9)
  expect(lines.slice(0, 3)).toEqual([
    "::error title=bun run check::CI test retry summary: failed",
    "::error title=bun run check::(fail) first",
    "::error title=bun run check::(fail) second",
  ])
  expect(lines.slice(3)).toEqual(
    Array.from({ length: 6 }, (_, index) => `::error title=bun run check::tail ${index + 9}%25`),
  )
  expect(
    annotations(Array.from({ length: 20 }, (_, i) => `(fail) test ${i}`).join("\n"), "summary"),
  ).toHaveLength(9)
  const crowded = annotations(
    `${Array.from({ length: 20 }, (_, i) => `(fail) test ${i}`).join("\n")}\nworker timed out`,
    "summary",
  )
  expect(crowded).toHaveLength(9)
  expect(crowded.at(-1)).toBe("::error title=bun run check::worker timed out")
  expect(annotations("one\ntwo\n", "")).toEqual([
    "::error title=bun run check::retry skipped: no summary (checks failed before tests or run interrupted)",
    "::error title=bun run check::one",
    "::error title=bun run check::two",
  ])
})

test("file-attributed unhandled errors with complete reports qualify for retry", () => {
  const xml = single("a.test.ts", false)
  const normal = result(xml, 0)
  const output = `\na.test.ts:\n# Unhandled error between tests\n${normal.output.replace("0 fail\n", "0 fail\n 1 error\n")}`
  expect(inspectRun({ exitCode: 1, signalCode: null, output }, xml).errorFiles).toEqual(["a.test.ts"])
  expect(
    inspectRun(
      { exitCode: 1, signalCode: null, output: output.replace("a.test.ts:", "::group::a.test.ts:") },
      xml,
    ).errorFiles,
  ).toEqual(["a.test.ts"])
  for (const invalid of [
    output.replace("a.test.ts:", "missing.test.ts:"),
    output.replace("1 error", "2 errors"),
    output.replace("# Unhandled error between tests\n", ""),
    output.replace("# Unhandled", "::endgroup::\n# Unhandled"),
  ])
    expect(() => inspectRun({ exitCode: 1, signalCode: null, output: invalid }, xml)).toThrow()
})

test("diagnostic labels do not erase an unhandled error's reported file", () => {
  const xml = single("a.test.ts", false)
  const normal = result(xml, 0)
  const output = `a.test.ts:\nCleanup:\n# Unhandled error between tests\nerror: first:\n# Unhandled error between tests\n${normal.output.replace("0 fail\n", "0 fail\n 2 errors\n")}`
  expect(inspectRun({ exitCode: 1, signalCode: null, output }, xml).errorFiles).toEqual(["a.test.ts"])
})

test("a crash with file-attributed JUnit failures is retryable even without a human summary", () => {
  for (const name of ["case", "(unnamed)", "(worker crashed)"]) {
    const xml = single().replace('name="case"', `name="${name}"`)
    const run = { exitCode: 134, signalCode: "SIGABRT", output: "panic: worker teardown\n" }
    expect(inspectRun(run, xml).failures[0]?.file).toBe("a.test.ts")
    expect(() => inspectRun(run, single("a.test.ts", false))).toThrow()
    expect(() => inspectRun(run, xml.slice(0, -5))).toThrow()
  }
})

for (const name of ["(unnamed)", "(worker crashed)"])
  test(`retries a file when synthetic failure ${name} disappears on recovery`, async () => {
    let calls = 0
    const messages: string[] = []
    const initial = single().replace('name="case"', `name="${name}"`)
    expect(
      await runCiTests({
        summaryFile: null,
        emit: (line) => messages.push(line),
        run: async (command) => {
          const xml = calls++ === 0 ? initial : single("a.test.ts", false)
          writeFileSync(command.at(-1)!.slice("--reporter-outfile=".length), xml)
          return calls === 1 ? { exitCode: 134, signalCode: null, output: "worker crashed:" } : result(xml, 0)
        },
      }),
    ).toBe(0)
    expect(calls).toBe(2)
  })

test("mock retry runs cannot overwrite the enclosing CI summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amira-ci-summary-isolation-"))
  const file = join(dir, "summary.txt")
  const previous = process.env.CI_TEST_SUMMARY_FILE
  try {
    writeFileSync(file, "real run in progress")
    process.env.CI_TEST_SUMMARY_FILE = file
    await runCiTests({
      summaryFile: null,
      emit: () => {},
      run: async (command) => {
        const xml = single("a.test.ts", false)
        writeFileSync(command.at(-1)!.slice("--reporter-outfile=".length), xml)
        return result(xml, 0)
      },
    })
    expect(readFileSync(file, "utf8")).toBe("real run in progress")
  } finally {
    if (previous === undefined) delete process.env.CI_TEST_SUMMARY_FILE
    else process.env.CI_TEST_SUMMARY_FILE = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test("persists the final retry summary separately from the streaming log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amira-ci-summary-"))
  const summaryFile = join(dir, "summary.txt")
  try {
    let calls = 0
    expect(
      await runCiTests({
        summaryFile,
        emit: () => {},
        run: async (command) => {
          calls++
          writeFileSync(command.at(-1)!.slice("--reporter-outfile=".length), single())
          return result()
        },
      }),
    ).toBe(1)
    expect(calls).toBe(2)
    expect(readFileSync(summaryFile, "utf8")).toContain("CI test retry summary: failed after retry")
    expect(
      await runCiTests({
        summaryFile,
        emit: () => {},
        run: async () => {
          throw new Error("fixture unusable report")
        },
      }),
    ).toBe(1)
    expect(readFileSync(summaryFile, "utf8")).toContain("retry refused: fixture unusable report")
    expect(readFileSync(summaryFile, "utf8")).not.toContain("failed after retry")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("escapes workflow command data after XML decoding", () => {
  expect(warning({ file: "a%\r\n.test.ts", name: "x\n::error::oops%", status: "fail" })).toBe(
    "::warning title=flaky test::a%25%0D%0A.test.ts — x%0A::error::oops%25",
  )
})

for (const [name, xml] of Object.entries({
  missing: "",
  truncated: report.slice(0, -12),
  trailing: `${report}<extra />`,
  mismatched: report.replace("</testcase>", "</testsuite>"),
  counters: report.replace('tests="4"', 'tests="5"'),
  nestedCounters: report.replace('tests="3"', 'tests="2"'),
  failures: report.replace('failures="2"', 'failures="0"'),
  unknownEntity: report.replace("&amp;", "&unknown;"),
  invalidRawCharacter: single().replace('name="case"', 'name="ca\u0000se"'),
  invalidNumericCharacter: single().replace('name="case"', 'name="&#0;"'),
  invalidUnicodeCharacter: single().replace('name="case"', 'name="&#xFFFF;"'),
  loneSurrogate: single().replace('name="case"', 'name="\ud800"'),
  duplicateAttribute: report.replace('tests="4"', 'tests="4" tests="4"'),
  errorNode: report.replace("<failure message=", "<error message="),
  errorCounter: report.replace('name="bun test"', 'name="bun test" errors="1"'),
  foreignFile: single().replace('name="case" file="a.test.ts"', 'name="case" file="else.test.ts"'),
  unsafeFile: single("../outside.test.ts"),
  absoluteFile: single("C:\\outside.test.ts"),
  metadataWithoutValue: single().replace(
    "<testcase",
    '<properties><property name="ci" /></properties><testcase',
  ),
  metadataWithChildren: single().replace(
    "<testcase",
    '<properties><property name="ci" value="url"><skipped /></property></properties><testcase',
  ),
  metadataOutsideSuite: single().replace("<testsuite name=", "<properties /><testsuite name="),
})) {
  test(`fails closed on ${name} JUnit`, () => {
    expect(() => parseJUnit(xml)).toThrow()
  })
}

test("only completed runs with matching test, failure and skip counts qualify", () => {
  expect(inspectRun(result(report, 1, 2), report).failures).toHaveLength(2)
  expect(inspectRun(result(single("a.test.ts", false), 0), single("a.test.ts", false)).failures).toEqual([])
  // Bun counts empty test files in the human summary but omits their suites.
  expect(inspectRun(result(single(), 1, 2), single()).files).toEqual(["a.test.ts"])
  const normal = result()
  for (const run of [
    { ...normal, exitCode: 0 },
    { ...normal, output: "crash before report" },
    { ...normal, output: normal.output.replace("1 fail", "2 fail\n 1 error") },
    { ...normal, output: `# Unhandled error between tests\n${normal.output}` },
    { ...normal, output: normal.output.replace("1 tests", "2 tests") },
    { ...normal, output: normal.output.replace("0 pass", "1 pass") },
    { ...normal, output: normal.output.replace("1 files", "0 files") },
  ])
    expect(() => inspectRun(run, single())).toThrow()
})

test("accepts Bun 1.4.2 passing, failed, mixed and added snapshot statistics", () => {
  for (const stats of [
    " 1 snapshots, 1 expect() calls\n",
    "snapshots: 1 failed\n 1 expect() calls\n",
    "snapshots: 1 passed, 1 failed\n 2 expect() calls\n",
    "snapshots: +1 added\n 1 expect() calls\n",
    "snapshots: 1 passed, 1 failed, +1 added\n 3 expect() calls\n",
  ]) {
    const normal = result()
    expect(
      inspectRun({ ...normal, output: normal.output.replace("Ran ", `${stats}Ran `) }, single()).tests,
    ).toBe(1)
  }
})

test("validates stderr's summary even if stdout drains later, but still checks stdout for crashes", () => {
  const normal = result()
  const run = { ...normal, stderr: normal.output, output: `${normal.output}late stdout\n` }
  expect(inspectRun(run, single()).failures).toHaveLength(1)
  expect(inspectRun({ ...run, output: `${run.output}panic: late stdout crash\n` }, single()).crashed).toBe(
    true,
  )
})

for (const stillFails of [false, true])
  test(`orchestrates each failed file once; some still fail: ${stillFails}`, async () => {
    const calls: string[][] = []
    const messages: string[] = []
    const initial = single()
      .replace(
        "</testsuites>",
        `${single("b.test.ts").match(/<testsuite name=[\s\S]*<\/testsuite>/)![0]}</testsuites>`,
      )
      .replace('tests="1" failures="1" skipped="0"', 'tests="2" failures="2" skipped="0"')
    const code = await runCiTests({
      summaryFile: null,
      emit: (line) => messages.push(line),
      run: async (command) => {
        calls.push(command)
        const xml =
          calls.length === 1
            ? initial
            : single(calls.length === 2 ? "a.test.ts" : "b.test.ts", stillFails && calls.length === 2)
        writeFileSync(
          command.find((arg) => arg.startsWith("--reporter-outfile="))!.slice("--reporter-outfile=".length),
          xml,
        )
        return result(
          xml,
          calls.length === 1 || (stillFails && calls.length === 2) ? 1 : 0,
          calls.length === 1 ? 2 : 1,
        )
      },
    })
    expect(code).toBe(stillFails ? 1 : 0)
    expect(calls.map((call) => call.slice(1, 3))).toEqual([
      ["run", "test"],
      ["test", "./a.test.ts"],
      ["test", "./b.test.ts"],
    ])
    expect(calls.every((call) => call.includes("--reporter=junit"))).toBe(true)
    expect(new Set(calls.map((call) => call.at(-1))).size).toBe(3)
    expect(messages.filter((line) => line.startsWith("::warning title=flaky test::"))).toEqual(
      stillFails
        ? []
        : ["::warning title=flaky test::a.test.ts — case", "::warning title=flaky test::b.test.ts — case"],
    )
  })

test("caps recovered-run annotations at nine, with retry summary first", async () => {
  const failed = single()
    .replaceAll('tests="1" failures="1"', 'tests="12" failures="12"')
    .replace(
      /<testcase[\s\S]*<\/testcase>/,
      Array.from(
        { length: 12 },
        (_, i) => `<testcase name="case ${i}" file="a.test.ts"><failure>oops</failure></testcase>`,
      ).join(""),
    )
  let calls = 0
  const messages: string[] = []
  expect(
    await runCiTests({
      summaryFile: null,
      emit: (line) => messages.push(line),
      run: async (command) => {
        const xml =
          calls++ === 0
            ? failed
            : failed.replaceAll('failures="12"', 'failures="0"').replaceAll("<failure>oops</failure>", "")
        writeFileSync(command.at(-1)!.slice("--reporter-outfile=".length), xml)
        return result(xml, calls === 1 ? 1 : 0)
      },
    }),
  ).toBe(0)
  const commands = messages.filter((line) => line.startsWith("::"))
  expect(commands).toHaveLength(9)
  expect(commands[0]).toBe("::warning title=CI test retry::retry: 1 file passed on retry")
})

test("deduplicates failed files but emits a warning for every original failed test", async () => {
  let calls = 0
  const messages: string[] = []
  const retry = report
    .replace(/ {2}<testsuite name="b.test.ts"[\s\S]*?<\/testsuite>/, "")
    .replace('tests="4"', 'tests="3"')
    .replace(/failures="\d+"/g, 'failures="0"')
    .replace(/<failure[^>]*>[\s\S]*?<\/failure>/g, "")
  const code = await runCiTests({
    summaryFile: null,
    emit: (line) => messages.push(line),
    run: async (command) => {
      const xml = calls++ === 0 ? report : retry
      writeFileSync(command.at(-1)!.slice("--reporter-outfile=".length), xml)
      return result(xml, calls === 1 ? 1 : 0, calls === 1 ? 2 : 1)
    },
  })
  expect(code).toBe(0)
  expect(calls).toBe(2)
  expect(messages.filter((line) => line.startsWith("::warning title=flaky test::"))).toEqual(
    parseJUnit(report).failures.map(warning),
  )
})

for (const scenario of [
  "all pass",
  "still fails",
  "no report",
  "malformed",
  "crash",
  "retry crash",
  "skip on retry",
  "spawn error",
]) {
  test(`retry decision: ${scenario}`, async () => {
    let calls = 0
    const messages: string[] = []
    const code = await runCiTests({
      summaryFile: null,
      emit: (line) => messages.push(line),
      run: async (command) => {
        calls++
        if (scenario === "spawn error") throw new Error("spawn ENOENT")
        let xml = single("a.test.ts", scenario !== "all pass" && (calls === 1 || scenario === "still fails"))
        if (scenario === "skip on retry" && calls === 2)
          xml = xml.replace("</testcase>", "<skipped /></testcase>").replaceAll('skipped="0"', 'skipped="1"')
        const path = command
          .find((arg) => arg.startsWith("--reporter-outfile="))!
          .slice("--reporter-outfile=".length)
        if (scenario !== "no report") writeFileSync(path, scenario === "malformed" ? xml.slice(0, -5) : xml)
        const run = result(xml, xml.includes("<failure") ? 1 : 0)
        if (scenario === "crash" || (scenario === "retry crash" && calls === 2)) run.exitCode = 134
        return run
      },
    })
    expect(code).toBe(scenario === "all pass" ? 0 : 1)
    expect(calls).toBe(["still fails", "crash", "retry crash", "skip on retry"].includes(scenario) ? 2 : 1)
    expect(messages.some((line) => line.startsWith("::warning"))).toBe(false)
  })
}

for (const scenario of [
  "flake",
  "persistent",
  "import error",
  "early exit",
  "hook",
  "snapshot pass",
  "snapshot flake",
  "large stdout",
  "unhandled flake",
  "unhandled persistent",
])
  test(
    `real isolated processes preserve preload/env/output and fail closed: ${scenario}`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "amira-ci-test-"))
      const recovered = ["flake", "snapshot flake", "large stdout", "unhandled flake"].includes(scenario)
      let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ scripts: { test: "bun test --parallel=3" } }),
        )
        writeFileSync(join(dir, "bunfig.toml"), '[test]\npreload = ["./preload.ts"]\n')
        writeFileSync(join(dir, "preload.ts"), 'process.env.FIXTURE_PRELOADED = "yes"\n')
        writeFileSync(join(dir, ".env"), "FIXTURE_DOTENV=loaded\n")
        writeFileSync(
          join(dir, "a.test.ts"),
          `import {test,expect,afterAll} from "bun:test";
        import {existsSync,writeFileSync,appendFileSync} from "node:fs";
        ${scenario === "hook" ? 'afterAll(()=>{throw new Error("hook failure")})' : ""}
        ${scenario.startsWith("unhandled") ? `afterAll(()=>{const retry=existsSync("once");writeFileSync("once","1");if (!retry || ${scenario === "unhandled persistent"}) Promise.reject(new Error("unhandled fixture"))})` : ""}
        test("flake",()=>{
          appendFileSync("runs", "a")
          console.log("fixture human output")
          ${scenario === "large stdout" ? 'for (let i = 0; i < 64; i++) process.stdout.write("x".repeat(8192)); process.stdout.write("\\nfixture stdout complete\\n")' : ""}
          expect(process.env.FIXTURE_PRELOADED).toBe("yes")
          expect(process.env.FIXTURE_DOTENV).toBe("loaded")
          expect(process.env.HOME).toBe(${JSON.stringify(dir)})
          ${scenario === "early exit" ? "process.exit(1)" : ""}
          const retry=existsSync("once")
          ${scenario.startsWith("unhandled") ? "" : 'writeFileSync("once", "1")'}
          ${
            scenario.startsWith("snapshot")
              ? `expect("ok").toMatchInlineSnapshot('"ok"'); ${scenario === "snapshot flake" ? 'expect(retry ? "ok" : "bad").toMatchInlineSnapshot(\'"ok"\')' : ""}`
              : scenario.startsWith("unhandled")
                ? ""
                : `expect(retry && ${scenario !== "persistent"}).toBe(true)`
          }
        })`,
        )
        if (scenario === "import error") writeFileSync(join(dir, "c.test.ts"), 'import "./does-not-exist"')
        // Bun 1.4.2 can omit aggregate snapshot statistics with multiple parallel files.
        // Keep the snapshot fixtures single-file so both initial and retry formats are observed.
        if (!scenario.startsWith("snapshot"))
          writeFileSync(
            join(dir, "b.test.ts"),
            'import {describe,test} from "bun:test";import {appendFileSync} from "node:fs";describe("suite",()=>test("passes",()=>appendFileSync("runs", "b")))',
          )
        child = Bun.spawn([process.execPath, fileURLToPath(new URL("./ci-test.ts", import.meta.url))], {
          cwd: dir,
          windowsHide: true,
          stdin: "ignore",
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: dir,
            USERPROFILE: dir,
            TEMP: dir,
            TMP: dir,
            CI: "true",
            CI_TEST_SUMMARY_FILE: join(dir, "summary.txt"),
            GITHUB_ACTIONS: "true",
            GITHUB_REPOSITORY: "fixture/repo",
            GITHUB_RUN_ID: "123",
            GITHUB_SHA: "0123456789012345678901234567890123456789",
            GITHUB_SERVER_URL: "https://github.com",
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, code] = await waitForSpawnWork(
          `CI retry fixture: ${scenario}`,
          Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
        )
        expect(code, stdout + stderr).toBe(recovered || scenario === "snapshot pass" ? 0 : 1)
        const summary = readFileSync(join(dir, "summary.txt"), "utf8")
        expect(summary).toStartWith("CI test retry summary: ")
        expect(summary.trim().split("\n")).toHaveLength(1)
        if (recovered) expect(summary).toContain("passed after retry; a.test.ts: passed")
        if (scenario === "unhandled persistent")
          expect(summary).toContain("failed after retry; a.test.ts: failed")
        if (scenario === "import error") expect(summary).toContain("retry refused:")
        expect(stdout + stderr).toContain("fixture human output")
        if (scenario === "large stdout") expect(stdout + stderr).toContain("fixture stdout complete")
        if (scenario === "snapshot pass") expect(stdout + stderr).toContain("1 snapshots, 4 expect() calls")
        if (scenario === "snapshot flake") expect(stdout + stderr).toContain("snapshots: 1 passed, 1 failed")
        if (scenario.startsWith("unhandled"))
          expect(stdout + stderr).toContain("# Unhandled error between tests")
        if (recovered)
          expect(stdout + stderr).toContain(
            `::warning title=flaky test::a.test.ts — ${scenario.startsWith("unhandled") ? "unhandled error between tests" : "flake"}`,
          )
        else expect(stdout + stderr).not.toContain("::warning title=flaky test::")
        const runs = readFileSync(join(dir, "runs"), "utf8")
        expect([...runs].filter((char) => char === "a")).toHaveLength(
          recovered || ["persistent", "unhandled persistent", "hook", "early exit"].includes(scenario)
            ? 2
            : 1,
        )
        if (scenario !== "early exit")
          expect([...runs].filter((char) => char === "b")).toHaveLength(
            scenario.startsWith("snapshot") ? 0 : 1,
          )
      } finally {
        try {
          if (child) await stopSpawn(child, `CI retry fixture cleanup: ${scenario}`)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  SPAWN_TEST_TIMEOUT_MS,
  SPAWN_WAIT_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnExit,
  waitForSpawnWork,
} from "./spawn-test.ts"

const root = path.resolve(import.meta.dir, "..")
const python = [Bun.which("python3"), Bun.which("python")].find(
  (candidate) =>
    candidate &&
    Bun.spawnSync([candidate, "-c", "import sys; sys.exit(sys.version_info < (3, 8))"], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: SPAWN_WAIT_TIMEOUT_MS,
    }).exitCode === 0,
)
if (!python)
  console.warn("Skipping release-policy probes: no working Python 3.8+ found (tried python3 and python).")
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amira-release-policy-"))
  temporary.push(directory)
  return directory
}

function embeddedPython(script: string) {
  const match = /python3 - <<'PY'\n([\s\S]*?)\nPY/.exec(script)
  if (!match) throw new Error("Missing workflow Python block")
  return match[1]!
}

async function execute(
  script: string,
  directory: string,
  env: Record<string, string> = {},
  inheritedEnv: NodeJS.ProcessEnv = process.env,
) {
  const runner = path.join(directory, "runner.py")
  await writeFile(runner, script)
  // Windows treats environment names case-insensitively; avoid duplicate PythonPath/PYTHONPATH entries.
  const inherited = Object.fromEntries(
    Object.entries(inheritedEnv).filter(
      ([key]) => !["PYTHONPATH", "PYTHONDONTWRITEBYTECODE"].includes(key.toUpperCase()),
    ),
  )
  const child = Bun.spawn([python!, runner], {
    cwd: directory,
    env: { ...inherited, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [stdout, stderr, code] = await waitForSpawnWork(
      "child output",
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        waitForSpawnExit(child, "release policy"),
      ]),
    )
    if (code) throw new Error(stderr)
    return stdout
  } finally {
    await stopSpawn(child)
  }
}

async function workflow(name: string) {
  return Bun.YAML.parse(await Bun.file(path.join(root, `.github/workflows/${name}.yml`)).text()) as {
    jobs: Record<string, { steps: { run?: string }[] }>
  }
}

test.skipIf(!python)(
  "release-policy probes override inherited PythonPath regardless of Windows environment casing",
  async () => {
    const directory = await fixture()
    const result = await execute(
      "from scripts.release_policy import next_nightly_tag\nprint(next_nightly_tag('1.2.3', '20261015', []))\n",
      directory,
      {},
      {
        ...process.env,
        PythonPath: path.join(directory, "unrelated-imports"),
      },
    )
    expect(result.trim()).toBe("v1.2.3-nightly.20261015")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.skipIf(!python)(
  "RC source versions produce canonical nightlies recognized by discovery and retention",
  async () => {
    const directory = await fixture()
    await mkdir(path.join(directory, "packages/cli"), { recursive: true })
    await writeFile(path.join(directory, "packages/cli/package.json"), '{"version":"1.2.3-rc.1"}')
    const releases = [
      { tag_name: "v1.2.3-nightly.20261014", prerelease: true, draft: false, published_at: "2026-10-14" },
    ]
    await writeFile(path.join(directory, "releases.json"), JSON.stringify([releases]))
    const nightly = await workflow("nightly")
    const plan = nightly.jobs.plan!.steps.find((step) => step.run?.includes("GITHUB_OUTPUT"))!.run!
    const script = embeddedPython(plan)
    const runner = `import datetime, subprocess\nclass FixedDatetime(datetime.datetime):\n    @classmethod\n    def now(cls, tz=None):\n        return cls(2026, 10, 15, tzinfo=tz)\ndatetime.datetime = FixedDatetime\ndef git(args, **kwargs):\n    if args[1:3] == ['rev-parse', 'HEAD']: return 'a' * 40\n    if args[1:3] == ['tag', '--list']: return 'v1.2.3-nightly.20261015.2'\n    if args[1] == 'rev-list': return 'changed'\n    raise AssertionError(args)\nsubprocess.check_output = git\nexec(${JSON.stringify(script)})\n`
    const output = path.join(directory, "output")
    await execute(runner, directory, { RUNNER_TEMP: directory, GITHUB_OUTPUT: output })
    const planned = Object.fromEntries(
      (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.trim().split("=")),
    )
    expect(planned.tag).toBe("v1.2.3-nightly.20261015.3")
    expect(planned.previous).toBe("v1.2.3-nightly.20261014")

    const retained = Array.from({ length: 16 }, (_, i) => ({
      tag_name: i === 0 ? planned.tag : `v1.2.3-nightly.20261014.${i}`,
      prerelease: true,
      draft: false,
      published_at: `2026-10-${String(30 - i).padStart(2, "0")}`,
    }))
    const ignored = [
      { tag_name: "v1.2.3-rc.1", prerelease: true, draft: false, published_at: "2026-10-31" },
      { tag_name: "v1.2.3", prerelease: false, draft: false, published_at: "2026-10-31" },
      { tag_name: "v1.2.3-nightly.20261031", prerelease: true, draft: true, published_at: "2026-10-31" },
    ]
    await writeFile(path.join(directory, "releases.json"), JSON.stringify([[...retained, ...ignored]]))
    const prune =
      nightly.jobs.publish!.steps.find(
        (step) => step.run?.includes("Keep the newest") || step.run?.includes("nightlies[14:]"),
      )?.run ?? nightly.jobs.publish!.steps.at(-1)!.run!
    const removed = await execute(
      `import json, subprocess\nactions = []\nsubprocess.run = lambda args, **kwargs: actions.append(args)\nexec(${JSON.stringify(embeddedPython(prune))})\nprint(json.dumps(actions))\n`,
      directory,
      { RUNNER_TEMP: directory },
    )
    expect(JSON.parse(removed).map((args: string[]) => args[3])).toEqual(
      retained.slice(14).map((release) => release.tag_name),
    )
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.skipIf(!python)(
  "nightly CI gate accepts only the latest successful push run for the selected main SHA",
  async () => {
    const directory = await fixture()
    const nightly = await workflow("nightly")
    const gate = embeddedPython(
      nightly.jobs.ci!.steps.find((step) => step.run?.includes("ci-runs.json"))!.run!,
    )
    const run = {
      head_sha: "a".repeat(40),
      head_branch: "main",
      event: "push",
      run_number: 10,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
    }
    const cases = [
      { name: "missing", runs: [], success: false },
      { name: "success", runs: [run], success: true },
      ...["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required"].map((conclusion) => ({
        name: conclusion,
        runs: [{ ...run, conclusion }],
        success: false,
      })),
      ...["queued", "in_progress", "waiting"].map((status) => ({
        name: status,
        runs: [{ ...run, status, conclusion: null }],
        success: false,
      })),
      { name: "wrong SHA", runs: [{ ...run, head_sha: "b".repeat(40) }], success: false },
      { name: "wrong branch", runs: [{ ...run, head_branch: "feature" }], success: false },
      { name: "PR run", runs: [{ ...run, event: "pull_request" }], success: false },
      {
        name: "newer failure overrides older success across pages",
        runs: [{ ...run, run_number: 11, conclusion: "failure" }, run],
        success: false,
      },
      {
        name: "pending rerun overrides success",
        runs: [run, { ...run, run_attempt: 2, status: "queued", conclusion: null }],
        success: false,
      },
      {
        name: "successful rerun overrides failure",
        runs: [
          { ...run, conclusion: "failure" },
          { ...run, run_attempt: 2 },
        ],
        success: true,
      },
    ]
    const output = path.join(directory, "output")
    for (const entry of cases) {
      await writeFile(output, "")
      await writeFile(
        path.join(directory, "ci-runs.json"),
        JSON.stringify([{ workflow_runs: entry.runs.slice(0, 1) }, { workflow_runs: entry.runs.slice(1) }]),
      )
      const stdout = await execute(gate, directory, {
        SHA: run.head_sha,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
      })
      expect({ name: entry.name, output: (await readFile(output, "utf8")).trim() }).toEqual({
        name: entry.name,
        output: `success=${entry.success}`,
      })
      expect(stdout.includes("::notice::Skipping nightly")).toBe(!entry.success)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

async function publishProbe(commits: string[]) {
  const directory = await fixture()
  await mkdir(path.join(directory, "dist"))
  await writeFile(path.join(directory, "releases.json"), "[[]]")
  const release = await workflow("release")
  const publish = release.jobs.publish!.steps.find((step) => step.run?.includes("if published:"))!.run!
  const result = await execute(
    `import json, subprocess\nactions = []\ncommits = ${JSON.stringify(commits)}\ndef fetch(args, **kwargs):\n    if args[:2] != ['gh', 'api']: raise AssertionError(args)\n    commit = commits.pop(0) if len(commits) > 1 else commits[0]\n    return json.dumps({'object': {'type': 'commit', 'sha': commit}})\nsubprocess.check_output = fetch\nsubprocess.run = lambda args, **kwargs: actions.append(args)\nerror = None\ntry:\n    exec(${JSON.stringify(embeddedPython(publish))})\nexcept Exception as exception:\n    error = str(exception)\nprint(json.dumps({'actions': actions, 'error': error}))\n`,
    directory,
    {
      RUNNER_TEMP: directory,
      GITHUB_REPOSITORY: "owner/repo",
      TAG: "v1.2.3",
      SHA: "a".repeat(40),
      CHANNEL: "stable",
    },
  )
  return JSON.parse(result) as { actions: string[][]; error: string | null }
}

test.skipIf(!python)(
  "remote tag verification peels lightweight, annotated and nested annotated tags",
  async () => {
    const directory = await fixture()
    const result = await execute(
      `from scripts.release_policy import verify_tag_commit\nimport json\ncommit = 'a' * 40\nannotated = 'b' * 40\nnested = 'c' * 40\nref = 'repos/owner/repo/git/ref/tags/v1.2.3'\nresults = []\nfor chain in [[], [annotated], [annotated, nested]]:\n    calls = []\n    responses = {ref: {'object': {'type': 'tag' if chain else 'commit', 'sha': chain[0] if chain else commit}}}\n    for i, sha in enumerate(chain):\n        following = chain[i + 1:]\n        responses['repos/owner/repo/git/tags/' + sha] = {'object': {'type': 'tag' if following else 'commit', 'sha': following[0] if following else commit}}\n    def fetch(endpoint):\n        calls.append(endpoint)\n        return responses[endpoint]\n    results.append({'sha': verify_tag_commit('owner/repo', 'v1.2.3', commit, fetch), 'calls': len(calls)})\nprint(json.dumps(results))\n`,
      directory,
    )
    expect(JSON.parse(result)).toEqual([
      { sha: "a".repeat(40), calls: 1 },
      { sha: "a".repeat(40), calls: 2 },
      { sha: "a".repeat(40), calls: 3 },
    ])
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.skipIf(!python)(
  "remote tag verification fails closed on non-commits, malformed hashes and cycles",
  async () => {
    const directory = await fixture()
    const result = await execute(
      `from scripts.release_policy import verify_tag_commit\nimport json\nerrors = []\nfor value in [{'type': 'tree', 'sha': 'a' * 40}, {'type': 'tag', 'sha': '../bad'}, {'type': 'tag', 'sha': 'b' * 40}]:\n    try:\n        verify_tag_commit('owner/repo', 'v1.2.3', 'a' * 40, lambda endpoint: {'object': value})\n        raise AssertionError('unexpected success')\n    except ValueError as error:\n        errors.append(str(error))\nprint(json.dumps(errors))\n`,
      directory,
    )
    const errors: string[] = JSON.parse(result)
    expect(errors).toHaveLength(3)
    expect(errors[0]).toContain("does not match planned commit")
    expect(errors[1]).toContain("Invalid or cyclic")
    expect(errors[2]).toContain("Invalid or cyclic")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.skipIf(!python)(
  "stable and RC nightly sources share suffix selection and the canonical namespace",
  async () => {
    const directory = await fixture()
    const result = await execute(
      `from scripts.release_policy import next_nightly_tag\nimport json\noccupied = ['v1.2.3-nightly.20261015', 'v1.2.3-nightly.20261015.4', 'v1.2.3-nightly.20261015.2']\nprint(json.dumps([next_nightly_tag(version, '20261015', occupied) for version in ['1.2.3', '1.2.3-rc.1', '1.2.3-rc.9']]))\n`,
      directory,
    )
    expect(JSON.parse(result)).toEqual(Array(3).fill("v1.2.3-nightly.20261015.5"))
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.skipIf(!python)(
  "a moved remote tag aborts before draft creation",
  async () => {
    const result = await publishProbe(["b".repeat(40)])
    expect(result.error).toContain("does not match planned commit")
    expect(result.actions.some((args) => args.includes("create"))).toBe(false)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.skipIf(!python)(
  "a matching remote tag permits draft creation and one publication",
  async () => {
    const result = await publishProbe(["a".repeat(40)])
    expect(result.error).toBeNull()
    expect(result.actions.filter((args) => args.includes("create"))).toHaveLength(1)
    expect(result.actions.filter((args) => args.includes("--draft=false"))).toHaveLength(1)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.skipIf(!python)(
  "a tag moved after upload aborts before immutable publication",
  async () => {
    const result = await publishProbe(["a".repeat(40), "b".repeat(40)])
    expect(result.actions.some((args) => args.includes("create"))).toBe(true)
    expect(result.error).toContain("does not match planned commit")
    expect(result.actions.some((args) => args.includes("--draft=false"))).toBe(false)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

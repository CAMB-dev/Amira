import { afterAll, afterEach, expect, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ExtensionAPI, RunCommandResult } from "@amira/api"
import { runExtensionCommand } from "../../../packages/core/src/extensions.ts"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnExit } from "../../../scripts/spawn-test.ts"
import { spawnWorkScope } from "../../builtin-tools/test/util.ts"
import { gitWorkspaceProvider, gitInfo as probeInfo } from "../src/workspace.ts"

const work = spawnWorkScope("workspace git probes cleanup")
const runWorkspaceCommand: typeof runExtensionCommand = (argv, options) =>
  work.run((signal) => runExtensionCommand(argv, { ...options, signal }), options.signal)
const api = { runCommand: runWorkspaceCommand }
afterEach(() => work.cleanup(), SPAWN_TEST_TIMEOUT_MS)
const gitInfo = (cwd: string, timeoutMs?: number, opts?: { dirty?: boolean }) =>
  probeInfo(api, cwd, timeoutMs, opts)

// git is slow to start on Windows, especially under load.

const dirs: string[] = []
async function tempDir() {
  const d = await mkdtemp(path.join(os.tmpdir(), "amira-git-"))
  dirs.push(d)
  return d
}
afterAll(async () => {
  await work.cleanup()
  for (const d of dirs) await rm(d, { recursive: true, force: true })
}, SPAWN_TEST_TIMEOUT_MS)

async function run(cwd: string, ...args: string[]) {
  const p = work.own(Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }))
  try {
    expect(await waitForSpawnExit(p, `git ${args.join(" ")}`)).toBe(0)
  } finally {
    await stopSpawn(p, "git fixture cleanup")
  }
}

async function repo(): Promise<string> {
  const d = await tempDir()
  await run(d, "init", "-q", "-b", "trunk")
  await run(
    d,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  )
  return d
}

test(
  "a repository with commits reports root, branch and head with native separators",
  async () => {
    const d = await repo()
    const info = await gitInfo(d)
    expect(info.repoRoot).toBe(path.normalize(await import("node:fs/promises").then((fs) => fs.realpath(d))))
    expect(info.branch).toBe("trunk")
    expect(info.head).toMatch(/^[0-9a-f]{4,}$/)
    expect(info.isWorktree).toBe(false)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a repository reached through a directory link is not a linked worktree",
  async () => {
    const d = await repo()
    const link = path.join(await tempDir(), "repo")
    symlinkSync(d, link, process.platform === "win32" ? "junction" : "dir")
    expect(await gitInfo(link)).toMatchObject({ branch: "trunk", isWorktree: false })
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a repository without commits still reports root and branch",
  async () => {
    const d = await tempDir()
    await run(d, "init", "-q", "-b", "fresh")
    const info = await gitInfo(d)
    expect(info.repoRoot).toBeTruthy()
    expect(info.branch).toBe("fresh")
    expect(info.head).toBeUndefined()
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "detached HEAD omits branch but keeps head; linked worktrees are detected",
  async () => {
    const d = await repo()
    await run(d, "checkout", "-q", "--detach")
    const detached = await gitInfo(d)
    expect(detached.branch).toBeUndefined()
    expect(detached.head).toBeTruthy()

    const wt = path.join(await tempDir(), "wt")
    await run(d, "worktree", "add", "-q", "-b", "side", wt)
    const info = await gitInfo(wt)
    expect(info.isWorktree).toBe(true)
    expect(info.branch).toBe("side")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a directory outside any repository reports nothing",
  async () => {
    const d = await tempDir()
    // GIT_CEILING_DIRECTORIES keeps git from finding a repository above the temp dir.
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(d)
    try {
      expect(await gitInfo(d)).toEqual({})
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "gitInfo says whether the working tree has changes when asked",
  async () => {
    const d = await repo()
    expect((await gitInfo(d)).dirty).toBeUndefined()
    expect((await gitInfo(d, 15_000, { dirty: true })).dirty).toBe(false)
    await writeFile(path.join(d, "new.txt"), "x")
    expect((await gitInfo(d, 15_000, { dirty: true })).dirty).toBe(true)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "the provider detects repository appearance and disappearance without spawning for stamps",
  async () => {
    const cwd = await tempDir()
    const provider = gitWorkspaceProvider(api)
    const signal = new AbortController().signal
    expect(await provider.probe(cwd, signal)).toEqual({ cwd })
    const absent = provider.stamp!(cwd)
    await run(cwd, "init", "-q", "-b", "later")
    expect(provider.stamp!(cwd)).not.toBe(absent)
    expect(await provider.probe(cwd, signal)).toMatchObject({ cwd, branch: "later" })
    await rm(path.join(cwd, ".git"), { recursive: true })
    expect(provider.stamp!(cwd)).toBe(absent)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "fingerprints include HEAD, branch refs, packed refs and the index",
  async () => {
    const cwd = await repo()
    const provider = gitWorkspaceProvider(api)
    await provider.probe(cwd, new AbortController().signal)
    let previous = provider.stamp!(cwd)
    for (const name of ["HEAD", "refs/heads/trunk", "packed-refs", "index"]) {
      const file = path.join(cwd, ".git", name)
      if (!(await stat(file).catch(() => undefined))) await writeFile(file, "")
      await utimes(file, new Date(), new Date(Date.now() + 10_000))
      const next = provider.stamp!(cwd)
      expect(next).not.toBe(previous)
      previous = next
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "linked worktrees fingerprint their shared branch ref and detect later commits",
  async () => {
    const cwd = await repo()
    const wt = path.join(await tempDir(), "wt")
    await run(cwd, "worktree", "add", "-q", "-b", "side", wt)
    const provider = gitWorkspaceProvider(api)
    const signal = new AbortController().signal
    const before = await provider.probe(wt, signal)
    const stamp = provider.stamp!(wt)
    await run(
      wt,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "next",
    )
    expect(provider.stamp!(wt)).not.toBe(stamp)
    const after = await provider.probe(wt, signal)
    expect(after!.head).not.toBe(before!.head)
    expect(after!.isWorktree).toBe(true)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "dirty probes report untracked, staged and unstaged files without rewriting the index",
  async () => {
    const cwd = await repo()
    const provider = gitWorkspaceProvider(api)
    const signal = new AbortController().signal
    expect((await provider.probe(cwd, signal))!.dirty).toBe(false)
    await writeFile(path.join(cwd, "new.txt"), "one")
    expect((await provider.probe(cwd, signal, "dirty"))!.dirty).toBe(true)
    await run(cwd, "add", "new.txt")
    const index = path.join(cwd, ".git", "index")
    const before = await readFile(index)
    const mtime = (await stat(index)).mtimeMs
    expect((await provider.probe(cwd, signal, "dirty"))!.dirty).toBe(true)
    await writeFile(path.join(cwd, "new.txt"), "two")
    expect((await provider.probe(cwd, signal, "dirty"))!.dirty).toBe(true)
    expect(await readFile(index)).toEqual(before)
    expect((await stat(index)).mtimeMs).toBe(mtime)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("missing metadata paths keep probes best-effort and path comparisons respect the platform", async () => {
  const cwd = await tempDir()
  const gitDir = path.join(cwd, ".git")
  let commonDir = gitDir
  const runCommand: ExtensionAPI["runCommand"] = async (argv) => ({
    output: argv[2] === "--show-toplevel" ? [cwd, gitDir, commonDir].join("\n") : "",
    exitCode: 0,
    truncated: false,
    signalCode: null,
    timedOut: false,
    aborted: false,
    settled: true,
    contained: true,
  })
  expect((await probeInfo({ runCommand }, cwd)).isWorktree).toBe(false)
  commonDir = gitDir.toUpperCase()
  expect((await probeInfo({ runCommand }, cwd)).isWorktree).toBe(process.platform !== "win32")
  commonDir = path.join(cwd, "shared.git")
  expect((await probeInfo({ runCommand }, cwd)).isWorktree).toBe(true)
})

test("probes use the host runner with timeout, cancellation, stdout-only and Windows viaCmd", async () => {
  const calls: { argv: string[]; options: Parameters<ExtensionAPI["runCommand"]>[1] }[] = []
  let failStatus = false
  const runCommand: ExtensionAPI["runCommand"] = async (argv, options) => {
    calls.push({ argv, options })
    if (argv[1] === "status" && failStatus) throw new Error("git unavailable")
    const output =
      argv[1] === "symbolic-ref"
        ? "main"
        : argv[2] === "--short"
          ? "abcdef"
          : argv[1] === "status"
            ? ""
            : "/work\n/work/.git\n/work/.git"
    return { output, exitCode: 0 } as RunCommandResult
  }
  const provider = gitWorkspaceProvider({ runCommand })
  const abort = new AbortController()
  expect(await provider.probe("/work", abort.signal)).toMatchObject({
    branch: "main",
    head: "abcdef",
    dirty: false,
  })
  expect(calls).toHaveLength(4)
  for (const { options } of calls) {
    expect(options).toMatchObject({
      cwd: "/work",
      signal: abort.signal,
      timeoutMs: 15_000,
      viaCmd: true,
      stdoutOnly: true,
    })
  }
  expect(calls.find((c) => c.argv[1] === "status")!.options.env!.GIT_OPTIONAL_LOCKS).toBe("0")
  calls.length = 0
  failStatus = true
  const failed = await provider.probe("/work", abort.signal, "dirty")
  expect(failed!.branch).toBe("main")
  expect(failed!.dirty).toBeUndefined()
  expect(calls.map((c) => c.argv)).toEqual([
    ["git", "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty"],
  ])
  abort.abort()
  expect(await provider.probe("/work", abort.signal)).toBeUndefined()
})

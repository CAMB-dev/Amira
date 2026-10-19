import { afterAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import * as proc from "@amira/proc"
import { SPAWN_TEST_TIMEOUT_MS, SPAWN_WAIT_TIMEOUT_MS } from "../../../scripts/spawn-test.ts"
import { type ListOptions, listProjectFiles, streamProjectFiles } from "../src/project-files.ts"

const tmp = mkdtempSync(path.join(os.tmpdir(), "amira-project-files-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }), SPAWN_TEST_TIMEOUT_MS)

function tree(name: string, files: string[]): string {
  const root = path.join(tmp, name)
  mkdirSync(root, { recursive: true })
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), "")
  }
  return root
}

async function listing(root: string, opts: ListOptions = {}) {
  const files: string[] = []
  const complete = await streamProjectFiles(root, (paths) => files.push(...paths), opts)
  return { files, complete }
}

test(
  "a walk uses relative slash paths and skips .git and node_modules at every depth",
  async () => {
    const root = tree("walk", [
      "b.ts",
      "a/x.ts",
      "a/deep/file with spaces.ts",
      "node_modules/m/i.js",
      "a/node_modules/y.js",
      "a/.git/config",
    ])
    expect(await listing(root)).toEqual({
      files: ["b.ts", "a/x.ts", "a/deep/file with spaces.ts"],
      complete: true,
    })
    expect(await listProjectFiles(root)).toEqual(["b.ts", "a/x.ts", "a/deep/file with spaces.ts"])
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a walk reports a cap as incomplete, including when all files are in one directory",
  async () => {
    const root = tree("walk-cap", ["a.ts", "b.ts"])
    expect(await listing(root, { limit: 1 })).toEqual({ files: ["a.ts"], complete: false })
    expect(await listing(root, { limit: 2 })).toEqual({ files: ["a.ts", "b.ts"], complete: true })
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("an already cancelled listing emits nothing and is incomplete", async () => {
  const root = tree("cancelled", ["a.ts"])
  expect(await listing(root, { signal: AbortSignal.abort() })).toEqual({ files: [], complete: false })
})

test("an expired listing emits nothing and is incomplete", async () => {
  const root = tree("expired", ["a.ts"])
  expect(await listing(root, { timeoutMs: 0 })).toEqual({ files: [], complete: false })
})

test(
  "cancelling during a walk keeps emitted paths but reports an incomplete listing",
  async () => {
    const root = tree("walk-cancel", ["a.ts", "dir/b.ts"])
    const abort = new AbortController()
    const files: string[] = []
    const complete = await streamProjectFiles(
      root,
      (paths) => {
        files.push(...paths)
        abort.abort()
      },
      { signal: abort.signal },
    )
    expect({ files, complete }).toEqual({ files: ["a.ts"], complete: false })
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("failed or timed out git output stays partial instead of mixing in a walk", async () => {
  const root = tree("partial-git", ["fallback.ts"])
  const result: proc.RunResult = {
    output: "",
    truncated: false,
    exitCode: 1,
    signalCode: null,
    timedOut: false,
    aborted: false,
    settled: true,
    contained: true,
  }
  const run = spyOn(proc, "runCommand")
  try {
    run.mockImplementation(async (_argv, opts) => {
      opts.onChunk?.("known.ts\0unfinished")
      return result
    })
    expect(await listing(root)).toEqual({ files: ["known.ts"], complete: false })
    run.mockResolvedValue({ ...result, timedOut: true })
    expect(await listing(root)).toEqual({ files: [], complete: false })
    run.mockResolvedValue({ ...result, aborted: true })
    expect(await listing(root)).toEqual({ files: [], complete: false })
  } finally {
    run.mockRestore()
  }
})

test("git paths span chunks, and collected listings deduplicate conflict stages", async () => {
  const run = spyOn(proc, "runCommand").mockImplementation(async (_argv, opts) => {
    opts.onChunk?.("src/a")
    opts.onChunk?.(".ts\0src/a.ts\0notes with spaces.md\0nested/\0")
    return {
      output: "",
      truncated: false,
      exitCode: 0,
      signalCode: null,
      timedOut: false,
      aborted: false,
      settled: true,
      contained: true,
    }
  })
  try {
    expect(await listProjectFiles(tmp)).toEqual(["src/a.ts", "notes with spaces.md", "nested/"])
  } finally {
    run.mockRestore()
  }
})

test(
  "an unreadable root is incomplete rather than an empty complete listing",
  async () => {
    expect(await listing(path.join(tmp, "missing"))).toEqual({ files: [], complete: false })
  },
  SPAWN_TEST_TIMEOUT_MS,
)

const hasGit = Bun.which("git") !== null

test.skipIf(!hasGit)(
  "git lists tracked and untracked paths, respects ignores, and reports caps accurately",
  async () => {
    const root = tree("git", [".gitignore", "src/app.ts", "notes with spaces.md", "dist/out.js"])
    writeFileSync(path.join(root, ".gitignore"), "dist/\n")
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root, timeout: SPAWN_WAIT_TIMEOUT_MS })
    expect(init.exitCode).toBe(0)
    const add = Bun.spawnSync(["git", "add", "src/app.ts"], {
      cwd: root,
      timeout: SPAWN_WAIT_TIMEOUT_MS,
    })
    expect(add.exitCode).toBe(0)
    const all = await listing(root)
    expect(all.complete).toBe(true)
    expect(all.files.toSorted()).toEqual([".gitignore", "notes with spaces.md", "src/app.ts"])
    const capped = await listing(root, { limit: 1 })
    expect(capped.files).toHaveLength(1)
    expect(capped.complete).toBe(false)
    expect(await listing(root, { limit: 3 })).toEqual(all)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

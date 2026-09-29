import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCommand } from "@amira/proc"
import { hostGit } from "../src/index.ts"
import {
  APPLY_PARTIAL,
  createWorktree,
  DISCARD,
  KEEP,
  listKeptWorktrees,
  MERGE,
  mergeWorktree,
  parseNumstat,
  projectKey,
  type RunGit,
  STALE_NOTICE_MS,
  STALE_WORKTREE_MS,
  sweepWorktrees,
  type Worktree,
} from "../src/worktree.ts"

// git is slow to start on Windows, especially under load.
setDefaultTimeout(60_000)

const git = hostGit({ runCommand })
const dirs: string[] = []
async function tempDir(prefix: string) {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function run(cwd: string, ...args: string[]) {
  const r = await git(args, cwd)
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.output}`)
}

/** A repository with one commit holding f.txt (lines a..e) and src/g.txt, plus an Amira home. */
async function setup() {
  const root = await tempDir("amira-wt-repo-")
  const home = await tempDir("amira-wt-home-")
  await run(root, "init", "-q")
  writeFileSync(path.join(root, "f.txt"), "a\nb\nc\nd\ne\n")
  await Bun.write(path.join(root, "src", "g.txt"), "g\n")
  await run(root, "add", ".")
  const id = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
  await run(root, ...id, "commit", "-q", "-m", "init")
  return { root, home }
}

async function worktree(cwd: string, home: string): Promise<Worktree> {
  const wt = await createWorktree(git, { cwd, home, name: "child" })
  if ("error" in wt) throw new Error(wt.error)
  return wt
}

const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n")

test("a clean change merges back on its own and the worktree is removed", async () => {
  const { root, home } = await setup()
  const wt = await worktree(root, home)
  expect(path.dirname(wt.dir)).toBe(path.join(home, "worktrees", projectKey(root)))
  expect(read(path.join(wt.cwd, "f.txt"))).toBe("a\nb\nc\nd\ne\n")
  writeFileSync(path.join(wt.cwd, "f.txt"), "a\nB\nc\nd\ne\n")
  writeFileSync(path.join(wt.cwd, "new.txt"), "new\n")
  let reviewed = false
  const r = await mergeWorktree(git, wt, {
    review: async () => {
      reviewed = true
      return KEEP
    },
  })
  expect(r.outcome).toBe("merged")
  expect(reviewed).toBe(false)
  expect(r.stat).toEqual({ files: ["f.txt", "new.txt"], insertions: 2, deletions: 1 })
  expect(read(path.join(root, "f.txt"))).toBe("a\nB\nc\nd\ne\n")
  expect(read(path.join(root, "new.txt"))).toBe("new\n")
  expect(existsSync(wt.dir)).toBe(false)
  expect(existsSync(wt.patch)).toBe(false)
})

test("a worktree that cannot be removed still counts as merged, with a note", async () => {
  const { root, home } = await setup()
  const wt = await worktree(root, home)
  writeFileSync(path.join(wt.cwd, "f.txt"), "a\nB\nc\nd\ne\n")
  // As on Windows when a process still has the worktree as its working directory.
  const busy: RunGit = (args, cwd, stdoutOnly) =>
    args[0] === "worktree" && args[1] === "remove"
      ? Promise.resolve({ output: "error: failed to delete: Device or resource busy", ok: false })
      : git(args, cwd, stdoutOnly)
  const pruned: string[][] = []
  const r = await mergeWorktree(
    (args, cwd, stdoutOnly) => {
      if (args[1] === "prune") pruned.push(args)
      return busy(args, cwd, stdoutOnly)
    },
    wt,
    {
      rm: (target, opts) => {
        if (target === wt.dir) throw new Error("EBUSY: resource busy or locked")
        rmSync(target, opts)
      },
    },
  )
  expect(r.outcome).toBe("merged")
  expect(r.cleanup).toBe("EBUSY: resource busy or locked")
  expect(read(path.join(root, "f.txt"))).toBe("a\nB\nc\nd\ne\n")
  expect(pruned.length).toBe(1)
  expect(existsSync(wt.patch)).toBe(false)
})

test("the worktree starts from uncommitted changes and the child works in the same subdirectory", async () => {
  const { root, home } = await setup()
  writeFileSync(path.join(root, "f.txt"), "a\nb\nc\nd\nE\n")
  const wt = await worktree(path.join(root, "src"), home)
  expect(wt.cwd).toBe(path.join(wt.dir, "src"))
  expect(read(path.join(wt.dir, "f.txt"))).toBe("a\nb\nc\nd\nE\n")
  writeFileSync(path.join(wt.cwd, "g.txt"), "G\n")
  const r = await mergeWorktree(git, wt)
  expect(r.outcome).toBe("merged")
  expect(read(path.join(root, "src", "g.txt"))).toBe("G\n")
  // The parent's own uncommitted change is untouched.
  expect(read(path.join(root, "f.txt"))).toBe("a\nb\nc\nd\nE\n")
})

test("no changes: nothing to merge, the worktree is removed", async () => {
  const { root, home } = await setup()
  const wt = await worktree(root, home)
  const r = await mergeWorktree(git, wt)
  expect(r.outcome).toBe("empty")
  expect(existsSync(wt.dir)).toBe(false)
})

/** The child and the parent both change line b. */
async function conflicting() {
  const { root, home } = await setup()
  const wt = await worktree(root, home)
  writeFileSync(path.join(wt.cwd, "f.txt"), "a\nchild\nc\nd\ne\n")
  writeFileSync(path.join(wt.cwd, "other.txt"), "other\n")
  writeFileSync(path.join(root, "f.txt"), "a\nparent\nc\nd\ne\n")
  return { root, home, wt }
}

test("a conflict goes to review; keeping it leaves both sides untouched", async () => {
  const { root, wt } = await conflicting()
  const asked: { title: string; diff: string; options: string[] }[] = []
  const r = await mergeWorktree(git, wt, {
    who: `"Fix it" (coder)`,
    review: async (title, diff, options) => {
      asked.push({ title, diff, options })
      return KEEP
    },
  })
  expect(r.outcome).toBe("kept")
  expect(r.conflict).toBeTruthy()
  // The review names whose changes they are.
  expect(asked[0]?.title).toBe(
    `The changes of "Fix it" (coder) conflict with the working tree (2 files, +2 -1)`,
  )
  expect(asked[0]?.options).toEqual([APPLY_PARTIAL, KEEP, DISCARD])
  expect(asked[0]?.diff).toContain("+child")
  expect(read(path.join(root, "f.txt"))).toBe("a\nparent\nc\nd\ne\n")
  expect(existsSync(path.join(root, "other.txt"))).toBe(false)
  expect(existsSync(wt.dir)).toBe(true)
  expect(existsSync(wt.patch)).toBe(true)
})

test("nobody to review a conflict (print mode) keeps the worktree", async () => {
  const { wt } = await conflicting()
  const r = await mergeWorktree(git, wt, { review: async () => undefined })
  expect(r.outcome).toBe("kept")
  expect(existsSync(wt.dir)).toBe(true)
})

test("a conflict can be discarded, or applied as far as it fits with .rej files", async () => {
  const first = await conflicting()
  const discarded = await mergeWorktree(git, first.wt, { review: async () => DISCARD })
  expect(discarded.outcome).toBe("discarded")
  expect(existsSync(first.wt.dir)).toBe(false)

  const second = await conflicting()
  const partial = await mergeWorktree(git, second.wt, { review: async () => APPLY_PARTIAL })
  expect(partial.outcome).toBe("partial")
  expect(partial.rejected).toEqual(["f.txt"])
  expect(read(path.join(second.root, "other.txt"))).toBe("other\n")
  expect(read(path.join(second.root, "f.txt"))).toBe("a\nparent\nc\nd\ne\n")
  expect(readdirSync(second.root)).toContain("f.txt.rej")
})

test("a clean merge past the review threshold is reviewed first (D38)", async () => {
  const { root, home } = await setup()
  const wt = await worktree(root, home)
  writeFileSync(path.join(wt.cwd, "f.txt"), "1\n2\n3\n")
  const options: string[][] = []
  const r = await mergeWorktree(git, wt, {
    threshold: { lines: 4 },
    review: async (_t, _d, o) => {
      options.push(o)
      return MERGE
    },
  })
  expect(options).toEqual([[MERGE, KEEP, DISCARD]])
  expect(r.outcome).toBe("merged")
  expect(read(path.join(root, "f.txt"))).toBe("1\n2\n3\n")
})

test("the sweep announces worktrees left behind long ago, deletes them a day later, and keeps recent ones", async () => {
  const { root, home } = await setup()
  const old = await createWorktree(git, { cwd: root, home, name: "old" })
  const fresh = await createWorktree(git, { cwd: root, home, name: "fresh" })
  if ("error" in old || "error" in fresh) throw new Error("no worktree")
  writeFileSync(old.patch, "patch")
  const now = Date.now()
  const then = new Date(now - STALE_WORKTREE_MS - 60_000)
  utimesSync(old.dir, then, then)
  utimesSync(old.patch, then, then)
  expect(listKeptWorktrees(home, root).map((w) => w.name)).toEqual(["fresh", "old"])
  // First the user is told; nothing goes yet.
  const first = await sweepWorktrees(git, { root, home, now })
  expect(first.removed).toEqual([])
  expect(first.expiring.map((w) => [w.name, w.patch])).toEqual([["old", old.patch]])
  expect(existsSync(old.dir)).toBe(true)
  expect(listKeptWorktrees(home, root).find((w) => w.name === "old")?.expiring).toBe(true)
  // Told again? No: once is enough, and within a day nothing is deleted.
  expect(await sweepWorktrees(git, { root, home, now: now + 1000 })).toEqual({ removed: [], expiring: [] })
  const later = now + STALE_NOTICE_MS + 60_000
  expect(await sweepWorktrees(git, { root, home, now: later })).toEqual({ removed: ["old"], expiring: [] })
  expect(existsSync(old.dir)).toBe(false)
  expect(existsSync(old.patch)).toBe(false)
  expect(existsSync(fresh.dir)).toBe(true)
  const list = await git(["worktree", "list", "--porcelain"], root, true)
  expect(list.output).not.toContain("/old")
  expect(list.output).toContain("/fresh")
})

test("outside a repository there is no worktree", async () => {
  const plain = await tempDir("amira-wt-plain-")
  const r = await createWorktree(git, { cwd: plain, home: plain, name: "x" })
  expect(r).toEqual({ error: "not a git repository" })
})

test("numstat parsing counts binary files without lines", () => {
  expect(parseNumstat("1\t2\ta.txt\n-\t-\timg.png\n")).toEqual({
    files: ["a.txt", "img.png"],
    insertions: 1,
    deletions: 2,
  })
})

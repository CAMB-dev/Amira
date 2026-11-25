import { expect, test } from "bun:test"
import { mergeWorktree, type RunGit, type Worktree } from "../src/worktree.ts"

test("mergeWorktree serializes concurrent git apply operations targeting the same repository root", async () => {
  let activeApplies = 0
  let maxConcurrentApplies = 0
  const events: string[] = []

  const git: RunGit = async (args) => {
    const cmd = args[0]
    if (cmd === "add" || cmd === "diff") {
      if (args.includes("--numstat")) return { ok: true, output: "1\t0\ta.txt\n" }
      return { ok: true, output: "" }
    }
    if (cmd === "apply") {
      const check = args.includes("--check")
      const patch = args.at(-1)!
      events.push(`${check ? "check" : "apply"}:start:${patch}`)
      activeApplies++
      maxConcurrentApplies = Math.max(maxConcurrentApplies, activeApplies)
      await Bun.sleep(15)
      activeApplies--
      events.push(`${check ? "check" : "apply"}:end:${patch}`)
      return { ok: true, output: "" }
    }
    return { ok: true, output: "" }
  }

  const wt1: Worktree = {
    root: "/repo/shared",
    dir: "/tmp/wt1",
    cwd: "/tmp/wt1",
    base: "HEAD",
    patch: "wt1.diff",
  }
  const wt2: Worktree = {
    root: "/repo/shared",
    dir: "/tmp/wt2",
    cwd: "/tmp/wt2",
    base: "HEAD",
    patch: "wt2.diff",
  }
  const rm = () => {}

  const [r1, r2] = await Promise.all([mergeWorktree(git, wt1, { rm }), mergeWorktree(git, wt2, { rm })])

  expect(r1.outcome).toBe("merged")
  expect(r2.outcome).toBe("merged")
  expect(maxConcurrentApplies).toBe(1)
  // First merge completes both check and apply before the second begins check.
  expect(events.indexOf("apply:end:wt1.diff")).toBeLessThan(events.indexOf("check:start:wt2.diff"))
})

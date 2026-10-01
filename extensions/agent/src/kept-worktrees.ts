import path from "node:path"
import type { ExtensionAPI } from "@amira/api"
import type { KeptWorktreeInfo, KeptWorktrees } from "./agents-command.ts"
import {
  discardKept,
  extendKept,
  keptChanges,
  keptStat,
  listKeptWorktrees,
  mergeKept,
  type RunGit,
  STALE_WORKTREE_MS,
  type SweepResult,
} from "./worktree.ts"

export interface KeptWorktreesDeps {
  api: Pick<ExtensionAPI, "home" | "cwd">
  git: RunGit
  inUse: Set<string>
  serialized<T>(work: () => Promise<T>): Promise<T>
}

/** Tells the user what the sweep of old worktrees is about to delete, and what it deleted. */
export function sweepNotices(api: Pick<ExtensionAPI, "notify">): (sweep: SweepResult) => void {
  return (sweep) => {
    const days = Math.round(STALE_WORKTREE_MS / 86_400_000)
    if (sweep.expiring.length) {
      const n = sweep.expiring.length
      api.notify(
        `${n} sub-agent worktree${n === 1 ? "" : "s"} kept from earlier sessions ${n === 1 ? "is" : "are"} over ${days} days old and will be deleted from tomorrow on: ${sweep.expiring.map((w) => w.patch ?? w.dir).join(", ")}. /agents lists them to merge, keep or discard.`,
        "warning",
      )
    }
    if (sweep.removed.length) {
      const n = sweep.removed.length
      api.notify(
        `Deleted ${n} old sub-agent worktree${n === 1 ? "" : "s"} (announced a day or more ago): ${sweep.removed.join(", ")}.`,
      )
    }
  }
}

/** The repository of the working directory, which kept worktrees merge back into. */
export async function repoRoot(git: RunGit, cwd: string): Promise<string | undefined> {
  const top = await git(["rev-parse", "--show-toplevel"], cwd, true)
  return top.ok && top.output.trim() ? path.normalize(top.output.trim()) : undefined
}

export async function inRepo<T>(git: RunGit, cwd: string, work: (root: string) => Promise<T>): Promise<T> {
  const root = await repoRoot(git, cwd)
  if (!root) throw new Error("not in a git repository")
  return work(root)
}

/** The worktrees of this repository that sub-agents left behind (not the ones in use), for /agents. */
export function keptWorktrees(deps: KeptWorktreesDeps): KeptWorktrees {
  return {
    list: async () => {
      const root = await repoRoot(deps.git, deps.api.cwd)
      if (!root) return []
      const kept = listKeptWorktrees(deps.api.home, root).filter((w) => !deps.inUse.has(w.dir))
      // Sizes as last collected: collecting them all again would take long in a big repository.
      const out: KeptWorktreeInfo[] = []
      for (const w of kept) {
        const stat = await keptStat(deps.git, root, w).catch(() => undefined)
        out.push(stat ? { ...w, stat } : w)
      }
      return out
    },
    changes: (w) => inRepo(deps.git, deps.api.cwd, (root) => keptChanges(deps.git, root, w)),
    merge: (w) =>
      inRepo(deps.git, deps.api.cwd, (root) => deps.serialized(() => mergeKept(deps.git, root, w))),
    discard: (w) => inRepo(deps.git, deps.api.cwd, (root) => discardKept(deps.git, root, w)),
    keep: async (w) => ({ ...extendKept(w), ...(w.stat ? { stat: w.stat } : {}) }),
  }
}

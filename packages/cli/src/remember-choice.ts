import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { isNoModel } from "@amira/ai"
import type { SessionControl } from "@amira/api"
import { type Agent, amiraHome, projectAmiraDir, updateSettingsFile } from "@amira/core"

/** Only the interactive command surface gets this wrapper, never extensions or RPC. */
export function rememberingControl(
  control: SessionControl,
  agent: () => Agent,
  cwd: string,
  home = amiraHome(),
): SessionControl {
  const warn = (a: Agent, error: string) =>
    a.bus.emit("extension.error", { source: "settings", error }, { sessionId: a.sessionId })
  const save = () => {
    const a = agent()
    if (a.parentSessionId || a.depth > 0) return
    const files = [path.join(home, "settings.json")]
    const project = projectAmiraDir(cwd)
    // Settings are scoped to cwd, not the repository root. A bare non-repo directory has
    // no project to remember; an existing .amira directory also identifies a project.
    if (!samePath(cwd, os.homedir()) && !samePath(project, home)) {
      const repo = git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true"
      if (repo || hasGitDirectory(cwd)) {
        if (git(cwd, ["check-ignore", "-q", "--", ".amira/settings.local.json"]) !== undefined) {
          files.push(path.join(project, "settings.local.json"))
        } else {
          warn(
            a,
            `${project}: choice saved globally only; ignore .amira/settings.local.json and keep it untracked to remember this project`,
          )
        }
      } else if (existsSync(project)) files.push(path.join(project, "settings.local.json"))
    }
    const model = a.model
    const thinking = a.thinking.for(model) ?? "default"
    for (const file of files) {
      try {
        updateSettingsFile(
          file,
          (settings) => ({
            ...settings,
            ...(!isNoModel(model) ? { model: `${model.provider}/${model.id}` } : {}),
            thinking,
          }),
          { preserveFormatting: true },
        )
      } catch (err) {
        const why = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+\s*/g, " ")
        warn(a, `Choice not saved: ${why}`)
      }
    }
  }
  return {
    ...control,
    setModel: (ref) => {
      const before = agent().model
      control.setModel(ref)
      const after = agent().model
      if (before.provider !== after.provider || before.id !== after.id) save()
    },
    setThinking: (level) => {
      const a = agent()
      const before = a.thinking.for(a.model)
      control.setThinking(level)
      if (before !== level) save()
    },
  }
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const resolved = path.resolve(p)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normalize(a) === normalize(b)
}

/** Fail closed when a repo is present but Git is missing or its probe fails. */
function hasGitDirectory(cwd: string): boolean {
  let dir = path.resolve(cwd)
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** Read-only Git probes. Failure also covers a missing Git executable. */
function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      windowsHide: true,
    }).trim()
  } catch {
    return undefined
  }
}

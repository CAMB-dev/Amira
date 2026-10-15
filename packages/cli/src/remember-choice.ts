import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { isNoModel } from "@amira/ai"
import type { SessionControl, ShimmerEffect, TuiSettings } from "@amira/api"
import {
  type Agent,
  amiraHome,
  normalizeShimmer,
  projectAmiraDir,
  resolveShimmer,
  updateSettingsFile,
} from "@amira/core"

/** Only the interactive command surface gets this wrapper, never extensions or RPC. */
export function rememberingControl(
  control: SessionControl,
  agent: () => Agent,
  cwd: string,
  home = amiraHome(),
  probe = git,
): {
  control: SessionControl
  rememberTheme: (
    name: string,
    variant: NonNullable<TuiSettings["themeVariant"]>,
    shimmer?: ShimmerEffect,
  ) => void
  flush: () => Promise<void>
} {
  const warn = (a: Agent, error: string) =>
    a.bus.emit("extension.error", { source: "settings", error }, { sessionId: a.sessionId })
  const projects = new Map<string, Promise<string | undefined>>()
  let pending = Promise.resolve()
  const decideProject = async (a: Agent): Promise<string | undefined> => {
    const project = projectAmiraDir(cwd)
    if (samePath(cwd, os.homedir()) || samePath(project, home)) return undefined
    // Settings are scoped to cwd, not the repository root. A bare non-repo directory has
    // no project to remember; an existing .amira directory also identifies a project.
    const repo = (await probe(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true"
    if (repo || hasGitDirectory(cwd)) {
      if ((await probe(cwd, ["check-ignore", "-q", "--", ".amira/settings.local.json"])) === undefined) {
        warn(
          a,
          `${project}: choice saved globally only; ignore .amira/settings.local.json and keep it untracked to remember this project`,
        )
        return undefined
      }
      return path.join(project, "settings.local.json")
    }
    return existsSync(project) ? path.join(project, "settings.local.json") : undefined
  }
  const save = (
    theme?: {
      name: string
      variant: NonNullable<TuiSettings["themeVariant"]>
      shimmer: [ShimmerEffect?]
    },
    fastMode?: boolean,
  ) => {
    const a = agent()
    if (a.parentSessionId || a.depth > 0) return
    // Capture the choice now, not after a probe or another queued save finishes.
    const model = a.model
    const choice = {
      ...(!isNoModel(model) ? { model: `${model.provider}/${model.id}` } : {}),
      thinking: a.thinking.for(model) ?? "default",
      ...(fastMode !== undefined ? { fastMode } : {}),
    }
    const write = (file: string) => {
      try {
        updateSettingsFile(
          file,
          (settings) => {
            if (theme === undefined) return { ...settings, ...choice }
            const tui = settings.tui
            if (tui !== undefined && (typeof tui !== "object" || tui === null || Array.isArray(tui)))
              throw new Error("tui must be an object")
            const next: Record<string, unknown> = {
              ...tui,
              theme: theme.name,
              themeVariant: theme.variant,
            }
            // An omitted third argument is a direct name selection, not a shimmer reset.
            if (theme.shimmer.length) {
              const effect = theme.shimmer[0]
              const normalized = normalizeShimmer(effect)
              if (!normalized || !Object.keys(normalized).length) delete next.shimmer
              else if (typeof effect === "string") next.shimmer = effect
              // Objects merge across settings layers, so persist every chosen preset knob.
              else if (normalized.preset)
                next.shimmer = { ...normalized, ...resolveShimmer(undefined, normalized) }
              else next.shimmer = normalized
            }
            return { ...settings, tui: next }
          },
          { preserveFormatting: true },
        )
      } catch (err) {
        const why = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+\s*/g, " ")
        warn(a, `Choice not saved: ${why}`)
      }
    }
    // The global choice is durable immediately, even while the first Git probe is running.
    write(path.join(home, "settings.json"))
    const key = `${a.sessionId}\0${cwd}`
    let project = projects.get(key)
    if (!project) {
      project = decideProject(a)
      projects.set(key, project)
    }
    // One queue prevents an earlier selection from overwriting a later one after a slow probe.
    pending = pending.then(async () => {
      const file = await project
      if (file) write(file)
    })
  }
  return {
    rememberTheme: (name, variant, ...shimmer) => save({ name, variant, shimmer }),
    flush: () => pending,
    control: {
      ...control,
      setModel: (ref) => {
        const before = agent().model
        control.setModel(ref)
        const after = agent().model
        if (before.provider !== after.provider || before.id !== after.id) save()
      },
      setFastMode: (enabled) => {
        control.setFastMode(enabled)
        save(undefined, enabled)
      },
      setThinking: (level) => {
        const a = agent()
        const before = a.thinking.for(a.model)
        control.setThinking(level)
        if (before !== level) save()
      },
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
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 3000, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim())
    })
  })
}

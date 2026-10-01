import path from "node:path"
import type { AnyEvent, EventEnvelope, Extension } from "@amira/api"
import type { Agent, EventBus, ExtensionHost } from "@amira/core"
import type { ActivePackages } from "@amira/packages"

export interface ExtensionLoaderOptions {
  host: ExtensionHost
  bus: EventBus
  noBuiltins: boolean
  builtins: () => Promise<{ source: string; extension: Extension }[]>
  getPackages: () => ActivePackages | undefined
  extensions: string[]
  cwd: string
}

/** Loads everything; returns the sources that failed. */
export function createExtensionLoader(opts: ExtensionLoaderOptions): () => Promise<string[]> {
  return async () => {
    const failed: string[] = []
    if (!opts.noBuiltins) {
      try {
        for (const b of await opts.builtins()) {
          if (!(await opts.host.load(b.extension, b.source))) failed.push(b.source)
        }
      } catch (err) {
        const error = `failed to load built-in extensions: ${err instanceof Error ? err.message : String(err)}`
        opts.bus.emit("extension.error", { source: "builtin", error }, { sessionId: "host" })
        failed.push("builtin")
      }
    }
    const packages = opts.getPackages()
    for (const p of packages?.packages ?? []) {
      for (const file of p.manifest.extensions) {
        const label = packageLabel(p, file)
        if (!(await opts.host.loadFile(file, label))) failed.push(label.source)
      }
    }
    for (const file of opts.extensions) {
      const source = fileLabel(file, opts.cwd)
      if (!(await opts.host.loadFile(file, { source }))) failed.push(source)
    }
    for (const p of packages?.problems ?? []) {
      opts.bus.emit("extension.error", { source: p.name, error: p.error }, { sessionId: "host" })
      failed.push(p.name)
    }
    return failed
  }
}

export function createReloadReplay(bus: EventBus): (agent: Agent) => AnyEvent[] {
  // What a reload hands the extensions it loads again: the top-level session's start, where it
  // works and what it cost since (D37: the whole tree's).
  const state: {
    start?: EventEnvelope<"session.start">
    workspace?: EventEnvelope<"workspace.changed">
    budget?: EventEnvelope<"budget.update">
  } = {}
  bus.subscribe(
    (e) => {
      if (e.type === "session.start" && e.parentSessionId === undefined) {
        state.start = e
        // A cost counts from the start of its session.
        delete state.budget
      } else if (e.type === "workspace.changed") state.workspace = e
      else if (e.type === "budget.update") state.budget = e
    },
    { types: ["session.start", "workspace.changed", "budget.update"] },
  )
  return (agent) => {
    const out: AnyEvent[] = []
    const start = state.start
    if (start?.sessionId === agent.sessionId) {
      const { contextTokens: _t, contextWindow: _w, ...rest } = start.data
      const tokens = agent.contextTokens
      out.push({
        ...start,
        data: {
          ...rest,
          model: { provider: agent.model.provider, model: agent.model.id },
          ...(tokens !== undefined
            ? { contextTokens: tokens, contextWindow: agent.model.contextWindow }
            : {}),
        },
      })
    }
    if (state.workspace) out.push(state.workspace)
    if (state.budget) out.push(state.budget)
    return out.sort((x, y) => x.seq - y.seq)
  }
}

/**
 * How a package's extension file is named in errors and /help: the package's name, and the
 * file too when the package has several. Its failures say how to turn it off.
 */
function packageLabel(
  p: ActivePackages["packages"][number],
  file: string,
): { source: string; name: string; hint: string } {
  const rel = path.relative(p.dir, file).split(path.sep).join("/")
  const source = p.manifest.extensions.length > 1 ? `${p.name}/${rel}` : p.name
  return { source, name: p.name, hint: `${p.scope} package; amira ext disable ${p.name} turns it off` }
}

/** An extension file given with --extension: its path relative to the working directory, if inside it. */
function fileLabel(file: string, cwd: string): string {
  const abs = path.resolve(cwd, file)
  const rel = path.relative(cwd, abs)
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs
}

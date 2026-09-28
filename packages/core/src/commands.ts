import type {
  CommandCandidate,
  CommandContext,
  CommandDefinition,
  CommandFrontend,
  CommandInfo,
  CommandOutputLevel,
  SessionControl,
} from "@amira/api"
import type { Agent } from "./agent.ts"
import type { EventBus } from "./event-bus.ts"
import type { UiRequests } from "./ui-requests.ts"

export class CommandConflictError extends Error {}

const NAME = /^[A-Za-z0-9][\w:.-]*$/

interface Registered {
  def: CommandDefinition
  source: string
}

/**
 * Slash commands registered by extensions (D55). Like tools, a name holds a stack:
 * `override: true` replaces the current command and removing it restores the one below.
 */
export class CommandRegistry {
  #commands = new Map<string, Registered[]>()

  /** Throws CommandConflictError for a taken name without `override`, and Error for an invalid name. */
  register(def: CommandDefinition, source: string): () => void {
    if (!NAME.test(def.name)) {
      throw new Error(`invalid command name "${def.name}": use letters, digits and - _ : .`)
    }
    const stack = this.#commands.get(def.name) ?? []
    const top = stack.at(-1)
    if (top && !def.override) {
      throw new CommandConflictError(
        `command /${def.name} from ${source} conflicts with the one from ${top.source}; set override: true to replace it`,
      )
    }
    const entry = { def, source }
    stack.push(entry)
    this.#commands.set(def.name, stack)
    return () => {
      const rest = (this.#commands.get(def.name) ?? []).filter((e) => e !== entry)
      if (rest.length) this.#commands.set(def.name, rest)
      else this.#commands.delete(def.name)
    }
  }

  get(name: string): Registered | undefined {
    return this.#commands.get(name)?.at(-1)
  }

  /** The current command of every name, sorted by name. */
  list(): CommandInfo[] {
    return [...this.#commands.values()]
      .map((s) => s.at(-1)!)
      .map(({ def, source }) => ({
        name: def.name,
        description: def.description,
        ...(def.args?.hint ? { hint: def.args.hint } : {}),
        source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

/**
 * Splits "/name args" into its parts. Text that only looks like a path ("/usr/bin is empty")
 * is not a command line, so it can still be sent as a message.
 */
export function parseCommandLine(text: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: m[1]!, args: (m[2] ?? "").trim() } : undefined
}

/**
 * How well `query` matches `text` as a subsequence; lower is better, undefined for no match.
 * Every start of the first character is tried, so a contiguous run beats a scattered one.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  let best: number | undefined
  for (let start = t.indexOf(q[0]!); start !== -1; start = t.indexOf(q[0]!, start + 1)) {
    let score: number = start
    let at = start
    let matched = true
    for (let i = 1; i < q.length; i++) {
      const next = t.indexOf(q[i]!, at + 1)
      if (next === -1) {
        matched = false
        break
      }
      // Gaps cost, but less where the next character starts a word.
      const gap = next - at - 1
      score += gap === 0 ? 0 : /[\s/_:.-]/.test(t[next - 1]!) ? 1 : 2 + gap
      at = next
    }
    if (matched && (best === undefined || score < best)) best = score
  }
  return best
}

/**
 * Items matching `query`: prefix matches first (in their original order, an exact match on
 * top), then the other fuzzy matches, best first. An empty query keeps every item.
 */
export function rankMatches<T>(query: string, items: readonly T[], key: (item: T) => string): T[] {
  const q = query.toLowerCase()
  if (!q) return [...items]
  const prefix: T[] = []
  const fuzzy: { item: T; score: number; i: number }[] = []
  items.forEach((item, i) => {
    const k = key(item).toLowerCase()
    if (k.startsWith(q)) {
      if (k === q) prefix.unshift(item)
      else prefix.push(item)
      return
    }
    const score = fuzzyScore(q, k)
    if (score !== undefined) fuzzy.push({ item, score, i })
  })
  fuzzy.sort((a, b) => a.score - b.score || a.i - b.i)
  return [...prefix, ...fuzzy.map((f) => f.item)]
}

export interface CommandRunOptions {
  frontend: CommandFrontend
  /** What /quit does; frontends without one leave it out. */
  quit?: () => void
  signal?: AbortSignal
}

export interface CommandOutcome {
  ok: boolean
  /** The command's name, when the line named one. */
  command?: string
  /** Everything it printed, in order. */
  output: string[]
  error?: string
}

export interface CommandHostOptions {
  registry: CommandRegistry
  bus: EventBus
  ui: UiRequests
  /** What commands act on; supplied by the process that owns the sessions. */
  control: SessionControl
  agent: Agent
}

/**
 * Offers, completes and runs slash commands for the frontends, and tracks which agent is the
 * active session: commands like /clear and /resume switch it, and frontends follow.
 */
export class CommandHost {
  #opts: CommandHostOptions
  #agent: Agent
  #listeners = new Set<(agent: Agent) => void>()

  constructor(opts: CommandHostOptions) {
    this.#opts = opts
    this.#agent = opts.agent
  }

  get agent(): Agent {
    return this.#agent
  }

  get control(): SessionControl {
    return this.#opts.control
  }

  /** Makes `agent` the active session and tells every listener. */
  switchTo(agent: Agent): void {
    this.#agent = agent
    for (const fn of this.#listeners) fn(agent)
  }

  onSwitch(listener: (agent: Agent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  list(): CommandInfo[] {
    return this.#opts.registry.list()
  }

  /**
   * Candidates for the command line typed so far: command names while the name is being
   * typed, otherwise the command's own argument candidates. Both are ranked against the text.
   */
  async complete(line: string): Promise<{ command?: string; candidates: CommandCandidate[] }> {
    const nameOnly = /^\/(\S*)$/.exec(line)
    if (nameOnly) {
      const ranked = rankMatches(nameOnly[1]!, this.list(), (c) => c.name)
      return { candidates: ranked.map((c) => ({ value: c.name, description: c.description })) }
    }
    const withArgs = /^\/(\S+)\s([\s\S]*)$/.exec(line)
    const entry = withArgs ? this.#opts.registry.get(withArgs[1]!) : undefined
    if (!withArgs || !entry) return { candidates: [] }
    const command = entry.def.name
    const complete = entry.def.args?.complete
    if (!complete) return { command, candidates: [] }
    const prefix = withArgs[2]!.trimStart()
    try {
      const all = await complete(prefix, { cwd: this.#agent.cwd, session: this.#opts.control })
      return { command, candidates: rankMatches(prefix, Array.isArray(all) ? all : [], (c) => c.value) }
    } catch {
      return { command, candidates: [] }
    }
  }

  /** Runs one command line. Never throws: failures are printed and returned. */
  async run(line: string, opts: CommandRunOptions): Promise<CommandOutcome> {
    const output: string[] = []
    const parsed = parseCommandLine(line)
    const name = parsed?.name ?? line.trim()
    const print = (text: string, level: CommandOutputLevel = "info") => {
      const s = String(text)
      output.push(s)
      this.#opts.bus.emit(
        "command.output",
        { command: name, text: s, level },
        { sessionId: this.#agent.sessionId },
      )
    }
    const entry = parsed ? this.#opts.registry.get(parsed.name) : undefined
    if (!parsed || !entry) {
      const error = parsed
        ? `Unknown command /${parsed.name}. Type /help to list the commands.`
        : `Not a command: ${line.trim()}`
      print(error, "error")
      return { ok: false, ...(parsed ? { command: parsed.name } : {}), output, error }
    }
    const ctx: CommandContext = {
      cwd: this.#agent.cwd,
      session: this.#opts.control,
      frontend: opts.frontend,
      signal: opts.signal ?? new AbortController().signal,
      ui: this.#opts.ui.api(),
      print,
      commands: () => this.list(),
      quit: opts.quit ?? (() => {}),
    }
    try {
      await entry.def.run(parsed.args, ctx)
      return { ok: true, command: parsed.name, output }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      print(error, "error")
      return { ok: false, command: parsed.name, output, error }
    }
  }
}

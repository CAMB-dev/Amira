import type {
  CommandAlias,
  CommandCandidate,
  CommandContext,
  CommandDefinition,
  CommandFrontend,
  CommandInfo,
  CommandOutputLevel,
  FrontendView,
  InputHandler,
  SessionControl,
  SkillInfo,
} from "@amira/api"
import type { Agent } from "./agent.ts"
import type { EventBus } from "./event-bus.ts"
import { parseSkillLine, type SkillRegistry } from "./skills.ts"
import type { UiRequests } from "./ui-requests.ts"

export class CommandConflictError extends Error {}

const NAME = /^[A-Za-z0-9][\w:.-]*$/

/** Whether `name` may be a command alias: the characters of a command name, or "?". */
export const isCommandAliasName = (name: string): boolean => name === "?" || NAME.test(name)

interface Registered {
  def: CommandDefinition
  source: string
  /** Registration order; of two claims on an alias, the later one wins. */
  seq: number
}

/**
 * Slash commands registered by extensions (D55). Like tools, a name holds a stack:
 * `override: true` replaces the current command and removing it restores the one below.
 *
 * Aliases point at a name, not at one registration, so they follow overrides. The rules:
 * a command's name always wins over an alias, and of two commands claiming an alias the one
 * registered last has it (removing it gives the alias back). Both are allowed but reported
 * through `warn`.
 */
export class CommandRegistry {
  #commands = new Map<string, Registered[]>()
  #seq = 0

  /**
   * Throws CommandConflictError for a taken name without `override`, and Error for an invalid
   * name or alias. `warn` hears of aliases this command shadows, takes over or loses.
   */
  register(def: CommandDefinition, source: string, warn?: (message: string) => void): () => void {
    if (!NAME.test(def.name)) {
      throw new Error(`invalid command name "${def.name}": use letters, digits and - _ : .`)
    }
    for (const alias of def.aliases ?? []) {
      if (!isCommandAliasName(alias) || alias === def.name) {
        throw new Error(`invalid alias "${alias}" for /${def.name}: use letters, digits and - _ : . or "?"`)
      }
    }
    const stack = this.#commands.get(def.name) ?? []
    const top = stack.at(-1)
    if (top && !def.override) {
      throw new CommandConflictError(
        `command /${def.name} from ${source} conflicts with the one from ${top.source}; set override: true to replace it`,
      )
    }
    if (warn) for (const w of this.#warnings(def, source)) warn(w)
    const entry = { def, source, seq: this.#seq++ }
    stack.push(entry)
    this.#commands.set(def.name, stack)
    return () => {
      const rest = (this.#commands.get(def.name) ?? []).filter((e) => e !== entry)
      if (rest.length) this.#commands.set(def.name, rest)
      else this.#commands.delete(def.name)
    }
  }

  /** The current command of a name, or of an alias. */
  get(name: string): Registered | undefined {
    const own = this.#commands.get(name)?.at(-1)
    if (own) return own
    const claim = this.#aliases().get(name)
    return claim && this.#commands.get(claim.def.name)?.at(-1)
  }

  /** Whether `name` is a command's name, not an alias. */
  has(name: string): boolean {
    return this.#commands.has(name)
  }

  /** The current command of every name, sorted by name. */
  list(): CommandInfo[] {
    const aliases = new Map<string, string[]>()
    for (const [alias, claim] of this.#aliases()) {
      aliases.set(claim.def.name, [...(aliases.get(claim.def.name) ?? []), alias])
    }
    return [...this.#commands.values()]
      .map((s) => s.at(-1)!)
      .map(({ def, source }) => ({
        name: def.name,
        aliases: aliases.get(def.name) ?? [],
        description: def.description,
        ...(def.args?.hint ? { hint: def.args.hint } : {}),
        source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Each alias in effect, with the registration whose claim won, in registration order. */
  #aliases(): Map<string, Registered> {
    const table = new Map<string, Registered>()
    const all = [...this.#commands.values()].flat().sort((a, b) => a.seq - b.seq)
    for (const e of all) {
      for (const alias of e.def.aliases ?? []) {
        if (this.#commands.has(alias)) continue
        if (table.get(alias)?.def.name === e.def.name) continue
        table.delete(alias)
        table.set(alias, e)
      }
    }
    return table
  }

  #warnings(def: CommandDefinition, source: string): string[] {
    const out: string[] = []
    const table = this.#aliases()
    for (const alias of def.aliases ?? []) {
      const named = this.#commands.get(alias)?.at(-1)
      const claim = table.get(alias)
      if (named) {
        out.push(`alias /${alias} of /${def.name} is shadowed by the command /${alias} from ${named.source}`)
      } else if (claim && claim.def.name !== def.name) {
        out.push(
          `alias /${alias} now runs /${def.name} from ${source} instead of /${claim.def.name} from ${claim.source}`,
        )
      }
    }
    const shadowed = this.#commands.has(def.name) ? undefined : table.get(def.name)
    if (shadowed) {
      out.push(
        `command /${def.name} from ${source} shadows the alias /${def.name} of /${shadowed.def.name} from ${shadowed.source}`,
      )
    }
    return out
  }
}

/**
 * The input handlers extensions registered (InputHandler): lines the user sends that one of
 * them claims never reach the model. The handler registered last is asked first.
 */
export class InputRegistry {
  #handlers: { handler: InputHandler; source: string }[] = []

  register(handler: InputHandler, source: string): () => void {
    if (!handler.name?.trim()) throw new Error("an input handler needs a name")
    const entry = { handler, source }
    this.#handlers.push(entry)
    return () => {
      this.#handlers = this.#handlers.filter((e) => e !== entry)
    }
  }

  /** The handler that claims `text`, if any; one that throws does not. */
  claim(text: string): InputHandler | undefined {
    for (const { handler } of [...this.#handlers].reverse()) {
      try {
        if (handler.claims(text)) return handler
      } catch {}
    }
    return undefined
  }
}

/**
 * Problems with the user's `commandAliases`: one that is already a command or a command's
 * alias is ignored, since those win.
 */
export function commandAliasWarnings(
  aliases: Record<string, string> | undefined,
  registry: CommandRegistry,
): string[] {
  return Object.keys(aliases ?? {}).flatMap((name) => {
    const taken = registry.get(name)
    if (!taken) return []
    const what = taken.def.name === name ? "a command" : `an alias of /${taken.def.name}`
    return [`commandAliases: /${name} is already ${what} (from ${taken.source}); the setting is ignored`]
  })
}

/**
 * Splits "/name args" into its parts. Text that only looks like a path ("/usr/bin is empty")
 * is not a command line, so it can still be sent as a message.
 */
export function parseCommandLine(text: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z0-9][\w:.-]*|\?)(?:\s+([\s\S]*))?$/.exec(text.trim())
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
 * top), then the other fuzzy matches, best first. An empty query keeps every item. An item
 * with several keys (a command and its aliases) ranks by its best one.
 */
export function rankMatches<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string | readonly string[],
): T[] {
  const q = query.toLowerCase()
  if (!q) return [...items]
  const prefix: T[] = []
  const fuzzy: { item: T; score: number; i: number }[] = []
  items.forEach((item, i) => {
    const k = key(item)
    const keys = (typeof k === "string" ? [k] : k).map((s) => s.toLowerCase())
    if (keys.some((s) => s.startsWith(q))) {
      if (keys.includes(q)) prefix.unshift(item)
      else prefix.push(item)
      return
    }
    let score: number | undefined
    for (const s of keys) {
      const f = fuzzyScore(q, s)
      if (f !== undefined && (score === undefined || f < score)) score = f
    }
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
  /** Shows a full-screen view; frontends without views leave it out. */
  openView?: (view: FrontendView) => boolean
  /** The frontend's most useful keys, for /help; frontends without keys leave it out. */
  keys?: CommandContext["keys"]
}

export interface CommandOutcome {
  ok: boolean
  /** The command's name, when the line named one; for an alias, the command it ran. */
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
  /**
   * The user's aliases (settings `commandAliases`): name to a command line without the slash.
   * Commands and their own aliases win over them; see commandAliasWarnings.
   */
  aliases?: Record<string, string>
  /** The `$` skills; without it no line runs a skill. */
  skills?: SkillRegistry
  /** Extensions' input handlers; without it no line is claimed. */
  inputs?: InputRegistry
}

/** Candidates for a command line; `command` is set once the arguments are being completed. */
export type CompletionResult = {
  command?: string
  candidates: CommandCandidate[]
}

/** What a typed name runs: a command, with the argument text an alias puts in front. */
type Resolved =
  | { entry: Registered; prepend: string }
  /** A settings alias that cannot run. */
  | { error: string }

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

  /** The command a line actually runs, resolving both registered and settings aliases. */
  commandName(line: string): string | undefined {
    const parsed = parseCommandLine(line)
    const resolved = parsed && this.#resolve(parsed.name)
    return resolved && "entry" in resolved ? resolved.entry.def.name : undefined
  }

  /** The `$` skills, by name. */
  skills(): SkillInfo[] {
    return this.#opts.skills?.list() ?? []
  }

  /**
   * The skill a line runs, when it is "$name [args]" and names a registered skill. Other text
   * that starts with "$" ("$100 is the price") runs nothing and is sent as a message.
   */
  skillLine(text: string): { name: string; args: string } | undefined {
    const parsed = parseSkillLine(text)
    return parsed && this.#opts.skills?.get(parsed.name) ? parsed : undefined
  }

  /**
   * Candidates for a skill line typed so far: skill names, ranked against the text after the
   * "$", while the name is typed; once arguments follow, `command` names the skill (skills
   * offer no argument candidates).
   */
  completeSkill(line: string): CompletionResult {
    const nameOnly = /^\$(\S*)$/.exec(line)
    if (nameOnly) {
      const items = this.skills().map((s) => ({ value: s.name, description: s.description }))
      return { candidates: rankMatches(nameOnly[1]!, items, (c) => c.value) }
    }
    const parsed = /^\$\S+\s/.test(line) ? this.skillLine(line) : undefined
    return parsed ? { command: parsed.name, candidates: [] } : { candidates: [] }
  }

  /** The settings aliases in effect (commands win over them), by name. */
  aliases(): CommandAlias[] {
    return Object.entries(this.#opts.aliases ?? {})
      .filter(([name]) => !this.#opts.registry.get(name))
      .map(([name, expansion]) => ({ name, expansion: expansion.trim() }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * What `/name` runs. A command's own aliases resolve in the registry; a settings alias
   * expands one level only, so its target must be a command's name.
   */
  #resolve(name: string): Resolved | undefined {
    const { registry } = this.#opts
    const entry = registry.get(name)
    if (entry) return { entry, prepend: "" }
    const alias = this.aliases().find((a) => a.name === name)
    if (!alias) return undefined
    const target = parseCommandLine(`/${alias.expansion}`)
    const fix = 'fix "commandAliases" in settings.json'
    if (!target) return { error: `the alias /${name} is not a command line: "${alias.expansion}"; ${fix}` }
    const found = registry.has(target.name) ? registry.get(target.name) : undefined
    if (found) return { entry: found, prepend: target.args }
    const via = registry.get(target.name)?.def.name
    if (via || this.aliases().some((a) => a.name === target.name)) {
      return {
        error: `the alias /${name} runs /${target.name}, which is an alias itself; aliases resolve one level only, so point it at ${via ? `/${via}` : "a command"} (${fix})`,
      }
    }
    return {
      error: `the alias /${name} runs /${target.name}, which is not a command; ${fix} or type /help to list the commands`,
    }
  }

  /**
   * Candidates for the command line typed so far: command names while the name is being
   * typed, otherwise the command's own argument candidates. Both are ranked against the text.
   * A command matches by its name or any alias and is offered by its name; settings aliases
   * are offered by their own name, labelled with what they run.
   *
   * The answer comes at once unless the command's completer is async, so a frontend can
   * draw the list in the same frame as the key that asked for it.
   */
  complete(line: string): CompletionResult | Promise<CompletionResult> {
    const nameOnly = /^\/(\S*)$/.exec(line)
    if (nameOnly) {
      const items = [
        ...this.list().map((c) => ({
          keys: [c.name, ...c.aliases],
          candidate: {
            value: c.name,
            description: c.description,
            ...(c.aliases.length ? { label: `${c.name} (${c.aliases.join(", ")})` } : {}),
          },
        })),
        ...this.aliases().map((a) => {
          const target = this.#resolve(a.name)
          return {
            keys: [a.name],
            candidate: {
              value: a.name,
              label: `${a.name} → /${a.expansion}`,
              description: target && "entry" in target ? target.entry.def.description : "not a command",
            },
          }
        }),
      ].sort((a, b) => a.candidate.value.localeCompare(b.candidate.value))
      return { candidates: rankMatches(nameOnly[1]!, items, (i) => i.keys).map((i) => i.candidate) }
    }
    const withArgs = /^\/(\S+)\s([\s\S]*)$/.exec(line)
    const resolved = withArgs ? this.#resolve(withArgs[1]!) : undefined
    if (!withArgs || !resolved || !("entry" in resolved)) return { candidates: [] }
    const { entry, prepend } = resolved
    const command = entry.def.name
    const complete = entry.def.args?.complete
    // An alias that fixes arguments leaves nothing to complete.
    if (!complete || prepend) return { command, candidates: [] }
    const prefix = withArgs[2]!.trimStart()
    const ranked = (all: unknown): CompletionResult => ({
      command,
      candidates: rankMatches(prefix, Array.isArray(all) ? (all as CommandCandidate[]) : [], (c) => c.value),
    })
    let all: CommandCandidate[] | Promise<CommandCandidate[]>
    try {
      all = complete(prefix, { cwd: this.#agent.cwd, session: this.#opts.control })
    } catch {
      return { command, candidates: [] }
    }
    if (Array.isArray(all) || typeof (all as { then?: unknown } | undefined)?.then !== "function") {
      return ranked(all)
    }
    return Promise.resolve(all).then(ranked, () => ({ command, candidates: [] }))
  }

  /** Runs one command line. Never throws: failures are printed and returned. */
  async run(line: string, opts: CommandRunOptions): Promise<CommandOutcome> {
    const output: string[] = []
    const parsed = parseCommandLine(line)
    const resolved = parsed ? this.#resolve(parsed.name) : undefined
    const entry = resolved && "entry" in resolved ? resolved.entry : undefined
    // Output is attributed to the command that runs, also when an alias named it.
    const name = entry?.def.name ?? parsed?.name ?? line.trim()
    const print = this.#printer(name, output)
    if (!parsed || !resolved || "error" in resolved) {
      const problem = resolved && "error" in resolved ? resolved.error : undefined
      const error = !parsed
        ? `Not a command: ${line.trim()}`
        : problem
          ? `${problem[0]!.toUpperCase()}${problem.slice(1)}.`
          : this.#opts.skills?.get(parsed.name)
            ? `Unknown command /${parsed.name} — skills now start with $: $${parsed.name}`
            : `Unknown command /${parsed.name}. Type /help to list the commands.`
      print(error, "error")
      return { ok: false, ...(parsed ? { command: parsed.name } : {}), output, error }
    }
    const { entry: command, prepend } = resolved
    const args = [prepend, parsed.args].filter(Boolean).join(" ")
    try {
      await command.def.run(args, this.#context(opts, print))
      return { ok: true, command: name, output }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      print(error, "error")
      return { ok: false, command: name, output, error }
    }
  }

  /**
   * Runs one skill line, "$name [args]"; `command` in the outcome is the skill's name. Never
   * throws. Frontends check `skillLine` first, since text that names no skill is a message.
   */
  async runSkill(line: string, opts: CommandRunOptions): Promise<CommandOutcome> {
    const output: string[] = []
    const parsed = parseSkillLine(line)
    const name = parsed?.name ?? line.trim()
    const print = this.#printer(`$${name}`, output)
    const skill = parsed && this.#opts.skills?.get(parsed.name)
    if (!parsed || !skill) {
      const error = parsed
        ? `Unknown skill $${parsed.name}. Type $ to list the skills.`
        : `Not a skill: ${name}`
      print(error, "error")
      return { ok: false, ...(parsed ? { command: parsed.name } : {}), output, error }
    }
    try {
      await skill.def.run(parsed.args, this.#context(opts, print))
      return { ok: true, command: parsed.name, output }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      print(error, "error")
      return { ok: false, command: parsed.name, output, error }
    }
  }

  /**
   * Whether an extension's input handler claims the line (see InputHandler). Frontends ask
   * after checking for a command and a skill, and run it with `runInput` instead of sending it.
   */
  inputLine(text: string): boolean {
    return this.#opts.inputs?.claim(text.trim()) !== undefined
  }

  /**
   * Runs a line an input handler claims; `command` in the outcome is the handler's name.
   * Never throws: failures are printed and returned.
   */
  async runInput(line: string, opts: CommandRunOptions): Promise<CommandOutcome> {
    const output: string[] = []
    const text = line.trim()
    const handler = this.#opts.inputs?.claim(text)
    const print = this.#printer(handler?.name ?? "input", output)
    if (!handler) {
      const error = `No extension handles: ${text}`
      print(error, "error")
      return { ok: false, output, error }
    }
    try {
      await handler.run(text, this.#context(opts, print))
      return { ok: true, command: handler.name, output }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      print(error, "error")
      return { ok: false, command: handler.name, output, error }
    }
  }

  /** What a command (or `$skill`) prints: collected, and sent out as command.output. */
  #printer(command: string, output: string[]) {
    return (text: string, level: CommandOutputLevel = "info") => {
      const s = String(text)
      output.push(s)
      this.#opts.bus.emit("command.output", { command, text: s, level }, { sessionId: this.#agent.sessionId })
    }
  }

  #context(opts: CommandRunOptions, print: CommandContext["print"]): CommandContext {
    return {
      cwd: this.#agent.cwd,
      session: this.#opts.control,
      frontend: opts.frontend,
      signal: opts.signal ?? new AbortController().signal,
      ui: this.#opts.ui.api(),
      print,
      commands: () => this.list(),
      skills: () => this.skills(),
      aliases: () => this.aliases(),
      quit: opts.quit ?? (() => {}),
      ...(opts.openView ? { openView: opts.openView } : {}),
      ...(opts.keys ? { keys: opts.keys } : {}),
    }
  }
}

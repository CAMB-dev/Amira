import type { CommandRule, PermissionDecision, PermissionMode, ShellKind, ToolDefinition } from "@amira/api"
import type { Approver } from "../agent.ts"
import { type ProtectOptions, protectedPath, writtenPaths } from "./protected.ts"
import { commandName, isWrapper, type ParsedLine, parseBash, parsePowerShell } from "./shell-parse.ts"

/** The modes in the order Shift+Tab cycles them, starting from the default. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "edits", "plan"]

/** What each mode lets the model do, in a few words. */
export const MODE_SUMMARY: Record<PermissionMode, string> = {
  auto: "runs everything without asking, except what rules and protected paths say",
  edits: "changes files without asking; asks before shell commands",
  plan: "read-only: no file changes, no shell commands",
}

const STRICTNESS: Record<PermissionMode, number> = { auto: 0, edits: 1, plan: 2 }

/** The stricter of two modes. */
export function stricterMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a
}

/** Where a rule was set. */
export interface RuleSource {
  scope: "user" | "project"
  /** The settings file. */
  file: string
}

export interface PermissionRule extends CommandRule {
  source: RuleSource
}

/**
 * Why a call asks or is refused: the mode, a rule, a command the rules cannot read, a
 * protected path, or a tool plan mode does not know to be read-only.
 */
export type PermissionCause = "mode" | "rule" | "complex" | "protected" | "tool"

export interface PermissionVerdict {
  decision: PermissionDecision
  /**
   * One line saying why, without the call's own arguments: it is the approval's reason, and
   * "Don't ask again" covers the tool asked about for this reason.
   */
  reason: string
  cause?: PermissionCause
  /** The rule that decided, when one did. */
  rule?: PermissionRule
}

/** Tools that change files; checked for plan mode and protected paths. */
export const FILE_TOOLS = new Set(["write", "edit", "apply_patch"])

/** Tools plan mode lets run: they read, search, ask or start sub-agents (which inherit the mode). */
export const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ask_user",
  "tool_search",
  "web_search",
  "web_fetch",
  "skill",
  "agent",
  "agent_result",
  "return_result",
])

const ALLOW: PermissionVerdict = { decision: "allow", reason: "" }
const RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 }

/** The strictest of several verdicts (the first of equals). */
export function strictest(verdicts: PermissionVerdict[]): PermissionVerdict {
  const [first, ...rest] = verdicts
  if (!first) return ALLOW
  return rest.reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a), first)
}

/** How a rule reads in a reason: its words and where it is set. */
export function ruleLabel(rule: PermissionRule): string {
  return `rule ${JSON.stringify(rule.command)} (${rule.decision}, ${rule.source.scope} settings ${rule.source.file})`
}

/**
 * Whether a rule covers one simple command. The command name compares as commandName does
 * (`/usr/bin/git` and `git.exe` are `git`). An allow rule must be the start of the command,
 * word for word; ask and deny rules also match with other words in between (`git -C repo
 * push` is still `git push`) and ignore case, as they only ever make Amira more careful.
 */
export function ruleMatches(
  rule: CommandRule,
  argv: readonly string[],
  canon: (name: string) => string = commandName,
): boolean {
  const [name, ...rest] = rule.command
  if (name === undefined || !argv.length || canon(name) !== canon(argv[0]!)) return false
  if (rule.decision === "allow") {
    // `x/git status` is not `git status`: a program the model wrote could be named git.
    const first = argv[0]!
    if (/[\\/]/.test(first) && first !== name) return false
    return rest.every((w, i) => argv[i + 1] === w)
  }
  let j = 1
  for (const w of rest) {
    const want = w.toLowerCase()
    while (j < argv.length && argv[j]!.toLowerCase() !== want) j++
    if (j >= argv.length) return false
    j++
  }
  return true
}

/** The quoting and substitution marks left around words of a line read as complex. */
function bare(word: string): string {
  return word.replace(/^[`$(){}"'@&]+|[`(){}"';&]+$/g, "")
}

/**
 * Commands that may hide inside the words of a line read as complex, for the rules to look
 * at: the words without substitution marks, and what follows a word that opens a
 * substitution or block (`` `rm ``, `{`), as a command of its own.
 */
function hidden(commands: string[][], shell: ShellKind): string[][] {
  const out: string[][] = []
  for (const argv of commands) {
    out.push(argv.map(bare).filter(Boolean))
    // After a wrapper (sudo, xargs, nice, env...) any later word may be the command it runs.
    const wrapped = isWrapper(argv[0] ?? "", shell)
    argv.forEach((word, k) => {
      if (k > 0 && (wrapped || /^[`({]/.test(word))) out.push(argv.slice(k).map(bare).filter(Boolean))
    })
  }
  return out.filter((argv) => argv.length > 0)
}

/** PowerShell's built-in aliases for commands rules are likely to name, by alias. */
const POWERSHELL_ALIASES: Record<string, string> = {
  ac: "add-content",
  cat: "get-content",
  cd: "set-location",
  chdir: "set-location",
  clc: "clear-content",
  copy: "copy-item",
  cp: "copy-item",
  cpi: "copy-item",
  curl: "invoke-webrequest",
  del: "remove-item",
  dir: "get-childitem",
  erase: "remove-item",
  gc: "get-content",
  gci: "get-childitem",
  irm: "invoke-restmethod",
  iwr: "invoke-webrequest",
  kill: "stop-process",
  ls: "get-childitem",
  mi: "move-item",
  move: "move-item",
  mv: "move-item",
  ni: "new-item",
  rd: "remove-item",
  ren: "rename-item",
  ri: "remove-item",
  rm: "remove-item",
  rmdir: "remove-item",
  rni: "rename-item",
  sc: "set-content",
  sl: "set-location",
  spps: "stop-process",
  type: "get-content",
  wget: "invoke-webrequest",
}

/** A command name with PowerShell's aliases resolved, so `rm` and `Remove-Item` are one name. */
function powershellName(word: string): string {
  const name = commandName(word)
  return POWERSHELL_ALIASES[name] ?? name
}

export interface PermissionsOptions {
  /** The mode to start in. Default "auto". */
  mode?: PermissionMode
  rules?: PermissionRule[]
  /** Problems found reading the permission settings, for /permissions. */
  warnings?: string[]
  /** Where the mode came from, for /permissions ("default", a settings file, a flag). */
  modeSource?: string
  /** Paths protected from the file tools (Amira's user directory, the home directory). */
  protect?: ProtectOptions
  /**
   * The person who answers permission questions: the user of the top-level session, for that
   * session and every sub-agent under it. Unset, a top-level session asks its own approver and
   * a sub-agent cannot ask anyone (the call is refused).
   */
  approver?: Approver
}

/**
 * The core permission policy of one session tree (D13): the mode, the command rules and the
 * protected paths. The agent asks it about every tool call after the tool.call.before
 * interceptors, on the arguments the tool will get; sub-agents share their parent's.
 */
export class Permissions {
  readonly rules: readonly PermissionRule[]
  readonly warnings: readonly string[]
  approver: Approver | undefined
  #mode: PermissionMode
  #modeSource: string
  #protect: ProtectOptions
  #listeners = new Set<(mode: PermissionMode) => void>()

  constructor(opts: PermissionsOptions = {}) {
    this.#mode = opts.mode ?? "auto"
    this.rules = opts.rules ?? []
    this.warnings = opts.warnings ?? []
    this.#modeSource = opts.modeSource ?? "default"
    this.#protect = opts.protect ?? {}
    this.approver = opts.approver
  }

  get mode(): PermissionMode {
    return this.#mode
  }

  /** Where the mode came from: "default", a settings file, the flag, or this session. */
  get modeSource(): string {
    return this.#modeSource
  }

  /**
   * Switches the mode: the user's choice (Shift+Tab), never the model's. Calls already decided
   * stay decided.
   */
  setMode(mode: PermissionMode, source = "this session"): void {
    if (mode === this.#mode) return
    this.#mode = mode
    this.#modeSource = source
    for (const l of this.#listeners) l(mode)
  }

  /** The next mode in PERMISSION_MODES, which becomes the mode. */
  cycleMode(): PermissionMode {
    const next = PERMISSION_MODES[(PERMISSION_MODES.indexOf(this.#mode) + 1) % PERMISSION_MODES.length]!
    this.setMode(next)
    return next
  }

  /** Calls `listener` after each change of mode; returns how to stop. */
  onModeChange(listener: (mode: PermissionMode) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Decides a call of `tool` with `args` (the final ones, after interceptors), run in `cwd`. */
  async check(
    tool: Pick<ToolDefinition, "name" | "shellKind">,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<PermissionVerdict> {
    const mode = this.#mode
    const name = tool.name
    if (FILE_TOOLS.has(name)) {
      if (mode === "plan") {
        return { decision: "deny", reason: 'mode "plan" is read-only: files are not changed', cause: "mode" }
      }
      for (const p of writtenPaths(name, args)) {
        const hit = protectedPath(cwd, p, this.#protect)
        if (hit) {
          return {
            decision: "ask",
            reason: `it changes ${hit.what}, which always asks first`,
            cause: "protected",
          }
        }
      }
      return ALLOW
    }
    if (tool.shellKind || name === "bash" || name === "powershell") {
      if (mode === "plan") {
        return {
          decision: "deny",
          reason: 'mode "plan" is read-only: shell commands are not run (none can be proven read-only yet)',
          cause: "mode",
        }
      }
      // A shell tool's command is its `command` argument; without one as text there is
      // nothing to check, which counts as a command the rules cannot read.
      const command = typeof args.command === "string" ? args.command : undefined
      if (command === undefined)
        return this.#shell({ commands: [], complex: "no command text" }, mode, "bash")
      const kinds = await shellKinds(tool)
      return strictest(
        kinds.map((k) => this.#shell(k === "bash" ? parseBash(command) : parsePowerShell(command), mode, k)),
      )
    }
    if (mode === "plan" && !READ_ONLY_TOOLS.has(name)) {
      return { decision: "ask", reason: `mode "plan": ${name} is not known to be read-only`, cause: "tool" }
    }
    return ALLOW
  }

  #shell(line: ParsedLine, mode: PermissionMode, shell: ShellKind): PermissionVerdict {
    const strongest = (argv: string[], canon?: (name: string) => string, restrictOnly = false) =>
      strictest(
        this.rules
          .filter((r) => (!restrictOnly || r.decision !== "allow") && ruleMatches(r, argv, canon))
          .map((rule) => ({
            decision: rule.decision,
            reason: ruleReason(rule),
            cause: "rule" as const,
            rule,
          })),
      )
    const decided = line.commands.map((argv) => ({ argv, verdict: strongest(argv) }))
    // Readings only ask and deny rules see: commands hidden in a complex line, and with
    // PowerShell's aliases resolved (`del` for Remove-Item, `rm` for a rule on Remove-Item).
    const extra = [
      ...(line.complex ? hidden(line.commands, shell) : []).map((argv) => strongest(argv, undefined, true)),
      ...(shell === "powershell"
        ? [...line.commands, ...(line.complex ? hidden(line.commands, shell) : [])].map((argv) =>
            strongest(argv, powershellName, true),
          )
        : []),
    ]
    const all = [...decided.map((d) => d.verdict), ...extra]
    const deny = all.find((v) => v.decision === "deny")
    if (deny) return deny
    // A rule that asks is named in the question, so "Don't ask again" for it is its own.
    const ask = all.find((v) => v.decision === "ask")
    if (ask) return ask
    if (line.complex && (mode !== "auto" || this.rules.some((r) => r.decision !== "allow"))) {
      return {
        decision: "ask",
        reason: `the command has ${line.complex}, so the rules cannot check it word by word`,
        cause: "complex",
      }
    }
    if (
      !line.complex &&
      decided.length &&
      decided.every((d) => d.verdict.decision === "allow" && d.verdict.rule)
    ) {
      return {
        decision: "allow",
        reason: ruleReason(decided[0]!.verdict.rule!),
        cause: "rule",
        rule: decided[0]!.verdict.rule!,
      }
    }
    if (mode === "edits") {
      return { decision: "ask", reason: 'mode "edits": shell commands ask first', cause: "mode" }
    }
    return ALLOW
  }
}

function ruleReason(rule: PermissionRule): string {
  const why = rule.reason ? `: ${rule.reason}` : ""
  return `${ruleLabel(rule)}${why}`
}

/** The shells a call may run in: the tool's own answer, else every reading that fits its name. */
async function shellKinds(tool: Pick<ToolDefinition, "name" | "shellKind">): Promise<ShellKind[]> {
  if (tool.shellKind) {
    try {
      const kind = await tool.shellKind()
      if (kind === "bash" || kind === "powershell") return [kind]
    } catch {}
  }
  if (tool.name === "powershell") return ["powershell"]
  return ["bash", "powershell"]
}

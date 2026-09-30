import os from "node:os"
import path from "node:path"
import {
  type CommandCandidate,
  type CommandContext,
  type CommandDefinition,
  clip,
  formatElapsed,
  formatTokens,
  type Message,
  plural,
  type SelectSection,
  type SubagentInfo,
  subagentStateText,
  type ToolCallBlock,
  type ToolResultMessage,
} from "@amira/api"
import {
  type ChangeStat,
  formatStat,
  type KeptMerge,
  type KeptWorktree,
  STALE_NOTICE_MS,
  STALE_WORKTREE_MS,
} from "./worktree.ts"

export { formatTokens }

/** `text` on one line, cut to `max` terminal cells. */
function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), max)
}

/** How long it has run (or ran), e.g. "12s" or "3m 05s"; "queued" before it starts. */
export function elapsed(info: SubagentInfo, now: number): string {
  const ms = info.durationMs ?? (info.startedAt !== undefined ? now - info.startedAt : undefined)
  return ms === undefined ? "queued" : formatElapsed(ms)
}

/** Tokens, and the cost when the model's prices are known. */
export function usageText(info: SubagentInfo): string {
  const u = info.usage
  const tokens = `${formatTokens(u.input + u.output + u.cacheRead + u.cacheWrite)} tok`
  return u.cost !== undefined ? `${tokens} · $${u.cost.toFixed(4)}` : tokens
}

/** One line about a sub-agent: title, role, id, state, time and usage, then the task. */
export function subagentSummary(info: SubagentInfo, now: number, taskChars = 60): string {
  return `${info.title} · ${info.role} · ${info.id} · ${stateText(info, now)} · ${usageText(info)} · ${oneLine(info.task, taskChars)}`
}

/** Its status and how long it ran; just the status when that is not known (it never started). */
function stateText(info: SubagentInfo, now: number): string {
  const known = info.durationMs !== undefined || info.startedAt !== undefined
  const state = subagentStateText(info.status)
  return info.status === "queued" || !known ? state : `${state} · ${elapsed(info, now)}`
}

function blockText(content: Message["content"]): string {
  return content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n")
}

/** How many sub-agents a call of the agent tool starts: one per task. */
function spawnCount(call: ToolCallBlock): number {
  const tasks = (call.args as { tasks?: unknown }).tasks
  return Array.isArray(tasks) ? tasks.length : 1
}

/**
 * Takes the sub-agents an agent call started out of `rest`: those naming the call, or, for
 * sub-agents from before calls were recorded, as many as it had tasks, in order.
 */
function callKids(rest: SubagentInfo[], call: ToolCallBlock): SubagentInfo[] {
  if (!rest.some((k) => k.toolCallId !== undefined)) return rest.splice(0, spawnCount(call))
  const mine = rest.filter((k) => k.toolCallId === call.id)
  for (const k of mine) rest.splice(rest.indexOf(k), 1)
  return mine
}

function toolHead(call: ToolCallBlock, failed: boolean): string {
  const summary = oneLine(
    Object.values(call.args)
      .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(String)
      .join(" "),
    80,
  )
  return `${failed ? "✗" : "●"} ${call.name}${summary ? ` ${summary}` : ""}`
}

/**
 * A sub-agent's transcript, compactly and as plain text: a header, the task, one line per
 * tool call with a one-line preview of its result (the sub-agents a call started under it),
 * the first line of what it said along the way, and its final reply in full.
 */
export function transcriptText(
  info: SubagentInfo,
  messages: readonly Message[],
  all: SubagentInfo[],
  now = Date.now(),
): string {
  const out = [`◆ ${info.title} · ${info.role} · ${info.id} · ${stateText(info, now)} · ${usageText(info)}`]
  // A forked child starts with its parent's history; its own part starts at its task.
  const from = Math.max(
    0,
    messages.findLastIndex((m) => m.role === "user"),
  )
  const own = messages.slice(from)
  const task = own[0]?.role === "user" ? blockText(own[0].content).trim() : info.task
  for (const [i, line] of (task || "(no task)").split("\n").entries())
    out.push(`${i === 0 ? "›" : " "} ${line}`)
  out.push("")
  const results = new Map<string, ToolResultMessage>()
  for (const m of own) if (m.role === "toolResult") results.set(m.toolCallId, m)
  const kids = all.filter((s) => s.parentSessionId === info.id)
  const last = own.findLast((m) => m.role === "assistant")
  const finished = !live(info)
  for (const m of own) {
    if (m.role !== "assistant") continue
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim()) {
        const text = b.text.trim()
        const isFinal = m === last && !m.content.some((x) => x.type === "toolCall")
        if (isFinal) out.push(...text.split("\n"), "")
        else {
          const first = text.split("\n")[0]!
          out.push(text.includes("\n") ? `${oneLine(first, 98)} …` : oneLine(first, 100), "")
        }
      } else if (b.type === "toolCall") {
        const r = results.get(b.id)
        out.push(toolHead(b, r?.isError === true))
        if (!r) out.push(finished ? "  └ no result" : "  └ running")
        else {
          const lines = blockText(r.content).trim().split("\n")
          const more = lines.length > 1 ? ` (+${plural(lines.length - 1, "line")})` : ""
          out.push(`  └ ${oneLine(lines[0] || "no output", 100)}${more}`)
        }
        if (b.name === "agent") {
          for (const kid of callKids(kids, b)) out.push(`  ◆ ${subagentSummary(kid, now)}`)
        }
        out.push("")
      }
    }
  }
  // Sub-agents started some other way than the agent tool.
  for (const kid of kids) out.push(`◆ ${subagentSummary(kid, now)}`)
  if (kids.length) out.push("")
  if (info.error && info.status !== "done") out.push(`✗ ${info.error}`)
  else if (!finished) out.push(`… ${waitingFor(info)}`)
  else if (info.note) out.push(`⊘ ${info.note}`)
  else if (!last) out.push("(no reply)")
  while (out.at(-1) === "") out.pop()
  return out.join("\n")
}

/** A sub-agent by its 1-based number in the list, its id, or a unique start of its id. */
export function findSubagent(list: SubagentInfo[], ref: string): SubagentInfo | undefined {
  const r = ref.trim()
  if (/^\d+$/.test(r)) return list[Number(r) - 1]
  const exact = list.find((s) => s.id === r)
  if (exact) return exact
  const starts = list.filter((s) => s.id.startsWith(r))
  return starts.length === 1 ? starts[0] : undefined
}

/** Which one the live view opens on: the latest that is still running, else the latest. */
function defaultView(list: SubagentInfo[]): SubagentInfo | undefined {
  return list.findLast((s) => s.status === "running") ?? list.at(-1)
}

function label(s: SubagentInfo, i: number, now: number): string {
  return `${i + 1}. ${"  ".repeat(Math.max(0, s.depth - 1))}${subagentSummary(s, now)}`
}

/** Prints a sub-agent's transcript as it is now. */
function printTranscript(ctx: CommandContext, id: string) {
  const list = ctx.session.subagents()
  const s = list.find((x) => x.id === id)
  if (!s) throw new Error(`sub-agent ${id} is gone`)
  const messages = ctx.session.subagentMessages(s.id) ?? []
  ctx.print(transcriptText(s, messages, list))
}

/**
 * Opens the live view on a sub-agent. Where the frontend has none, or cannot show it now (a
 * form holds the screen), prints its transcript instead.
 */
function openOrPrint(ctx: CommandContext, s: SubagentInfo) {
  if (ctx.openView?.({ kind: "subagent", sessionId: s.id })) return
  printTranscript(ctx, s.id)
}

/** Not ended: running, waiting for a place to run, or (a persistent one) idle between turns. */
function live(s: SubagentInfo): boolean {
  return s.status === "running" || s.status === "queued" || s.status === "idle"
}

function waitingFor(s: SubagentInfo): string {
  if (s.status === "queued") return "waiting for a free slot"
  return s.status === "idle" ? "idle, waiting for a message" : "still running"
}

/** Stops one sub-agent, or every live one with "all"; says what it did. */
function stop(ctx: CommandContext, list: SubagentInfo[], ref: string) {
  if (!ref) throw new Error("say which: /agents stop <n|id>, or /agents stop all")
  if (ref === "all") {
    const running = list.filter(live)
    if (!running.length) return ctx.print("No sub-agent is running.")
    const stopped = running.filter((s) => ctx.session.stopSubagent(s.id))
    ctx.print(
      stopped.length
        ? `Stopped ${stopped.length} sub-agent${stopped.length === 1 ? "" : "s"}: ${stopped.map((s) => `${s.title} (${s.role} ${s.id})`).join(", ")}.`
        : "No sub-agent is running.",
    )
    return
  }
  const target = findSubagent(list, ref)
  if (!target) throw new Error(`no sub-agent "${ref}"; /agents lists them`)
  if (!live(target) || !ctx.session.stopSubagent(target.id)) {
    ctx.print(
      `${target.title} (${target.role} ${target.id}) has already ended (${subagentStateText(target.status)}).`,
    )
    return
  }
  ctx.print(`Stopped ${target.title} (${target.role} ${target.id}).`)
}

/** A sub-agent's worktree left behind, with the size of its changes when it could be told. */
export type KeptWorktreeInfo = KeptWorktree & { stat?: ChangeStat }

/** The worktrees sub-agents left behind in this repository, and what /agents does with them. */
export interface KeptWorktrees {
  /** Newest first; the ones sub-agents work in now are left out. */
  list(): Promise<KeptWorktreeInfo[]>
  /** Its changes collected now, as a patch to review; merge applies this patch. */
  changes(w: KeptWorktreeInfo): Promise<{ patch: string; stat: ChangeStat }>
  /** Applies its changes to the working tree and removes it; nothing is applied on a conflict. */
  merge(w: KeptWorktreeInfo): Promise<KeptMerge>
  /** Removes it with its changes; says why it stayed, if it did. */
  discard(w: KeptWorktreeInfo): Promise<string | undefined>
  /** Keeps it as if it had just changed: the cleanup starts over. */
  keep(w: KeptWorktreeInfo): Promise<KeptWorktreeInfo>
}

export interface AgentsCommandOptions {
  worktrees?: KeptWorktrees
  /** For tests: the home directory paths are shown under as `~`. */
  homeDir?: string
}

export const MERGE_KEPT = "Merge into the working tree"
export const KEEP_KEPT = `Keep it (not deleted for ${days(STALE_WORKTREE_MS + STALE_NOTICE_MS)} at least)`
export const DISCARD_KEPT = "Discard"

function days(ms: number): string {
  const n = Math.round(ms / 86_400_000)
  return `${n} day${n === 1 ? "" : "s"}`
}

/** "5 days", "3h", "under an hour". */
function span(ms: number): string {
  if (ms < 3_600_000) return "under an hour"
  const hours = Math.round(ms / 3_600_000)
  return hours < 24 ? `${hours}h` : days(ms)
}

/**
 * When the cleanup deletes a kept worktree. It is always announced first and deleted a day
 * later at the earliest; the cleanup runs when a sub-agent next gets a worktree here.
 */
function whenDeleted(w: KeptWorktreeInfo, now: number): string {
  const left = w.deleteAfter - now
  if (w.expiring)
    return left > 0 ? `deleted in ${span(left)} (announced)` : "deleted at the next cleanup (announced)"
  const announce = left - STALE_NOTICE_MS
  return announce > 0 ? `deleted in ${span(left)} at the earliest` : "the next cleanup announces its deletion"
}

/** Whose worktree it is: `"Fix the parser" (coder)`, or its directory's name when not known. */
export function keptWho(w: KeptWorktreeInfo): string {
  return w.title ? `"${w.title}" (${w.role ?? "sub-agent"})` : w.name
}

/** Whose a kept worktree is and how much it changed: "Fix the parser · coder · 3 files, +40 -3". */
function keptHead(w: KeptWorktreeInfo): string {
  const whose = w.title ? `${w.title} · ${w.role ?? "sub-agent"}` : w.name
  return `${whose} · ${w.stat ? formatStat(w.stat) : "changes not collected"}`
}

/** How old a kept worktree is and when the cleanup deletes it. */
function keptWhen(w: KeptWorktreeInfo, now: number): string {
  const age = Math.floor((now - w.modifiedAt) / 86_400_000)
  const changed = age < 1 ? "changed today" : `changed ${days(age * 86_400_000)} ago`
  return `${changed} · ${whenDeleted(w, now)}`
}

/** One line about a kept worktree: whose, how much it changed, how old it is and when it goes. */
export function keptSummary(w: KeptWorktreeInfo, now: number): string {
  return `${keptHead(w)} · ${keptWhen(w, now)}`
}

/**
 * A path under the home directory as `~/…`. On Windows paths stay as they are, so they can be
 * pasted into Explorer or a prompt.
 */
function shortPath(p: string, home: string): string {
  if (process.platform === "win32") return p
  const rel = path.relative(home, p)
  return home && rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : p
}

/** The kept worktrees as /agents worktrees lists them. */
export function keptWorktreesText(list: KeptWorktreeInfo[], now = Date.now(), home = os.homedir()): string {
  if (!list.length) return "No sub-agent worktrees are left behind in this repository."
  const rows = list.map(
    (w) =>
      `${keptSummary(w, now)}\n  ${shortPath(w.dir, home)}${w.patch ? `\n  patch: ${shortPath(w.patch, home)}` : ""}`,
  )
  return `Sub-agent worktrees kept with their changes (the /agents list merges, keeps or discards them; git apply <patch> takes them over):\n${rows.join("\n")}`
}

/** Asks what to do with a kept worktree, over its diff, and does it; says what it did. */
async function reviewKept(ctx: CommandContext, worktrees: KeptWorktrees, w: KeptWorktreeInfo) {
  const who = keptWho(w)
  let choice: string | undefined
  try {
    const { patch, stat } = await worktrees.changes(w)
    choice = await ctx.ui.reviewDiff(
      `The changes ${who} left in its worktree (${formatStat(stat)})`,
      patch,
      [MERGE_KEPT, KEEP_KEPT, DISCARD_KEPT],
      { signal: ctx.signal },
    )
  } catch (err) {
    // Its changes cannot be read: it can still be kept or deleted.
    const why = err instanceof Error ? err.message : String(err)
    choice = await ctx.ui.select(
      `The changes ${who} left cannot be read (${why}). What now?`,
      [KEEP_KEPT, DISCARD_KEPT],
      {
        signal: ctx.signal,
      },
    )
  }
  if (choice === MERGE_KEPT) {
    const r = await worktrees.merge(w)
    if (r.outcome === "conflict") {
      ctx.print(
        `The changes of ${who} do not apply cleanly to the working tree, so nothing was merged; they stay in ${w.dir}.\n${r.conflict}`,
        "warning",
      )
      return
    }
    const done =
      r.outcome === "empty"
        ? `${who} left no changes; its worktree is removed.`
        : `Merged the changes of ${who} into the working tree: ${formatStat(r.stat)}.`
    ctx.print(r.cleanup ? `${done} The worktree could not be removed: ${r.cleanup}` : done)
  } else if (choice === DISCARD_KEPT) {
    const problem = await worktrees.discard(w)
    ctx.print(
      problem
        ? `Discarded the changes of ${who}, but the worktree could not be removed: ${problem}`
        : `Discarded the worktree of ${who}.`,
    )
  } else if (choice === KEEP_KEPT) {
    const kept = await worktrees.keep(w)
    ctx.print(`Keeping the worktree of ${who}; ${whenDeleted(kept, Date.now())}.`)
  }
}

/**
 * /agents: this session's sub-agents, and the worktrees sub-agents left behind with their
 * changes. Without arguments a list: Enter on a sub-agent opens the live view on it where the
 * frontend has one (else prints its transcript), p prints its transcript; Enter on a worktree
 * shows its diff to merge, keep or discard it. `/agents <n|id>` prints one;
 * `/agents view [<n|id>]` opens the live view on it; `/agents stop <n|id|all>` stops one or
 * every running one; `/agents worktrees` lists the worktrees kept.
 */
export function agentsCommand(opts: AgentsCommandOptions = {}): CommandDefinition {
  const home = opts.homeDir ?? os.homedir()
  return {
    name: "agents",
    description: "Show the sub-agents of this session and the worktrees they left",
    args: {
      hint: "[<n>|<id>|view [<n>|<id>]|stop <n>|<id>|all|worktrees]",
      complete(prefix, ctx) {
        const list = ctx.session.subagents()
        const now = Date.now()
        // A number is offered as itself, so what was typed stays what runs.
        const ref = (s: SubagentInfo, i: number, typed: string) =>
          /^\d+$/.test(typed) ? String(i + 1) : s.id
        const view = /^view\s+(.*)$/.exec(prefix)
        if (view) {
          // Nothing after it yet: Enter opens the default one, not the first candidate.
          if (!view[1]) return []
          return list.map((s, i) => ({ value: `view ${ref(s, i, view[1]!)}`, description: label(s, i, now) }))
        }
        const stopping = /^stop\s+(.*)$/.exec(prefix)
        if (stopping) {
          const typed = stopping[1]!
          const running = list.flatMap((s, i) =>
            live(s) ? [{ value: `stop ${ref(s, i, typed)}`, description: label(s, i, now) }] : [],
          )
          return running.length
            ? [...running, { value: "stop all", description: "Stop every running one" }]
            : []
        }
        const out: CommandCandidate[] = list.map((s, i) => ({
          value: ref(s, i, prefix),
          description: label(s, i, now),
        }))
        if (/^\d+$/.test(prefix)) return out
        if (list.length) out.push({ value: "view", description: "Open the live view" })
        if (list.some(live)) out.push({ value: "stop", description: "Stop a running sub-agent" })
        if (opts.worktrees) out.push({ value: "worktrees", description: "Worktrees left with changes" })
        return out
      },
    },
    async run(args, ctx) {
      const worktrees = opts.worktrees
      if (args === "worktrees" && worktrees) {
        ctx.print(keptWorktreesText(await worktrees.list(), Date.now(), home))
        return
      }
      const list = ctx.session.subagents()
      if (args) {
        if (!list.length) return ctx.print("No sub-agents in this session yet.")
        const stopping = /^stop(?:\s+(.*))?$/.exec(args)
        if (stopping) return stop(ctx, list, stopping[1]?.trim() ?? "")
        const view = /^view(?:\s+(.*))?$/.exec(args)
        if (view) {
          const target = view[1] ? findSubagent(list, view[1]) : defaultView(list)
          if (!target) throw new Error(`no sub-agent "${view[1]}"; /agents lists them`)
          if (!ctx.openView) throw new Error("the live view needs the interactive terminal UI")
          return openOrPrint(ctx, target)
        }
        const target = findSubagent(list, args)
        if (!target) throw new Error(`no sub-agent "${args}"; /agents lists them`)
        return printTranscript(ctx, target.id)
      }
      const kept = (await worktrees?.list()) ?? []
      if (!list.length && !kept.length) return ctx.print("No sub-agents in this session yet.")
      const now = Date.now()
      if (ctx.frontend === "print") {
        // Nobody can pick from a list here: what there is, as text.
        const agents = list.length
          ? list.map((s, i) => label(s, i, now)).join("\n")
          : "No sub-agents in this session yet."
        ctx.print(kept.length ? `${agents}\n${keptWorktreesText(kept, now, home)}` : agents)
        return
      }
      // A digit picks the sub-agent of that number; worktrees come after them.
      const agentRows = list.map((s, i) => label(s, i, now))
      // Two worktrees of the same task and age read the same: their names tell them apart.
      // What matters most comes first: the rest (and the path) wraps under it when narrow.
      const summaries = kept.map((w) => keptHead(w))
      const keptRows = summaries.map((row, i) =>
        summaries.indexOf(row) === summaries.lastIndexOf(row) && !agentRows.includes(row)
          ? row
          : `${row} · ${kept[i]!.name}`,
      )
      const sections: SelectSection[] = []
      if (list.length) {
        sections.push({
          at: 0,
          choose: ctx.openView ? "open" : "print",
          ...(ctx.openView ? { keys: [{ key: "p", label: "print" }] } : {}),
        })
      }
      if (kept.length) {
        sections.push({
          at: list.length,
          ...(list.length ? { title: "Worktrees kept with their changes" } : {}),
          choose: "review",
        })
      }
      const title = list.length ? "Sub-agents" : "Worktrees sub-agents left with their changes"
      const pick = await ctx.ui.choose(title, [...agentRows, ...keptRows], {
        sections,
        descriptions: [
          ...agentRows.map(() => ""),
          ...kept.map((w) => `${keptWhen(w, now)} · ${shortPath(w.dir, home)}`),
        ],
        signal: ctx.signal,
      })
      if (!pick) return
      const at = agentRows.indexOf(pick.option)
      const chosen = list[at]
      if (chosen) {
        // The pick may have taken a while: printed, it is shown as it is now.
        if (pick.key === "p") return printTranscript(ctx, chosen.id)
        return openOrPrint(ctx, chosen)
      }
      const w = kept[keptRows.indexOf(pick.option)]
      if (w && worktrees) await reviewKept(ctx, worktrees, w)
    },
  }
}

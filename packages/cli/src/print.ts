import { createWriteStream, openSync, type WriteStream } from "node:fs"
import { describeServerTool, messageCitations, userMessage } from "@amira/ai"
import { type AnyEvent, type BackgroundJobInfo, type BackgroundJobRegistry, fallbackTitle } from "@amira/api"
import { type Agent, type CommandHost, parseCommandLine, type TurnResult, type UiRequests } from "@amira/core"

export interface PrintIO {
  stdout: (s: string) => void
  stderr: (s: string) => void
}

const defaultIO: PrintIO = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
}

const DEFAULT_BACKGROUND_JOB_WAIT_MS = 30_000
type PrintBackgroundJobs = Pick<BackgroundJobRegistry, "list" | "subscribe">

export interface PrintOptions {
  io?: PrintIO
  /** Events emitted before this frontend subscribed (e.g. extension load errors). */
  pending?: AnyEvent[]
  /** How long to wait for slow event subscribers after the turn. Default 2000 ms. */
  flushTimeoutMs?: number
  /** Called once this frontend is subscribed, e.g. to announce the session. */
  onReady?: () => void
  /** Called on a second Ctrl+C. Default exits the process with 130. */
  forceExit?: () => void
  /** Write JSONL events to this file instead of stdout. Only used when json is true. */
  jsonOut?: string
  /** Top-level shell jobs started during this run; print mode waits for them before exiting. */
  backgroundJobs?: PrintBackgroundJobs
  /** Maximum time print mode waits for those jobs. Default 30 seconds. */
  backgroundJobTimeoutMs?: number
  /** Dialogs extensions open; print mode cannot answer them, so they are cancelled. */
  ui?: UiRequests
  /**
   * Slash commands and skills: a prompt like "/status" runs the command instead of a turn, and
   * one like "$deploy now" the skill (other text starting with "$" is a prompt).
   */
  commands?: CommandHost
}

/** Exit codes: 0 done, 1 error, 130 aborted. */
export function exitCode(r: TurnResult): number {
  return r.reason === "done" ? 0 : r.reason === "aborted" ? 130 : 1
}

/** JSON.stringify that never throws: BigInts become strings, cycles and failures are marked. */
export function safeJson(value: unknown): string {
  try {
    // The objects being written, outermost first: a value among them is a cycle. One reached
    // twice by different paths (e.g. one model named in two fields) is not, and is written both times.
    const path: object[] = []
    const json = JSON.stringify(value, function (this: unknown, _k, v) {
      if (typeof v === "bigint") return v.toString()
      if (v && typeof v === "object") {
        while (path.length && path[path.length - 1] !== this) path.pop()
        if (path.includes(v)) return "[circular]"
        path.push(v)
      }
      return v
    })
    return asciiJson(json ?? "null")
  } catch (err) {
    return asciiJson(
      JSON.stringify({ unserializable: true, error: err instanceof Error ? err.message : String(err) }),
    )
  }
}

/** JSON lines stay ASCII so a Windows parent cannot reinterpret UTF-8 as an OEM code page. */
function asciiJson(json: string): string {
  let result = ""
  for (let index = 0; index < json.length; index++) {
    const character = json[index]
    const code = json.charCodeAt(index)
    result += code <= 0x7f ? character : `\\u${code.toString(16).padStart(4, "0")}`
  }
  return result
}

function finishJsonFile(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject)
    stream.once("finish", resolve)
    stream.end()
  })
}

/**
 * One non-interactive turn. Plain mode streams the reply to stdout and tool
 * activity to stderr; JSON mode writes every event as one JSON line.
 */
export async function runPrint(
  agent: Agent,
  prompt: string,
  json: boolean,
  opts: PrintOptions = {},
): Promise<number> {
  const io = opts.io ?? defaultIO
  // Opened at once, so a path that cannot be written fails the run before any turn.
  const jsonFile =
    json && opts.jsonOut
      ? createWriteStream("", { fd: openSync(opts.jsonOut, "w"), encoding: "utf8" })
      : undefined
  let jsonFileError: Error | undefined
  jsonFile?.on("error", (err) => {
    jsonFileError ??= err
  })
  let jsonFileOpen = jsonFile !== undefined
  agent.setNonInteractive()
  agent.tools.setDisabled(new Set([...agent.tools.disabled, "ask_user"]))
  // Questions for the user (ask_user) are not even asked: nobody is there to answer.
  if (opts.ui) opts.ui.unavailable = "print mode"
  let endedWithNewline = true
  /** Hosted web searches already printed, by id. */
  const searched = new Set<string>()
  /** Name, role and line indent of each sub-agent, by session id. */
  const subagents = new Map<string, { title: string; role: string; indent: string }>()
  /** How the main session's latest turn ended. */
  let lastEnd: TurnResult | undefined
  const handle = (e: AnyEvent) => {
    if (e.type === "turn.end" && e.sessionId === agent.sessionId) {
      lastEnd = {
        reason: e.data.reason,
        steps: e.data.steps,
        ...(e.data.error ? { error: e.data.error } : {}),
      }
    }
    if (e.type === "ui.request") {
      io.stderr(`amira: cancelled "${e.data.title}": print mode cannot answer questions\n`)
      opts.ui?.cancel(e.data.requestId)
    }
    if (json) {
      const line = `${safeJson(e)}\n`
      if (jsonFile) {
        if (jsonFileOpen) jsonFile.write(line)
      } else io.stdout(line)
      return
    }
    if (e.type === "subagent.start") {
      const indent = "  ".repeat(e.data.depth - 1)
      const title = e.data.title || fallbackTitle(e.data.prompt)
      const role = e.data.role ?? "agent"
      subagents.set(e.data.childSessionId, { title, role, indent: `${indent}  ` })
      const when = e.data.queued ? "queued" : "started"
      io.stderr(`${indent}◆ ${title} · ${role} ${when}: ${oneLine(e.data.prompt, 80)}\n`)
      return
    }
    if (e.type === "subagent.end") {
      const sub = subagents.get(e.data.childSessionId)
      const secs = (e.data.durationMs / 1000).toFixed(1)
      const error = e.data.error ? `: ${oneLine(e.data.error, 120)}` : ""
      io.stderr(
        `${sub?.indent.slice(2) ?? ""}◆ ${sub ? `${sub.title} · ${sub.role}` : "agent"} ${e.data.status} (${secs}s)${error}\n`,
      )
      return
    }
    if (e.type === "budget.exceeded") {
      io.stderr(`amira: the agent tree's budget is spent (${e.data.tokens} tokens); sub-agents stopped\n`)
      return
    }
    // A sub-agent's reply goes to its commander, not to stdout; only its tool calls are shown.
    if (e.sessionId !== agent.sessionId && e.parentSessionId !== undefined) {
      const sub = subagents.get(e.sessionId)
      const prefix = `${sub?.indent ?? "  "}↳ ${sub?.role ?? "agent"}`
      if (e.type === "tool.execute.start")
        io.stderr(`${prefix} ● ${e.data.name} ${summarizeArgs(e.data.args)}\n`)
      if (e.type === "message.delta" && e.data.kind === "serverTool" && e.data.block.status !== "running")
        io.stderr(`${prefix} ● ${describeServerTool(e.data.block)}\n`)
      if (e.type === "tool.execute.end" && e.data.result.isError) {
        io.stderr(`${prefix}   ✗ ${firstLine(e.data.result.content)}\n`)
      }
      return
    }
    switch (e.type) {
      case "message.delta":
        if (e.data.kind === "text") {
          io.stdout(e.data.text)
          endedWithNewline = e.data.text.endsWith("\n")
        } else if (e.data.kind === "serverTool" && e.data.block.status !== "running") {
          // The provider's own search: one line once it finished, as a tool call gets.
          if (searched.has(e.data.block.id)) break
          searched.add(e.data.block.id)
          if (!endedWithNewline) {
            io.stdout("\n")
            endedWithNewline = true
          }
          const failed = e.data.block.status === "failed" ? " (failed)" : ""
          io.stderr(`● ${describeServerTool(e.data.block)}${failed}\n`)
        }
        break
      case "message.end": {
        // The sources the reply cited, after it, with the reply.
        const sources = messageCitations(e.data.message.content)
        if (!sources.length) break
        const list = sources.map((s) => `- ${s.title ? `${s.title}: ` : ""}${s.url}`).join("\n")
        io.stdout(`${endedWithNewline ? "" : "\n"}\nSources:\n${list}\n`)
        endedWithNewline = true
        break
      }
      case "tool.execute.start":
        // Finish an unterminated line of reply text so the tool line starts on its own row.
        if (!endedWithNewline) {
          io.stdout("\n")
          endedWithNewline = true
        }
        io.stderr(`● ${e.data.name} ${summarizeArgs(e.data.args)}\n`)
        break
      case "tool.execute.end":
        if (e.data.result.isError) io.stderr(`  ✗ ${firstLine(e.data.result.content)}\n`)
        break
      case "compact.start":
        if (!endedWithNewline) {
          io.stdout("\n")
          endedWithNewline = true
        }
        io.stderr(`● compacting ${e.data.replacing} older messages\n`)
        break
      case "compact.end":
        io.stderr(
          e.data.native
            ? `● compacted ${e.data.replaced} older messages on the server (${e.data.native.provider})\n`
            : `● compacted ${e.data.replaced} older messages into a summary\n`,
        )
        break
      case "compact.failed":
        io.stderr(
          e.data.blocked
            ? `● compaction skipped: ${e.data.error}\n`
            : `  ✗ compaction failed: ${e.data.error}\n`,
        )
        break
      case "extension.error":
        io.stderr(`[extension ${e.data.source}] ${e.data.error}\n`)
        break
      case "extension.notice":
        io.stderr(
          e.data.level === "warning" || e.data.level === "error"
            ? `${e.data.level}: ${e.data.text}
`
            : `● ${e.data.text}
`,
        )
        break
      case "command.output":
        if (e.data.level === "info") io.stdout(`${e.data.text}\n`)
        else io.stderr(`${e.data.level}: ${e.data.text}\n`)
        break
      case "turn.end":
        if (!endedWithNewline) io.stdout("\n")
        // Later turns (woken by background results) start on a line of their own, once.
        endedWithNewline = true
        if (e.data.reason === "error") io.stderr(`error: ${e.data.error}\n`)
        if (e.data.reason === "aborted") io.stderr("aborted\n")
        break
    }
  }
  for (const e of opts.pending ?? []) handle(e)
  const off = agent.bus.subscribe(handle)
  opts.onReady?.()
  const initialBackgroundJobIds = new Set(opts.backgroundJobs?.list().map((job) => job.id))

  // First Ctrl+C aborts the turn; a second one exits immediately.
  let interrupted = false
  const forceExit = opts.forceExit ?? (() => process.exit(130))
  const onSigint = () => {
    if (interrupted) return forceExit()
    interrupted = true
    agent.abort()
  }
  process.on("SIGINT", onSigint)
  try {
    let code: number
    if (opts.commands && parseCommandLine(prompt)) {
      code = (await opts.commands.run(prompt, { frontend: "print" })).ok ? 0 : 1
    } else if (opts.commands?.skillLine(prompt)) {
      code = (await opts.commands.runSkill(prompt, { frontend: "print" })).ok ? 0 : 1
    } else {
      code = exitCode(await agent.prompt(prompt))
    }
    let jobs: JobWait = { waited: false, timedOut: false }
    if (code === 0 && opts.backgroundJobs) {
      jobs = await waitForBackgroundJobs(
        agent,
        opts.backgroundJobs,
        initialBackgroundJobIds,
        opts.backgroundJobTimeoutMs ?? DEFAULT_BACKGROUND_JOB_WAIT_MS,
        () => interrupted,
        io,
      )
    }
    if (code === 0 && jobs.timedOut && !interrupted) {
      // A follow-up turn may still be running: the note goes after it, as a turn of its own.
      while (agent.busy && !interrupted) await Bun.sleep(20)
      const notice = agent.expectNotice()
      notice.deliver(
        userMessage(
          "Top-level background jobs are still running and will be stopped when this print run exits. Decide how to finish without their results.",
          { text: "◆ top-level background jobs still running", origin: "job" },
        ),
        { wake: false },
      )
      const turn = agent.wake()
      if (turn) await turn
    }
    // Sub-agents still running in the background: wait for their results and the turns they
    // start, as long as those turns succeed. Ctrl+C stops waiting. The turns a job's end started
    // decide the exit code the same way.
    if (code === 0 && ((await backgroundTurns(agent, () => interrupted)) || jobs.waited)) {
      await agent.bus.flush()
      code = interrupted ? 130 : lastEnd ? exitCode(lastEnd) : code
    }
    const flushed = await Promise.race([
      agent.bus.flush().then(() => true),
      Bun.sleep(opts.flushTimeoutMs ?? 2000).then(() => false),
    ])
    if (!flushed) io.stderr("amira: some event handlers did not finish; exiting anyway\n")
    jsonFileOpen = false
    if (jsonFile)
      await finishJsonFile(jsonFile).catch((err: Error) => {
        jsonFileError ??= err
      })
    if (jsonFileError) {
      io.stderr(`amira: could not write ${opts.jsonOut}: ${jsonFileError.message}\n`)
      if (code === 0) code = 1
    }
    return code
  } finally {
    process.off("SIGINT", onSigint)
    off()
  }
}

/** Whether print mode waited for top-level jobs, and whether some outlived the wait. */
interface JobWait {
  waited: boolean
  timedOut: boolean
}

/**
 * Keeps the registry listener alive through the follow-up turn caused by a root job's notice.
 * The builtin job watcher delivers that notice with wake=false because interactive users see it;
 * print mode explicitly wakes the idle root so the model can handle it before the process exits.
 */
async function waitForBackgroundJobs(
  agent: Agent,
  registry: PrintBackgroundJobs,
  initialIds: ReadonlySet<string>,
  timeoutMs: number,
  stop: () => boolean,
  io: PrintIO,
): Promise<JobWait> {
  const rootIds = new Set<string>()
  const add = (job: BackgroundJobInfo) => {
    if (job.owner === undefined && !initialIds.has(job.id)) rootIds.add(job.id)
  }
  for (const job of registry.list()) add(job)
  if (!rootIds.size) return { waited: false, timedOut: false }

  let changed: (() => void) | undefined
  let signal: Promise<void> | undefined
  const wake = () => {
    changed?.()
    changed = undefined
    signal = undefined
  }
  const off = registry.subscribe(({ type, job }) => {
    if (type === "start") add(job)
    if (type === "end" && rootIds.has(job.id) && !agent.busy && agent.waitingNotices) agent.wake()
    wake()
  })
  const waitForChange = () => {
    signal ??= new Promise<void>((resolve) => {
      changed = resolve
    })
    return signal
  }
  const waitMs = Math.max(1, Math.floor(timeoutMs))
  const deadline = Date.now() + waitMs
  let noted = false
  try {
    while (!stop()) {
      for (const job of registry.list()) add(job)
      const live = registry
        .list()
        .some((job) => rootIds.has(job.id) && (job.status === "starting" || job.status === "running"))
      if (!live && !agent.busy && agent.waitingNotices) agent.wake()
      if (!live && !agent.busy && !agent.expectedNotices && !agent.waitingNotices)
        return { waited: true, timedOut: false }
      if (live && !noted) {
        noted = true
        io.stderr(`amira: waiting for top-level background jobs (up to ${waitMs} ms)\n`)
      }
      const left = deadline - Date.now()
      if (left <= 0) {
        if (live)
          io.stderr(
            `amira: timed out after ${waitMs} ms while top-level background jobs were still running; they will be stopped on exit\n`,
          )
        return { waited: true, timedOut: live }
      }
      await Promise.race([waitForChange(), Bun.sleep(Math.min(20, left))])
    }
    return { waited: true, timedOut: false }
  } finally {
    off()
  }
}

/**
 * Waits while the agent is busy, expects notices (background sub-agents' results) or will send
 * held ones again after a failed turn, until a turn fails for good or `stop()` says so. True when it waited for anything.
 */
export async function backgroundTurns(agent: Agent, stop: () => boolean): Promise<boolean> {
  let waited = false
  let failed = false
  const off = agent.bus.subscribe((e) => {
    // A failed turn ends the wait unless its notices are due to be sent again (at most 3 times).
    if (
      e.type === "turn.end" &&
      e.sessionId === agent.sessionId &&
      e.data.reason !== "done" &&
      !agent.noticeRetry
    )
      failed = true
  })
  try {
    while (!stop() && !failed && (agent.busy || agent.expectedNotices > 0 || agent.noticeRetry)) {
      waited = true
      await Bun.sleep(20)
    }
    return waited
  } finally {
    off()
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const s = Object.values(args)
    .filter((v) => typeof v === "string" || typeof v === "number")
    .join(" ")
    .replace(/\s+/g, " ")
  return s.length > 100 ? `${s.slice(0, 97)}...` : s
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

function firstLine(content: { type: string; text?: string }[]): string {
  const t = content.find((c) => c.type === "text")?.text ?? ""
  return t.split("\n")[0]!.slice(0, 200)
}

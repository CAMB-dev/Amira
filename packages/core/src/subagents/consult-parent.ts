import { type Ai, type AssistantMessage, type Usage, userMessage } from "@amira/ai"
import type { ApprovalRequest, AskAnswer, AskOutcome, AskQuestion, AskRequest } from "@amira/api"
import { copyAccountingUsage } from "../accounting-receipts.ts"
import { accountingRecorded, withAccountingRequests } from "../accounting-requests.ts"
import type { Agent, ApprovalDecision } from "../agent.ts"
import { withCallableServerTools } from "../callable-server-tools.ts"
import { renderPrompt } from "../prompt.ts"
import { consultationAccounting } from "./consultation-accounting.ts"
import type { ConsultationUsageRecorder } from "./consultation-usage.ts"
import { finalText, forkHistory } from "./fork.ts"

/** Answers children's approvals and questions with their parent's model, one at a time. */
export class ParentConsultant {
  /** The last physical model consultation queued for each parent, by its session id. */
  #asking = new Map<string, Promise<unknown>>()
  /** Admission reserves one physical permit per requester, not one per parallel tool call. */
  #requesting = new Map<string, Promise<unknown>>()
  /** Actual user questions have their own line, never reserving a parent's model stream. */
  #forwarding = new Map<string, Promise<unknown>>()

  constructor(
    private deps: {
      ai: Ai
      callableTools: (requester: string) => ReadonlySet<string> | undefined
      usageRecorder: (parent: Agent, requester: string) => ConsultationUsageRecorder
      acquire?: (requester: string, signal: AbortSignal) => Promise<() => void>
    },
  ) {}

  /**
   * D14: a child's interceptor approval request, answered by the parent's model (APPROVE/DENY).
   * One question to a parent at a time: each is a call with the parent's whole context, and
   * children asking together would otherwise start that many such calls at once.
   */
  approve(parent: Agent, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return this.#consultParent(parent, req, signal)
  }

  /**
   * A child's ask_user questions, answered by the parent's model, declined, or passed on (ASK_USER).
   * A child's questions (ask_user) go to its commander the same way, in the same line.
   */
  ask(parent: Agent, req: AskRequest, signal: AbortSignal): Promise<AskOutcome> {
    return this.#consultParentQuestions(parent, req, signal)
  }

  async #oneAtATime<T>(
    sessionId: string,
    signal: AbortSignal,
    aborted: T,
    ask: () => Promise<T>,
    line = this.#asking,
  ): Promise<T> {
    if (signal.aborted) return aborted
    const before = line.get(sessionId) ?? Promise.resolve()
    // One aborted while it waits for its place leaves at once. The physical-stream line
    // waits through model cleanup; the separate forwarding line waits through user replies.
    let onAbort: (() => void) | undefined
    const abandoned = new Promise<T>((resolve) => {
      onAbort = () => resolve(aborted)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    const inLine = before.then(() => {
      signal.removeEventListener("abort", onAbort!)
      return signal.aborted ? aborted : ask()
    })
    const mine = Promise.race([inLine, abandoned])
    // The next in line waits for actual callback cleanup, not only the waiting caller's abort.
    const tail = inLine.catch(() => {})
    line.set(sessionId, tail)
    // The line ends when its last one is really done: one that left early (aborted) is still
    // waiting on those before it, and whoever asks next must too.
    void tail.then(() => {
      if (line.get(sessionId) === tail) line.delete(sessionId)
    })
    try {
      return await mine
    } finally {
      signal.removeEventListener("abort", onAbort!)
    }
  }

  /**
   * The parent's model answers a child's questions like it decides its approvals (D14): with
   * its conversation, without tools. It may answer them, decline, or reply ASK_USER to pass
   * them on to whoever answers for itself (the user, or its own commander).
   */
  async #consultParentQuestions(parent: Agent, req: AskRequest, signal: AbortSignal): Promise<AskOutcome> {
    const reply = await this.#consult(parent, askParentPrompt(req), signal, req.sessionId)
    if (!reply.text) return { unavailable: `the commander could not answer: ${reply.failure ?? "no reply"}` }
    // The word on the first line, or alone on a line after some prose.
    const lines = reply.text.split("\n").map((l) => l.replace(/[*`\s.]/g, "").toUpperCase())
    const says = (word: string) => lines[0]?.startsWith(word) || lines.includes(word)
    if (says("ASK_USER")) {
      // An ancestor model escalation may wait for a descendant's admission permit.
      // Holding its forwarding line would block that descendant's own escalation.
      if (parent.depth > 0) return parent.askQuestions(req, signal)
      return this.#oneAtATime(
        parent.sessionId,
        signal,
        { declined: true },
        () => parent.askQuestions(req, signal),
        this.#forwarding,
      )
    }
    if (says("DECLINE")) return { declined: true, by: "the commander" }
    const answers = parseParentAnswers(req.questions, reply.text)
    return answers ? { answers, by: "the commander" } : { declined: true, by: "the commander" }
  }

  /** One call to the parent's model with its conversation and `question`, without tools. */
  async #consult(parent: Agent, question: string, signal: AbortSignal, requester: string) {
    if (parent.execution.paused) await parent.execution.wait(signal)
    if (signal.aborted) return { text: undefined, failure: "aborted" }
    let reply: AssistantMessage | undefined
    let failure: string | undefined
    const ai = withCallableServerTools(this.deps.ai, this.deps.callableTools(requester))
    // ToolRunner may finish an aborted child before the model's cleanup yields usage.
    // Capture the accounting owner while it is still live, only for this consultation.
    const model = parent.model
    const recordUsage = this.deps.usageRecorder(parent, requester)
    const accounting = consultationAccounting(recordUsage)
    let release: (() => void) | undefined
    let usage: Usage | undefined
    let retrying = false
    const record = () => {
      const finalUsage = usage
      usage = undefined
      if (finalUsage) recordUsage(finalUsage)
    }
    // Only an admitted requester may join the parent's physical-stream queue. Otherwise
    // an ancestor waiting for its descendant's slot can block that descendant's escalation.
    let streamOwnsPermit = false
    const stream = async () => {
      // Open the durable intent only at admitted dispatch, using the already captured owner.
      const accounted = accounting
        ? withAccountingRequests(ai, accounting.agent, () => accounting.target)
        : ai
      try {
        for await (const ev of accounted.stream(
          {
            model,
            systemPrompt: renderPrompt([...parent.sections]),
            // As the parent's own requests send its history (context management).
            messages: [...forkHistory(parent.projectedMessages()), userMessage(question)],
            tools: [],
          },
          signal,
        )) {
          // A backoff abort repeats the failed attempt's usage, not a new request's.
          // Dialects without request.start begin the retry with their next non-abort event.
          if (
            ev.type === "request.attempt" ||
            ev.type === "request.start" ||
            (retrying && ev.type !== "retry" && !(ev.type === "error" && ev.error.code === "aborted"))
          ) {
            record()
            retrying = false
          }
          if (ev.type === "retry" || ev.type === "fast.fallback") retrying = true
          if (ev.type === "done") reply = ev.message
          if (ev.type === "error") failure = ev.error.message
          if (ev.type === "done" || ev.type === "error" || ev.type === "request.end") {
            // Book completed spending before backoff/admission can allow more work.
            // Retain a copied final snapshot so abort/retry duplicates settle this attempt once.
            if (ev.message.usage) {
              usage = copyAccountingUsage(ev.message.usage)
              const retained = recordUsage.observe?.(usage)
              // An unchanged revision can reuse a committed contribution without a second charge.
              if (accounting && retained) accountingRecorded(accounting.agent, retained)
            }
          }
        }
      } catch (error) {
        // Settle every observed charge before retaining the unknown tail of a broken stream.
        record()
        usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          outputReported: false,
          pricingUnknown: true,
        }
        throw error
      } finally {
        try {
          record()
        } finally {
          release?.()
        }
      }
      return { text: reply ? finalText([reply]) : undefined, failure }
    }
    // Parallel calls by one requester must not reuse and release the same admission permit.
    return this.#oneAtATime(
      requester,
      signal,
      { text: undefined, failure: "aborted" },
      async () => {
        try {
          release = await this.deps.acquire?.(requester, signal)
          if (signal.aborted) return { text: undefined, failure: "aborted" }
          return await this.#oneAtATime(
            parent.sessionId,
            signal,
            { text: undefined, failure: "aborted" },
            async () => {
              // The parent may have paused after admission, while another consultation ran.
              // Recheck after waking too: resume followed by a new pause is still a hold.
              while (parent.execution.paused && !signal.aborted) await parent.execution.wait(signal)
              if (signal.aborted) return { text: undefined, failure: "aborted" }
              // The physical callback owns release, even if its caller abandons the queue wait.
              streamOwnsPermit = true
              return stream()
            },
          )
        } finally {
          // No stream started when admission or the parent-queue wait was aborted.
          if (!streamOwnsPermit) release?.()
        }
      },
      this.#requesting,
    )
  }

  /**
   * D14: a child's approval request goes to its parent's model, not to the user. It gets the
   * parent's conversation and the request, without tools, and must answer APPROVE or DENY.
   * Only interceptors' questions come here: the permission policy's go to the user (Agent).
   */
  async #consultParent(parent: Agent, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const args = JSON.stringify(req.args, null, 2)
    const question = [
      `A sub-agent you started (session ${req.sessionId}) wants to call the tool "${req.name}" and needs your approval.`,
      `Why it needs approval: ${req.reason}`,
      `Arguments:\n${args.length > 4000 ? `${args.slice(0, 4000)}\n[...]` : args}`,
      "Reply with APPROVE or DENY on the first line, then one short sentence with your reason.",
    ].join("\n\n")
    const { text, failure } = await this.#consult(parent, question, signal, req.sessionId)
    if (text === undefined)
      return { approved: false, reason: `the parent could not decide: ${failure ?? "no reply"}` }
    const verdict = /\b(APPROVE|DENY)\b/i.exec(text)?.[1]?.toUpperCase()
    const why = text.replace(/^[^\n]*\n?/, "").trim()
    return verdict === "APPROVE"
      ? { approved: true }
      : { approved: false, reason: `the parent agent denied it${why ? `: ${why}` : ""}` }
  }
}

/** A child's questions as its commander reads them, with how to answer. */
export function askParentPrompt(req: AskRequest): string {
  const questions = req.questions.map((q, i) => {
    const how = q.multiSelect ? "choose any number" : "choose one"
    const options = q.options.map((o) => `   - ${o.label}${o.description ? `: ${o.description}` : ""}`)
    return [`${i + 1}. ${q.header ? `[${q.header}] ` : ""}${q.question} (${how})`, ...options].join("\n")
  })
  return [
    `A sub-agent working for you (session ${req.sessionId}) asks you ${req.questions.length === 1 ? "this question" : "these questions"} before it goes on:`,
    questions.join("\n\n"),
    [
      'Answer with one line per question, numbered like the questions: "1: <option label>". Where several may be chosen, separate the labels with " | ". When no option fits, write your own answer instead of a label.',
      "If the user should decide instead, reply with ASK_USER alone on the first line, and the questions go to the user. To refuse to answer, reply with DECLINE on the first line.",
    ].join(" "),
  ].join("\n\n")
}

/** Case, spacing, quotes and a "(Recommended)" mark do not matter when matching a label. */
const labelKey = (s: string) =>
  s
    .replace(/\(recommended\)/i, "")
    .replace(/^[\s"'`*_]+|[\s"'`*_.]+$/g, "")
    .toLowerCase()

/**
 * The commander's numbered answers ("1: label", "2: a | b", or its own words) as one answer
 * per question; undefined when a question has none. A single question may be answered by the
 * whole reply.
 */
export function parseParentAnswers(questions: AskQuestion[], text: string): AskAnswer[] | undefined {
  const byNumber = new Map<number, string>()
  for (const line of text.split("\n")) {
    const m = /^\s*(?:\*\*)?(\d+)(?:\*\*)?\s*[:.)-]\s*(.+)$/.exec(line)
    if (m && !byNumber.has(Number(m[1]))) byNumber.set(Number(m[1]), m[2]!.trim())
  }
  if (questions.length === 1 && !byNumber.has(1) && text.trim()) byNumber.set(1, text.trim())
  const answers: AskAnswer[] = []
  for (const [i, q] of questions.entries()) {
    const reply = byNumber.get(i + 1)
    if (!reply) return undefined
    const labels = new Map(q.options.map((o) => [labelKey(o.label), o.label]))
    const whole = labels.get(labelKey(reply))
    if (whole) {
      answers.push({ selected: [whole] })
      continue
    }
    const parts = q.multiSelect ? reply.split("|").map((p) => p.trim()) : [reply]
    const selected = parts.map((p) => labels.get(labelKey(p))).filter((l): l is string => l !== undefined)
    const rest = parts.filter((p) => !labels.has(labelKey(p)))
    answers.push({ selected: [...new Set(selected)], ...(rest.length ? { other: rest.join(" | ") } : {}) })
  }
  return answers
}

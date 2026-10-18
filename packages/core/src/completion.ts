import type { Ai, AssistantMessage, ModelInfo, Usage } from "@amira/ai"
import type { CompleteRequest, CompleteResult } from "@amira/api"
import { accountingRecorded, requestAccountingTarget, withAccountingRequests } from "./accounting-requests.ts"
import type { Agent } from "./agent.ts"
import { recordConversationUsage } from "./owned-conversations-usage.ts"
import { overBudget } from "./subagents/budget.ts"
import { consultationUsageRecorder } from "./subagents/consultation-usage.ts"

/** Internal text-only completion; its caller owns exclusivity and cancellation/drain lifetime. */
export async function completeForAgent(options: {
  ai: Ai
  agent: Agent
  model: ModelInfo
  request: Omit<CompleteRequest, "model">
  signal?: AbortSignal
  label: string
  /** Only independently owned completions reserve a permit; unbound callers retain scheduling. */
  admission?: boolean
}): Promise<CompleteResult> {
  const { agent, model, request } = options
  const ai = withAccountingRequests(options.ai, agent, () => {
    const target = requestAccountingTarget(agent)
    return target.store ? target : { store: agent.session }
  })
  const signals = [options.signal, request.signal].filter((signal) => signal !== undefined)
  const callerSignal = AbortSignal.any(signals)
  const label = sideLabel(request.label) ?? options.label
  const sideModel = { ...model, caps: { ...model.caps, webSearch: false } }
  const run = async (signal: AbortSignal): Promise<CompleteResult> => {
    signal.throwIfAborted()
    const spent = agent.tree && (agent.tree.budgetExceeded ?? overBudget(agent.tree.usage, agent.tree.budget))
    if (spent) throw new Error(`the agent tree's budget is spent (${spent})`)
    const book = (usage: Usage) => {
      try {
        agent.session?.append({
          type: "side_usage",
          model: { provider: model.provider, model: model.id },
          usage,
          label,
        })
      } catch {
        // A failing disk must not hide the provider's reported spend from live accounting.
      }
      const source = { provider: model.provider, model: model.id }
      if (agent.tree) agent.tree.recordUsage(agent, usage, source)
      else recordConversationUsage(agent, usage, source)
      accountingRecorded(agent, usage)
    }
    const unknown = () =>
      book({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        outputReported: false,
        pricingUnknown: true,
      })
    let reported = false
    let settled = false
    let terminalFailure = false
    let failure: Error | undefined
    let backoff = false
    let dispatched = false
    let record = consultationUsageRecorder(book)
    const observe = (message: AssistantMessage) => {
      if (!message.usage) return
      reported = true
      const retained = record.observe?.(message.usage)
      if (retained) accountingRecorded(agent, retained)
    }
    const settle = () => {
      if (settled) return
      settled = true
      if (!reported) {
        // Metadata-only coverage marker, not an invented token count or a zero-dollar charge.
        unknown()
      }
    }
    const nextAttempt = () => {
      record = consultationUsageRecorder(book)
      reported = false
      settled = false
      backoff = false
    }
    try {
      let message: AssistantMessage | undefined
      for await (const event of ai.stream(
        {
          model: sideModel,
          systemPrompt: request.system ?? "",
          messages: request.messages,
          tools: [],
          ...sideMaxTokens(sideModel, request.maxTokens),
        },
        signal,
      )) {
        if (event.type === "retry" || event.type === "fast.fallback") {
          settle()
          backoff = true
          dispatched = false
          continue
        }
        if (event.type === "request.attempt") {
          if (backoff || dispatched) {
            settle()
            nextAttempt()
          }
          dispatched = true
          continue
        }
        // Backoff aborts repeat the preceding attempt's message, not a new provider receipt.
        const backoffAbort = backoff && event.type === "error" && event.error.code === "aborted"
        if (backoff && !backoffAbort) nextAttempt()
        if (event.type !== "request.end" && event.type !== "done" && event.type !== "error") continue
        const abortedAtReceipt = (signal.aborted && !message) || callerSignal.aborted
        if (!backoffAbort) observe(event.message)
        if (event.type === "request.end") continue
        settle()
        // Charge before surfacing errors/aborts. A successful terminal receipt may itself
        // exhaust the budget; that stops future work, not the reply that has already arrived.
        if (abortedAtReceipt || callerSignal.aborted) failure = abortError()
        if (event.type === "error") {
          const aborted = event.error.code === "aborted" || event.message.stopReason === "aborted"
          // A budget stop raised by this successful reply does not revoke the reply itself.
          if (!(aborted && message && signal.aborted && !callerSignal.aborted))
            failure ??= aborted ? abortError() : new Error(event.error.message)
        } else message = event.message
      }
      // Drain provider cleanup and any final receipts before surfacing terminal failures.
      if (callerSignal.aborted) failure = abortError()
      if (failure) {
        terminalFailure = true
        throw failure
      }
      if (!message) throw new Error("model request ended without a reply")
      return {
        text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
        message,
        ...(message.usage ? { usage: message.usage } : {}),
      }
    } catch (error) {
      if (!terminalFailure) {
        // An unexpected iterator/cleanup failure cannot certify an unreported attempt as free.
        if (reported || settled) unknown()
        else settle()
        settled = true
      }
      throw error
    } finally {
      settle()
    }
  }
  try {
    return await (options.admission && agent.tree
      ? agent.tree.runSide(agent, run, callerSignal)
      : run(callerSignal))
  } catch (error) {
    if (callerSignal.aborted || (error instanceof DOMException && error.name === "AbortError"))
      throw abortError()
    throw error
  }
}

/** Reasoning models spend their output budget thinking first; a small one would end before any answer. */
const SIDE_THINKING_TOKENS = 2048

function sideMaxTokens(model: ModelInfo, asked?: number): { maxTokens?: number } {
  if (!model.caps.thinking) return asked !== undefined ? { maxTokens: asked } : {}
  if (asked === undefined) return {}
  return { maxTokens: Math.max(asked, Math.min(SIDE_THINKING_TOKENS, model.maxOutput || Infinity)) }
}

/** What /cost calls a side request: one short line, independent of conversational history. */
function sideLabel(label: string | undefined): string | undefined {
  const clean = label
    ?.replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
  return clean || undefined
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError")
}

import {
  type Ai,
  type AssistantMessage,
  hasNativeWebSearch,
  type ModelInfo,
  type ModelRequest,
  NATIVE_WEB_SEARCH,
  type StreamEvent,
  type Usage,
} from "@amira/ai"
import type { CompleteRequest, CompleteResult } from "@amira/api"
import { accountingRecorded, requestAccountingTarget, withAccountingRequests } from "./accounting-requests.ts"
import type { Agent } from "./agent.ts"
import { offeredTools } from "./deferred-tools.ts"
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
  const { agent, request } = options
  // Decide retention against the same hosted-tool policy as normal conversation requests.
  const model =
    agent.callableTools && !agent.callableTools.has(NATIVE_WEB_SEARCH)
      ? { ...options.model, caps: { ...options.model.caps, webSearch: false } }
      : options.model
  const ai = withAccountingRequests(options.ai, agent, () => {
    const target = requestAccountingTarget(agent)
    return target.store ? target : { store: agent.session }
  })
  const signals = [options.signal, request.signal].filter((signal) => signal !== undefined)
  const callerSignal = AbortSignal.any(signals)
  const label = sideLabel(request.label) ?? options.label
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
    const keepTools =
      request.keepSessionTools === true &&
      model.caps.tools === "native" &&
      ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"].includes(model.dialect) &&
      // Gemini's NONE forbids functions, not hosted search; do not leave search enabled.
      !(model.dialect === "google-gemini" && hasNativeWebSearch(model))
    const tools = keepTools
      ? offeredTools(agent.tools, agent.loadedTools, (tool) => agent.toolRestriction(tool) === undefined)
      : []
    let toolsKept = tools.length > 0 || (keepTools && hasNativeWebSearch(model))
    const sideModel = toolsKept ? model : { ...model, caps: { ...model.caps, webSearch: false } }
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
      for await (const event of completionEvents(
        ai,
        {
          model: sideModel,
          systemPrompt: request.system ?? "",
          messages: request.messages,
          tools,
          ...(toolsKept ? { toolChoice: "none" as const } : {}),
          ...sideMaxTokens(sideModel, request.maxTokens),
        },
        signal,
      )) {
        if (event.type === "tools.stripped") {
          settle()
          const spent =
            agent.tree && (agent.tree.budgetExceeded ?? overBudget(agent.tree.usage, agent.tree.budget))
          if (signal.aborted || spent) {
            // No fallback was dispatched: the drained attempt's coverage is still complete.
            terminalFailure = true
            signal.throwIfAborted()
            throw new Error(`the agent tree's budget is spent (${spent})`)
          }
          toolsKept = false
          nextAttempt()
          dispatched = false
          continue
        }
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
        toolsKept,
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

/** Drain and account for a rejected no-calls request before trying once without definitions. */
async function* completionEvents(
  ai: Ai,
  request: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent | { type: "tools.stripped" }> {
  let strip = false
  for await (const event of ai.stream(request, signal)) {
    if (
      request.toolChoice === "none" &&
      event.type === "error" &&
      [400, 422, 501].includes(event.error.status ?? 0) &&
      /tool[_ .-]?choice|function[_ .-]?calling|toolconfig/i.test(event.error.message) &&
      event.message.content.length === 0
    ) {
      strip = true
      yield { type: "request.end", message: event.message }
    } else yield event
  }
  if (!strip) return
  yield { type: "tools.stripped" }
  const { toolChoice: _, ...stripped } = request
  yield* ai.stream(
    {
      ...stripped,
      model: { ...request.model, caps: { ...request.model.caps, webSearch: false } },
      tools: [],
    },
    signal,
  )
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

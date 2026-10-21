import {
  array,
  bool,
  integer,
  json,
  nil,
  number,
  object,
  record,
  text,
  union,
  enumeration as values,
} from "./base.ts"

export const reasoning = values("low", "medium", "high", "xhigh", "max")
export const modelRef = object({ provider: text, model: text })
export const signature = object({
  dialect: text,
  value: text,
  "host?": text,
  "provider?": text,
  "model?": text,
  "kind?": values("checkpoint", "webSearch"),
})
export const usage = object({
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  "outputReported?": bool,
  "reasoning?": number,
  "cost?": number,
  "pricingUnknown?": bool,
  "speed?": values("fast", "standard"),
  "serviceTier?": text,
  "webSearchRequests?": number,
  "webSearchCost?": number,
})
export const textBlock = object({
  type: values("text"),
  text,
  "citations?": array(object({ url: text, "title?": text, "start?": number, "end?": number })),
  "signature?": signature,
})
export const imageBlock = object({ type: values("image"), mimeType: text, data: text, "name?": text })
export const serverTool = object({
  type: values("serverTool"),
  id: text,
  name: text,
  input: record(json),
  status: values("running", "done", "failed"),
  "sources?": array(object({ url: text, "title?": text })),
  "searchEntryPoint?": object({ "renderedContent?": text, "sdkBlob?": text }),
  "signature?": signature,
})
export const display = object({
  text,
  "note?": text,
  "origin?": text,
  "notices?": array(object({ text, "status?": values("done", "failed", "stopped") })),
})
export const userMessage = object({
  role: values("user"),
  content: array(union(textBlock, imageBlock)),
  "display?": display,
})
export const assistantMessage = object({
  role: values("assistant"),
  content: array(
    union(
      textBlock,
      object({ type: values("thinking"), text, "redacted?": bool, "signature?": signature }),
      object({ type: values("toolCall"), id: text, name: text, args: record(json) }),
      serverTool,
    ),
  ),
  model: modelRef,
  "usage?": usage,
  "stopReason?": values("end", "toolUse", "maxTokens", "aborted", "error"),
})
export const toolMessage = object({
  role: values("toolResult"),
  toolCallId: text,
  toolName: text,
  content: array(union(textBlock, imageBlock)),
  isError: bool,
  "rejected?": values("blocked", "unknownTool", "invalidArgs", "aborted"),
  "details?": json,
})
export const message = union(userMessage, assistantMessage, toolMessage)
export const toolResult = object({
  content: array(union(textBlock, imageBlock)),
  "isError?": bool,
  "details?": json,
  "persistDetails?": bool,
})
export const modelCaps = object({
  tools: values("native", "none"),
  images: bool,
  thinking: bool,
  promptCache: bool,
  parallelToolCalls: bool,
  "webSearch?": bool,
})
const rates = { input: number, output: number, "cacheRead?": number, "cacheWrite?": number }
export const modelInfo = object({
  id: text,
  provider: text,
  dialect: text,
  contextWindow: number,
  "contextWindowSource?": values("settings", "catalog", "default"),
  maxOutput: number,
  "compat?": object({ "thinkingDisplay?": values("summarized", "omitted") }),
  caps: modelCaps,
  "fast?": union(
    values(false),
    object({ kind: values("anthropic-speed") }),
    object({ kind: values("service-tier"), value: text, "textOnly?": bool, "responseHeader?": text }),
  ),
  "cost?": object({
    ...rates,
    "webSearch?": number,
    "fast?": object({ ...rates, "maxInputTokens?": number }),
  }),
})
export const modelRequest = object({
  model: modelInfo,
  systemPrompt: text,
  messages: array(message),
  tools: array(object({ name: text, description: text, parameters: record(json) })),
  "toolChoice?": values("none"),
  "maxTokens?": number,
  "temperature?": number,
  "reasoning?": object({ effort: reasoning }),
  "promptCache?": bool,
  "fastMode?": bool,
  "forceStandard?": bool,
})
export const errorKind = values("auth", "rate", "server", "network", "context", "config", "other")
export const modelError = object({
  message: text,
  "status?": number,
  "code?": text,
  "kind?": errorKind,
  "host?": text,
  "retries?": number,
})
export const streamEvent = union(
  object({ type: values("start", "fast.fallback") }),
  object({ type: values("request.attempt"), id: text }),
  object({ type: values("request.start"), "thinkingDisplay?": values("summarized", "omitted", "raw") }),
  object({ type: values("request.end", "done"), message: assistantMessage }),
  object({ type: values("content.start", "thinking.start", "thinking.end"), "index?": integer }),
  object({ type: values("text.delta", "thinking.delta"), text }),
  object({ type: values("toolCall.delta"), id: text, "index?": integer, "name?": text, argsDelta: text }),
  object({
    type: values("error"),
    error: modelError,
    retryable: bool,
    message: assistantMessage,
    "retryAfterMs?": number,
  }),
  object({ type: values("serverTool"), block: serverTool }),
  object({ type: values("retry"), attempt: number, maxRetries: number, delayMs: number, error: modelError }),
)
const tried = array(object({ method: text, error: text, unsupported: bool }))
export const compactResult = union(
  object({
    ok: values(true),
    checkpoint: signature,
    "summary?": text,
    usage,
    "usageIncomplete?": bool,
    method: text,
    tried,
  }),
  object({
    ok: values(false),
    error: text,
    "failure?": modelError,
    usage,
    "usageIncomplete?": bool,
    tried,
    "aborted?": bool,
    "timedOut?": bool,
  }),
)
export const nullableMessage = union(message, nil)

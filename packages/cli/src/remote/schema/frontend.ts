import { array, bool, integer, nil, number, object, text, union, enumeration as values } from "./base.ts"
import { message, modelCaps, modelRef, reasoning, usage } from "./messages.ts"

export const budget = object({ "tokens?": number, "costUsd?": number })
export const compaction = {
  reason: values("threshold", "manual", "overflow"),
  "tokensBefore?": number,
  "tokensAfter?": number,
  "contextWindow?": number,
  "model?": modelRef,
  "native?": modelRef,
  "layout?": values("tail", "recent-user"),
  "fallback?": text,
}
export const frontendState = object({
  sessionId: text,
  cwd: text,
  "title?": text,
  resumed: bool,
  "updatedAt?": number,
  status: values("idle", "working", "blocked", "error"),
  model: object({ provider: text, id: text, contextWindow: number, "caps?": object({ "images?": bool }) }),
  "turnId?": text,
  "holdId?": text,
  "permissionMode?": text,
  "thinking?": text,
  "fastMode?": object({ requested: bool, applied: bool }),
  "contextTokens?": number,
  children: number,
})
export const transcript = object({
  messages: array(
    object({
      id: text,
      "entryId?": text,
      "turnId?": text,
      message,
      "ts?": number,
      "compaction?": object(compaction),
    }),
  ),
  displays: array(
    object({
      id: text,
      before: number,
      level: values("info", "success", "warning", "error"),
      text,
      options: object({ "details?": text, "markdown?": bool }),
    }),
  ),
})
export const snapshot = object({ sessionGeneration: integer, state: frontendState, transcript })
export const update = union(
  object({ kind: values("snapshot"), snapshot, "reset?": bool }),
  object({ kind: values("error"), error: object({ code: values("invalid_snapshot"), message: text }) }),
)
export const acknowledgement = object({ sessionGeneration: integer })
export const commandOutcome = object({
  ok: bool,
  "command?": text,
  output: array(text),
  "error?": text,
  "effectWatermark?": integer,
})
export const rewindPlan = object({
  owner: text,
  enabled: bool,
  restored: number,
  removed: number,
  conflicts: array(text),
  note: text,
})
export const sessionInfo = object({
  id: text,
  "title?": text,
  cwd: text,
  model: modelRef,
  "supportsThinking?": bool,
  "thinkingLevel?": reasoning,
  "thinking?": reasoning,
  "fastMode?": object({
    requested: bool,
    applied: bool,
    "used?": text,
    "pricingUnknown?": bool,
    "unavailableReason?": text,
  }),
  contextWindow: number,
  "contextWindowSource?": values("settings", "provider", "catalog", "default"),
  "contextTokens?": number,
  "file?": text,
  busy: bool,
  shell: values("auto", "bash", "powershell"),
  "permissions?": object({ mode: values("plan", "edits", "auto"), rules: number }),
})
export const subagent = object({
  id: text,
  parentSessionId: text,
  depth: number,
  role: text,
  title: text,
  "toolCallId?": text,
  task: text,
  status: values("queued", "running", "idle", "paused", "done", "error", "aborted"),
  "model?": modelRef,
  "startedAt?": number,
  "durationMs?": number,
  usage,
  "error?": text,
  "note?": text,
  "persistent?": bool,
  "turns?": number,
  "groupId?": text,
})
export const storedSession = object({
  id: text,
  cwd: text,
  createdAt: number,
  updatedAt: number,
  messages: array(message),
  subagents: array(subagent),
})
export const sessionList = object({
  sessions: array(
    object({
      id: text,
      "title?": text,
      "searchText?": text,
      updatedAt: number,
      firstUserText: text,
      messageCount: number,
    }),
  ),
  "nextOffset?": integer,
})
export const serverModels = array(
  object({
    ref: text,
    available: bool,
    provider: text,
    id: text,
    contextWindow: number,
    maxOutput: number,
    caps: modelCaps,
  }),
)
export const status = object({
  info: sessionInfo,
  items: array(
    object({
      id: text,
      align: values("left", "right"),
      tone: values("default", "muted", "accent", "success", "warning", "error"),
      priority: number,
      text,
    }),
  ),
  usage,
  "budget?": budget,
})
export const serverEffect = union(
  object({ kind: values("detach", "rewind", "unfocus"), "invocationId?": text }),
  object({
    kind: values("view"),
    view: values("background-job", "subagent"),
    id: text,
    "invocationId?": text,
  }),
  object({ kind: values("focus"), conversationId: text, incarnation: text, "invocationId?": text }),
)
export const nullableStoredSession = union(storedSession, nil)

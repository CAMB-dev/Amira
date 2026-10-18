import type { StreamEvent } from "@amira/ai"
import type { EventMap } from "@amira/api"
import type { RemoteJson } from "../../src/remote/protocol.ts"
import { assistant, usage, user } from "./schema-fixtures.ts"

const ref = { provider: "mock", model: "test" }
const result = {
  content: [{ type: "text", text: "result" }],
  details: { arbitraryToolMetadata: [1, true, null] },
} satisfies EventMap["tool.execute.end"]["result"]
const group = {
  id: "g1",
  name: "group",
  parentSessionId: "s1",
  state: "active",
  limits: {},
  usage,
  tokens: 3,
  agents: { total: 1, queued: 0, working: 1, idle: 0, ended: 0 },
} satisfies EventMap["group.start"]["group"]
export const eventFixtures = {
  "session.start": { reason: "startup", cwd: "/srv/project", model: ref },
  "workspace.changed": { cwd: "/srv/project", branch: "main", dirty: false },
  "session.title": { title: "Title" },
  "session.end": { reason: "exit" },
  "status.changed": { status: "working" },
  "turn.start": { prompt: user },
  "turn.end": { reason: "done", steps: 1 },
  "model.retry": { attempt: 1, maxRetries: 2, delayMs: 1, error: "retry", kind: "network" },
  "turn.steer": { message: user, state: "promoted", nextTurnId: "t2" },
  "message.start": { model: ref },
  "message.stream": { kind: "request", thinkingDisplay: "raw" },
  "message.delta": { kind: "toolCall", toolCallId: "call-1", index: 0, argsDelta: "{}" },
  "message.end": { message: assistant },
  "tool.execute.start": {
    toolCallId: "call-1",
    name: "read",
    args: { path: "/srv/a" },
    traits: { readOnly: true },
  },
  "tool.execute.update": { toolCallId: "call-1", name: "read", partial: result },
  "tool.execute.end": { toolCallId: "call-1", name: "read", result, durationMs: 1, approval: "user" },
  "extension.loaded": { source: "builtin" },
  "extension.error": { source: "builtin", error: "error" },
  "extension.notice": { source: "builtin", text: "notice", level: "warning" },
  "ui.render": {},
  "events.lost": { dropped: 1 },
  "ui.request": {
    requestId: "q1",
    source: "builtin",
    sourceLabel: "Builtin",
    kind: "form",
    title: "Form",
    fields: [
      {
        type: "action",
        id: "load",
        label: "Load",
        auto: { watch: ["name", { field: "name", when: { ready: true } }] },
      },
    ],
  },
  "ui.resolved": { requestId: "q1", cancelled: false },
  "ui.focus": { focused: true },
  "ui.progress": {
    requestId: "q1",
    action: "load",
    text: "loading",
    form: { result: { message: "retry", tone: "warning" }, errors: { name: "missing" } },
  },
  "ui.waiting": { pending: 1, hidden: false, change: "opened" },
  "model.changed": { from: ref, to: ref },
  "thinking.changed": { thinking: "high" },
  "compact.start": { reason: "manual", replacing: 2, kept: 1 },
  "compact.end": { summary: "summary", replaced: 2, kept: 1, reason: "manual", usage },
  "compact.failed": { error: "failed", blocked: true, usage },
  "command.output": { command: "status", text: "status output", level: "info" },
  "subagent.start": {
    childSessionId: "c1",
    prompt: "task",
    model: ref,
    depth: 1,
    cwd: "/srv/project",
    context: "fresh",
    queued: true,
  },
  "subagent.end": { childSessionId: "c1", status: "done", usage, durationMs: 1 },
  "subagent.state": { childSessionId: "c1", state: "paused", turns: 1 },
  "group.start": { group },
  "group.update": { group },
  "group.end": { group: { ...group, state: "ended" } },
  "budget.update": { tokens: 3, costUsd: 0, limit: { tokens: 100 } },
  "budget.exceeded": { tokens: 3, limit: { tokens: 2 } },
  "notice.retry": { attempt: 1, attempts: 3, delayMs: 1 },
} satisfies { [K in keyof EventMap]: EventMap[K] & Record<string, RemoteJson> }
const streamData = {
  start: { type: "start" },
  "request.attempt": { type: "request.attempt", id: "a1" },
  "request.start": { type: "request.start", thinkingDisplay: "raw" },
  "request.end": { type: "request.end", message: assistant },
  "fast.fallback": { type: "fast.fallback" },
  "content.start": { type: "content.start", index: 0 },
  "text.delta": { type: "text.delta", text: "text" },
  "thinking.start": { type: "thinking.start", index: 0 },
  "thinking.delta": { type: "thinking.delta", text: "thinking" },
  "thinking.end": { type: "thinking.end", index: 0 },
  "toolCall.delta": { type: "toolCall.delta", id: "call-1", index: 0, name: "read", argsDelta: "{}" },
  done: { type: "done", message: assistant },
  error: {
    type: "error",
    error: { message: "unavailable", kind: "network" },
    retryable: false,
    message: assistant,
  },
  serverTool: {
    type: "serverTool",
    block: {
      type: "serverTool",
      id: "web-1",
      name: "web_search",
      input: { query: "test" },
      status: "done",
      signature: { dialect: "mock", value: "receipt" },
    },
  },
  retry: {
    type: "retry",
    attempt: 1,
    maxRetries: 3,
    delayMs: 1,
    error: { message: "retry", kind: "network" },
  },
} satisfies { [K in StreamEvent["type"]]: Extract<StreamEvent, { type: K }> }
export const streamFixtures = Object.values(streamData)
export const allStreamTypesCovered: Exclude<StreamEvent["type"], keyof typeof streamData> extends never
  ? true
  : false = true

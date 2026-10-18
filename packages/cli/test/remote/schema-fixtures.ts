import type {
  AssistantMessage,
  ImageBlock,
  ModelCaps,
  ModelInfo,
  ModelRequest,
  TextBlock,
  Usage,
  UserMessage,
} from "@amira/ai"
import type { FrontendOperations, FrontendSnapshot, FrontendState, FrontendTranscript } from "@amira/core"
import type { RemoteJson, RemoteOperation } from "../../src/remote/protocol.ts"
import type { ServerOperations } from "../../src/server/operations.ts"

export const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } satisfies Usage
export const caps = {
  tools: "native",
  images: true,
  thinking: true,
  promptCache: true,
  parallelToolCalls: true,
} satisfies ModelCaps
export const model = {
  id: "test",
  provider: "mock",
  dialect: "mock",
  contextWindow: 1000,
  maxOutput: 100,
  caps,
} satisfies ModelInfo
const textContent = { type: "text", text: "hello" } satisfies TextBlock
const imageContent = {
  type: "image",
  mimeType: "image/png",
  name: "image.png",
  data: "aA==",
} satisfies ImageBlock
export const user = {
  role: "user",
  content: [textContent, imageContent],
  display: { text: "hello", notices: [{ text: "loaded", status: "done" }] },
} satisfies UserMessage
export const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "hello", signature: { dialect: "mock", value: "signature" } }],
  model: { provider: "mock", model: "test" },
  usage,
} satisfies AssistantMessage
export const state = {
  sessionId: "s1",
  cwd: "/srv/世界",
  resumed: false,
  status: "idle",
  model: { provider: "mock", id: "test", contextWindow: 1000 },
  children: 0,
} satisfies FrontendState
export const transcript = {
  messages: [{ id: "m1", message: user }],
  displays: [{ id: "d1", before: 0, level: "info", text: "notice", options: {} }],
} satisfies FrontendTranscript
export const snapshot = { sessionGeneration: 1, state, transcript } satisfies FrontendSnapshot
const ack = { sessionGeneration: 1 }
const command = { ok: true, output: ["command complete"] }
const draft = {
  editor: "e1",
  revision: 1,
  values: { name: "example", enabled: true, count: 1, choice: ["a"] },
}
const history = {
  id: "s1",
  cwd: "/srv/世界",
  createdAt: 1,
  updatedAt: 2,
  messages: [user, assistant],
  subagents: [],
}
export const modelParams = {
  request: {
    model,
    systemPrompt: "system",
    messages: [user],
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
  },
} satisfies { request: ModelRequest }
interface Fixture {
  params: Record<string, RemoteJson>
  result: RemoteJson
  invalidParams: unknown[]
  invalidResults: unknown[]
}
type HostOperations = FrontendOperations & ServerOperations
type OperationFixtures = {
  [K in RemoteOperation]: Fixture &
    (K extends keyof HostOperations
      ? {
          params: HostOperations[K]["params"]
          result: HostOperations[K]["result"]
        }
      : unknown)
}

/** Deliberate valid and invalid payloads per operation, not a permissive empty-object smoke. */
export const operationFixtures = {
  "state.read": {
    params: {},
    result: state,
    invalidParams: [{ unexpected: true }],
    invalidResults: [
      { ...state, status: "unknown" },
      { ...state, model: {} },
    ],
  },
  "transcript.read": {
    params: {},
    result: transcript,
    invalidParams: [{ unexpected: true }],
    invalidResults: [{ messages: [], displays: "wrong" }],
  },
  "turn.prompt": {
    params: { message: user },
    result: ack,
    invalidParams: [{}, { message: { role: "assistant", content: [] } }, { message: false }],
    invalidResults: [{}],
  },
  "turn.steer": {
    params: { message: user, expectedIdle: true },
    result: ack,
    invalidParams: [{}, { message: "hi", expectedIdle: "true" }],
    invalidResults: [{ sessionGeneration: -1 }],
  },
  "turn.abort": {
    params: { turnId: "t1" },
    result: ack,
    invalidParams: [{ turnId: 1 }],
    invalidResults: [{ sessionGeneration: "1" }],
  },
  "command.run": {
    params: { line: "/status", keys: [{ keys: "Esc", description: "Abort" }] },
    result: command,
    invalidParams: [{}, { line: 1 }, { line: "/status", keys: [{ key: "Esc", label: "Abort" }] }],
    invalidResults: [{ ok: true, output: [1] }],
  },
  "skill.run": {
    params: { line: "$review" },
    result: command,
    invalidParams: [{ line: false }],
    invalidResults: [{ output: [] }],
  },
  "input.run": {
    params: { line: "input", glyphs: { separator: "-", more: "+" } },
    result: command,
    invalidParams: [{ line: "input", glyphs: {} }],
    invalidResults: [{ ok: "true", output: [] }],
  },
  "session.resume": {
    params: { id: "s1" },
    result: ack,
    invalidParams: [{}, { id: 1 }],
    invalidResults: [{ sessionGeneration: false }],
  },
  "session.clear": {
    params: {},
    result: ack,
    invalidParams: [{ id: "s1" }],
    invalidResults: [{ sessionGeneration: null }],
  },
  "session.fork": {
    params: { index: 1 },
    result: ack,
    invalidParams: [{}, { index: 1.5 }],
    invalidResults: [null],
  },
  "session.rewind": {
    params: { index: 0, restoreFiles: false },
    result: ack,
    invalidParams: [{ index: 0, restoreFiles: "false" }],
    invalidResults: [{ sessionGeneration: 1.5 }],
  },
  "session.planRewind": {
    params: { index: 0 },
    result: { owner: "core", enabled: true, restored: 1, removed: 0, conflicts: [], note: "checkpoint" },
    invalidParams: [{ index: "0" }],
    invalidResults: [{ owner: "core" }],
  },
  "conversation.send": {
    params: { conversationId: "c1", incarnation: "i1", message: user },
    result: ack,
    invalidParams: [{ conversationId: "c1", message: "hi" }],
    invalidResults: [false],
  },
  "conversation.stop": {
    params: { conversationId: "c1", incarnation: "i1", reason: "stop" },
    result: ack,
    invalidParams: [{ conversationId: "c1", incarnation: 1 }],
    invalidResults: [true],
  },
  "sessions.list": {
    params: { offset: 0, limit: 50 },
    result: { sessions: [{ id: "s1", updatedAt: 1, firstUserText: "hi", messageCount: 1 }] },
    invalidParams: [{ offset: -1 }, { limit: 101 }],
    invalidResults: [{ sessions: [{ id: "s1" }] }],
  },
  "sessions.read": {
    params: { id: "s1" },
    result: history,
    invalidParams: [{ id: false }],
    invalidResults: [{ ...history, subagents: [{}] }],
  },
  "models.list": {
    params: {},
    result: [
      {
        ref: "mock/test",
        available: true,
        provider: "mock",
        id: "test",
        contextWindow: 1000,
        maxOutput: 100,
        caps,
      },
    ],
    invalidParams: [{ all: true }],
    invalidResults: [{ models: [] }, [{ ref: "mock/test" }]],
  },
  "model.set": {
    params: { model: "mock/test" },
    result: ack,
    invalidParams: [{}, { model: {} }],
    invalidResults: [1],
  },
  "thinking.set": {
    params: { level: "high" },
    result: ack,
    invalidParams: [{ level: "not-an-effort" }],
    invalidResults: [{ sessionGeneration: "1" }],
  },
  "fastMode.set": {
    params: { enabled: false },
    result: ack,
    invalidParams: [{ enabled: "false" }, { enabled: false, extra: true }],
    invalidResults: [{}],
  },
  "status.read": {
    params: {},
    result: {
      info: {
        id: "s1",
        cwd: "/srv/世界",
        model: { provider: "mock", model: "test" },
        contextWindow: 1000,
        busy: false,
        shell: "auto",
        fastMode: { requested: false, applied: false },
      },
      items: [{ id: "model", align: "left", tone: "default", priority: 1, text: "mock/test" }],
      usage,
    },
    invalidParams: [{ scope: "all" }],
    invalidResults: [
      { info: {}, items: [], usage },
      { info: { id: "s1" }, items: [], usage },
    ],
  },
  "ui.respond": {
    params: { requestId: "q1", value: { other: "instead" } },
    result: { status: "accepted" },
    invalidParams: [{ requestId: "q1" }, { requestId: "q1", value: { other: "instead", extra: true } }],
    invalidResults: [{ status: "invalid" }, { status: "unknown" }],
  },
  "ui.cancel": {
    params: { requestId: "q1" },
    result: { status: "cancelled" },
    invalidParams: [{ requestId: 1 }],
    invalidResults: [{ status: "cancelled", value: true }],
  },
  "form.open": {
    params: { requestId: "q1" },
    result: { editor: "e1", revision: 1 },
    invalidParams: [{}],
    invalidResults: [{ editor: "e1", revision: -1 }],
  },
  "form.evaluate": {
    params: { requestId: "q1", draft: { ...draft, previous: {} } },
    result: { revision: 1, errors: {}, visible: { name: true }, preview: [], autoActions: [], change: {} },
    invalidParams: [{ requestId: "q1", draft: { revision: 1, values: { bad: null } } }],
    invalidResults: [
      { revision: 1, errors: {}, visible: { name: "yes" }, preview: [], autoActions: [], change: {} },
    ],
  },
  "form.action": {
    params: { requestId: "q1", draft: { ...draft, action: "load", automatic: false } },
    result: { revision: 1, status: "accepted", result: { tone: "success", values: { name: "loaded" } } },
    invalidParams: [{ requestId: "q1", draft }],
    invalidResults: [{ revision: 1, status: "accepted", result: { tone: "bad" } }],
  },
  "form.submit": {
    params: { requestId: "q1", draft },
    result: { revision: 1, status: "accepted" },
    invalidParams: [{ requestId: "q1", draft: { values: {} } }],
    invalidResults: [{ revision: 1, status: "unknown" }],
  },
  "form.cancel": {
    params: { requestId: "q1", editor: "e1", revision: 1 },
    result: { status: "settled" },
    invalidParams: [{ requestId: "q1", revision: "1" }],
    invalidResults: [{ status: "settled", message: 1 }],
  },
  "model.stream": {
    params: modelParams,
    result: { accepted: true },
    invalidParams: [{ messages: [] }, { request: { ...modelParams.request, tools: [{ name: "read" }] } }],
    invalidResults: [{ accepted: false }],
  },
  "model.compact": {
    params: modelParams,
    result: { ok: false, error: "unsupported", usage, tried: [] },
    invalidParams: [{ request: { ...modelParams.request, reasoning: { effort: "unknown" } } }],
    invalidResults: [{ ok: true }, { ok: false, error: "bad", usage: {}, tried: [] }],
  },
} satisfies OperationFixtures

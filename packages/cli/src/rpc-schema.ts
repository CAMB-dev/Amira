import type { EventMap } from "@amira/api"

type Schema = Record<string, unknown>

const str: Schema = { type: "string" }
const num: Schema = { type: "number" }
const bool: Schema = { type: "boolean" }
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` })
const oneOf = (...schemas: Schema[]): Schema => ({ oneOf: schemas })
const strings = (...values: string[]): Schema => ({ enum: values })
const arrayOf = (items: Schema): Schema => ({ type: "array", items })

/** An object with these properties; keys ending in "?" are optional. */
function obj(props: Record<string, Schema>, description?: string): Schema {
  const properties: Record<string, Schema> = {}
  const required: string[] = []
  for (const [key, schema] of Object.entries(props)) {
    const optional = key.endsWith("?")
    const name = optional ? key.slice(0, -1) : key
    properties[name] = schema
    if (!optional) required.push(name)
  }
  return { type: "object", ...(description ? { description } : {}), properties, required }
}

/** Parameters of every command, besides `id` and `cmd`. */
export const COMMAND_PARAMS = {
  prompt: {
    description:
      "Starts a turn. Answered at once with the new turnId, before the turn runs; fails with `busy` while a turn runs.",
    params: {
      text: str,
      "attachments?": {
        ...arrayOf(oneOf(ref("TextBlock"), ref("ImageBlock"))),
        description: "Sent after text.",
      },
    },
  },
  steer: {
    description:
      "Adds a message to the running turn before its next model call, without interrupting a tool. With no turn running it starts one.",
    params: { text: str },
  },
  abort: { description: "Aborts the running turn; it still ends with turn.end.", params: {} },
  "ui.respond": {
    description:
      "Answers a ui.request. `value` is required; an explicit null cancels the dialog, and a missing value fails with `invalid_params`.",
    params: { requestId: str, value: { type: ["string", "boolean", "null"] } },
  },
  "session.read": {
    description: "Reads the conversation: the last turn, or every message.",
    params: { what: strings("lastTurn", "messages") },
  },
  "model.set": {
    description: 'Switches the model, as "provider/model". Fails with `busy` while a turn runs.',
    params: { model: str },
  },
  state: { description: "A snapshot to resync from, e.g. after events.lost.", params: {} },
  "session.resume": {
    description:
      "Switches to a stored session of this directory (its id from session.start or `amira -r`), keeping the current model; a session.start with reason resume follows. Fails with `not_found` for an unknown id and `busy` while a turn runs.",
    params: { sessionId: str },
  },
  "command.list": { description: "Lists the slash commands.", params: {} },
  "command.complete": {
    description:
      'Candidates for a command line typed so far, e.g. "/mo" or "/model deep": command names while the name is typed, then the command\'s argument candidates. Prefix matches come first, then fuzzy ones.',
    params: { text: str },
  },
  "command.run": {
    description:
      'Runs a slash command line such as "/status" or "/model deepseek/deepseek-flash". What it prints also arrives as command.output events, and its dialogs as ui.request, which later lines may answer while it runs. Fails with `not_found` for an unknown command and `command_failed` when it throws.',
    params: { text: str },
  },
} satisfies Record<string, { description: string; params: Record<string, Schema> }>

const RESULTS: Record<keyof typeof COMMAND_PARAMS, Record<string, Schema>> = {
  prompt: { turnId: str },
  steer: { "turnId?": str, queued: { ...bool, description: "False when the message started a new turn." } },
  abort: { aborted: bool },
  "ui.respond": {},
  "session.read": {
    "messages?": arrayOf(ref("Message")),
    "turnId?": str,
    "reason?": strings("done", "error", "aborted"),
    "error?": str,
    "text?": { ...str, description: "The last assistant text of the turn." },
  },
  "model.set": { model: str },
  state: {
    status: strings("idle", "working", "blocked", "error"),
    model: str,
    sessionId: str,
    "turnId?": str,
    messages: { ...num, description: "Number of messages in the history." },
    "lastAssistantText?": str,
    uiRequests: { ...arrayOf(ref("UiRequest")), description: "Dialogs still waiting for ui.respond." },
  },
  "session.resume": { sessionId: str },
  "command.list": {
    commands: arrayOf(obj({ name: str, description: str, "hint?": str, source: str })),
  },
  "command.complete": {
    "command?": { ...str, description: "The command whose arguments are being completed." },
    candidates: arrayOf(obj({ value: str, "description?": str })),
  },
  "command.run": {
    command: str,
    output: { ...arrayOf(str), description: "Everything the command printed, in order." },
  },
}

const modelRef = obj({ provider: str, model: str })
const toolResult = obj({
  content: arrayOf(oneOf(ref("TextBlock"), ref("ImageBlock"))),
  "isError?": bool,
  "details?": {},
})

const EVENT_DATA: Partial<Record<keyof EventMap, Schema>> = {
  "session.start": obj({
    reason: strings("startup", "resume", "fork", "clear"),
    cwd: str,
    model: modelRef,
    "sessionFile?": str,
    "resume?": arrayOf(str),
  }),
  "workspace.changed": obj({ cwd: str, "repoRoot?": str, "branch?": str, "head?": str, "isWorktree?": bool }),
  "session.end": obj({ reason: strings("exit", "error") }),
  "status.changed": obj({
    status: strings("idle", "working", "blocked", "error"),
    "reason?": str,
    "pending?": num,
  }),
  "turn.start": obj({ prompt: ref("UserMessage") }),
  "turn.end": obj({ reason: strings("done", "error", "aborted"), "error?": str, steps: num }),
  "turn.steer": oneOf(
    obj({ message: ref("UserMessage"), state: strings("queued", "injected", "dropped") }),
    obj(
      { message: ref("UserMessage"), state: strings("promoted"), nextTurnId: str },
      "The turn ended before the message reached it. Every promoted message of a turn starts nextTurnId together; that turn's prompt is their content concatenated in order.",
    ),
  ),
  "message.start": obj({ model: modelRef, "contextWindow?": num }),
  "message.delta": oneOf(
    obj({ kind: strings("text"), text: str }),
    obj({ kind: strings("thinking"), text: str }),
    obj({ kind: strings("toolCall"), toolCallId: str, "index?": num, "name?": str, argsDelta: str }),
  ),
  "message.end": obj({ message: ref("AssistantMessage") }),
  "tool.execute.start": obj({ toolCallId: str, name: str, args: { type: "object" } }),
  "tool.execute.update": obj({ toolCallId: str, name: str, partial: toolResult }),
  "tool.execute.end": obj({
    toolCallId: str,
    name: str,
    result: toolResult,
    durationMs: num,
    "rejected?": strings("blocked", "unknownTool", "invalidArgs", "aborted"),
  }),
  "extension.loaded": obj({ source: str }),
  "extension.error": obj({ source: str, error: str }),
  "ui.render": obj({}),
  "events.lost": obj({ dropped: num }),
  "ui.request": { allOf: [ref("UiRequest"), obj({ requestId: str, "source?": str })] },
  "ui.resolved": obj({ requestId: str, cancelled: bool, "value?": { type: ["string", "boolean"] } }),
  "model.changed": obj({ from: modelRef, to: modelRef }),
  "compact.start": obj({
    reason: strings("threshold", "manual"),
    replacing: num,
    kept: num,
    "tokens?": num,
  }),
  "compact.end": obj({ summary: str, replaced: num, kept: num }),
  "compact.failed": obj({ error: str, "blocked?": bool }),
  "command.output": obj({ command: str, text: str, level: strings("info", "warning", "error") }),
}

const envelope = (type: Schema, data: Schema): Schema =>
  obj({ seq: num, ts: num, sessionId: str, "parentSessionId?": str, "turnId?": str, type, data })

/** The JSON Schema printed by `amira --rpc-schema`. */
export function rpcSchema(): Schema {
  const commands = Object.entries(COMMAND_PARAMS).map(([cmd, c]) =>
    obj({ "id?": ref("Id"), cmd: strings(cmd), ...(c.params as Record<string, Schema>) }, c.description),
  )
  const results = Object.entries(RESULTS).map(([cmd, props]) =>
    obj({ id: ref("Id"), ok: { const: true }, ...props }, `Answer to ${cmd}.`),
  )
  const events = Object.entries(EVENT_DATA).map(([type, data]) => envelope(strings(type), data))
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "amira --rpc",
    description:
      "stdin takes one command per line; stdout carries one response or event per line. Responses have `id` and `ok`; events are EventEnvelope objects with `seq` and `type`. Clients should ignore event types they do not know.",
    $defs: {
      Id: {
        type: ["string", "number", "null"],
        description: "Echoed in the response; null when unreadable.",
      },
      Command: oneOf(...commands),
      Response: oneOf(
        ...results,
        obj({
          id: ref("Id"),
          ok: { const: false },
          error: obj({
            code: strings(
              "parse_error",
              "invalid_request",
              "unknown_command",
              "invalid_params",
              "busy",
              "not_found",
              "not_supported",
              "command_failed",
              "internal",
            ),
            message: str,
          }),
        }),
      ),
      Event: {
        anyOf: [...events, envelope(str, {})],
        description: "Known events first; newer versions may add event types.",
      },
      TextBlock: obj({ type: strings("text"), text: str }),
      ImageBlock: obj({ type: strings("image"), mimeType: str, data: { ...str, description: "base64" } }),
      UserMessage: obj({
        role: strings("user"),
        content: arrayOf(oneOf(ref("TextBlock"), ref("ImageBlock"))),
      }),
      AssistantMessage: obj({
        role: strings("assistant"),
        content: arrayOf(
          oneOf(
            ref("TextBlock"),
            obj({ type: strings("thinking"), text: str, "redacted?": bool }),
            obj({ type: strings("toolCall"), id: str, name: str, args: { type: "object" } }),
          ),
        ),
        model: modelRef,
        "stopReason?": strings("end", "toolUse", "maxTokens", "aborted", "error"),
      }),
      ToolResultMessage: obj({
        role: strings("toolResult"),
        toolCallId: str,
        toolName: str,
        content: arrayOf(oneOf(ref("TextBlock"), ref("ImageBlock"))),
        isError: bool,
      }),
      Message: oneOf(ref("UserMessage"), ref("AssistantMessage"), ref("ToolResultMessage")),
      UiRequest: oneOf(
        obj({ kind: strings("select"), title: str, options: arrayOf(str) }),
        obj({ kind: strings("confirm"), title: str, "message?": str }),
        obj({ kind: strings("input"), title: str, "placeholder?": str, "initial?": str }),
      ),
    },
    oneOf: [ref("Command"), ref("Response"), ref("Event")],
  }
}

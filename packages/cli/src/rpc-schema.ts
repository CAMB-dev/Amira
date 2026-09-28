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
      "Starts a turn. Answered at once with the new turnId, before the turn runs; fails with `busy` while a turn or a /compact runs (steer instead: it queues).",
    params: {
      text: str,
      "attachments?": {
        ...arrayOf(oneOf(ref("TextBlock"), ref("ImageBlock"))),
        description: "Sent after text.",
      },
      "display?": ref("MessageDisplay"),
    },
  },
  steer: {
    description:
      "Adds a message to the running turn before its next model call, without interrupting a tool. With no turn running it starts one; during a /compact it is queued and starts a turn once the compaction ends.",
    params: { text: str, "display?": ref("MessageDisplay") },
  },
  abort: {
    description:
      "Aborts the running turn (it still ends with turn.end) or /compact (messages queued meanwhile are dropped: turn.steer dropped).",
    params: {},
  },
  "ui.respond": {
    description:
      "Answers a ui.request. `value` is required; an explicit null cancels the dialog, and a missing value fails with `invalid_params`. A form is answered with an object of values by field id (missing fields take their defaults, hidden ones are ignored); values that do not pass its checks fail with `invalid_params` naming each problem, and the form stays open.",
    params: {
      requestId: str,
      value: {
        type: ["string", "boolean", "object", "null"],
        description:
          "The answer: a string for select, input and diff-review, a boolean for confirm, an object for form.",
      },
    },
  },
  "ui.action": {
    description:
      'Runs an action (a button such as "Fetch models") of an open form with the values so far, on the host, where its callback lives. Answered when it finishes, with what to show under the button and fields to update; its progress arrives meanwhile as ui.progress. Other lines are handled while it runs; cancelling the form aborts it. Fails with `not_found` for an unknown request.',
    params: { requestId: str, action: str, "values?": { type: "object" } },
  },
  "ui.configure": {
    description:
      'How this client wants forms: "native" (default) sends each as one ui.request of kind form; "dialogs" asks them one field at a time with select and input requests, for clients that only know those.',
    params: { forms: strings("native", "dialogs") },
  },
  "session.read": {
    description: "Reads the conversation: the last turn, or every message.",
    params: { what: strings("lastTurn", "messages") },
  },
  "model.set": {
    description:
      'Switches the model, as "provider/model". Fails with `busy` while a turn or a /compact runs.',
    params: { model: str },
  },
  state: { description: "A snapshot to resync from, e.g. after events.lost.", params: {} },
  "session.resume": {
    description:
      "Switches to a stored session of this directory (its id from session.start or `amira -r`), keeping the current model; a session.start with reason resume follows. Fails with `not_found` for an unknown id and `busy` while a turn or a /compact runs.",
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
  steer: {
    "turnId?": str,
    queued: {
      ...bool,
      description:
        "False when the message started a new turn; true when it waits for the running turn or /compact.",
    },
  },
  abort: { aborted: bool },
  "ui.respond": {},
  "ui.action": { result: ref("FormActionResult") },
  "ui.configure": {},
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
    busy: { ...bool, description: "A turn or a /compact is running: prompt and model.set fail with busy." },
    messages: { ...num, description: "Number of messages in the history." },
    "lastAssistantText?": str,
    uiRequests: { ...arrayOf(ref("UiRequest")), description: "Dialogs still waiting for ui.respond." },
  },
  "session.resume": { sessionId: str },
  "command.list": {
    commands: arrayOf(
      obj({
        name: str,
        aliases: { ...arrayOf(str), description: "Other names that run the command, e.g. q for quit." },
        description: str,
        "hint?": str,
        source: str,
      }),
    ),
    aliases: {
      ...arrayOf(obj({ name: str, expansion: str })),
      description:
        "The user's aliases from settings (commandAliases): /<name> runs /<expansion> with what follows appended.",
    },
  },
  "command.complete": {
    "command?": {
      ...str,
      description: "The command whose arguments are being completed (the one an alias runs).",
    },
    candidates: arrayOf(
      obj({
        value: str,
        "description?": str,
        "label?": { ...str, description: 'Shown in place of value, e.g. "quit (exit, q)".' },
      }),
    ),
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

const usage = obj({ input: num, output: num, cacheRead: num, cacheWrite: num, "cost?": num })
const budget = obj({ "tokens?": num, "costUsd?": num })

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
  "ui.resolved": obj({
    requestId: str,
    cancelled: bool,
    "value?": { type: ["string", "boolean"], description: "Left out for forms and secret inputs." },
  }),
  "ui.progress": obj({ requestId: str, action: str, text: str }),
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
  "subagent.start": obj({
    childSessionId: str,
    "role?": str,
    prompt: str,
    model: modelRef,
    depth: num,
    cwd: str,
    context: strings("fresh", "fork"),
    queued: bool,
  }),
  "subagent.end": obj({
    childSessionId: str,
    status: strings("done", "error", "aborted"),
    "error?": str,
    usage: usage,
    durationMs: num,
  }),
  "budget.update": obj({ tokens: num, "costUsd?": num, "limit?": budget }),
  "budget.exceeded": obj({ tokens: num, "costUsd?": num, limit: budget }),
}

/** The field kinds of a form, as ui.request carries them. */
function formFields(): Schema[] {
  const base = {
    id: str,
    label: str,
    "help?": str,
    "section?": str,
    "when?": {
      ...obj({ field: str, is: {} }),
      description: "Shown (and returned) only while that field has this value or one of these values.",
    },
  }
  const text = { "placeholder?": str, "required?": bool }
  return [
    obj({
      type: strings("text"),
      ...base,
      ...text,
      "default?": str,
      "pattern?": { ...str, description: "A JavaScript regular expression the whole value must match." },
      "patternMessage?": str,
      "maxLength?": num,
    }),
    obj({ type: strings("secret"), ...base, ...text }, "Masked; the value is never shown, echoed or stored."),
    obj({
      type: strings("number"),
      ...base,
      ...text,
      "default?": num,
      "min?": num,
      "max?": num,
      "integer?": bool,
    }),
    obj({ type: strings("select"), ...base, options: arrayOf(ref("FormOption")), "default?": str }),
    obj({
      type: strings("multiselect"),
      ...base,
      options: arrayOf(ref("FormOption")),
      "default?": arrayOf(str),
      "required?": bool,
      "allowCustom?": { ...bool, description: "Values that are not options are allowed." },
    }),
    obj({ type: strings("checkbox"), ...base, "default?": bool }),
    obj({ type: strings("textarea"), ...base, ...text, "default?": str, "rows?": num, "maxLength?": num }),
    obj(
      { type: strings("action"), ...base, "recommended?": bool },
      "A button; run it with ui.action. It has no value.",
    ),
  ]
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
        "display?": ref("MessageDisplay"),
      }),
      MessageDisplay: obj(
        {
          text: {
            ...str,
            description: 'Shown in place of the content, e.g. the command as typed: "/review-pr 123".',
          },
          "note?": {
            ...str,
            description: 'A line to show under text, e.g. "Loaded skill review-pr (120 lines)".',
          },
        },
        "How to show a user message instead of its content, which the model still gets in full. Never sent to the model.",
      ),
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
        obj({
          kind: strings("input"),
          title: str,
          "placeholder?": str,
          "initial?": str,
          "secret?": { ...bool, description: "Mask what is typed; never echo or store the answer." },
        }),
        obj(
          { kind: strings("diff-review"), title: str, diff: str, options: arrayOf(str) },
          "A unified diff to review; answer with one of the options.",
        ),
        obj(
          {
            kind: strings("form"),
            title: str,
            "description?": str,
            fields: arrayOf(ref("FormField")),
            "sections?": arrayOf(obj({ title: str, "help?": str, "optional?": bool })),
            "submitLabel?": str,
          },
          "A form; answer with an object of values by field id. Run its action fields with ui.action.",
        ),
      ),
      FormOption: obj({ value: str, "label?": str, "description?": str }),
      FormField: oneOf(...formFields()),
      FormActionResult: obj({
        "message?": str,
        "tone?": strings("info", "success", "warning", "error"),
        "values?": { type: "object", description: "New values for fields, by id." },
        "options?": {
          type: "object",
          additionalProperties: arrayOf(ref("FormOption")),
          description: "New options for select and multiselect fields, by id.",
        },
      }),
    },
    oneOf: [ref("Command"), ref("Response"), ref("Event")],
  }
}

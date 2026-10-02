import type { EventMap } from "@amira/api"

type Schema = Record<string, unknown>

const str: Schema = { type: "string" }
const num: Schema = { type: "number" }
const bool: Schema = { type: "boolean" }
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` })
const oneOf = (...schemas: Schema[]): Schema => ({ oneOf: schemas })
const strings = (...values: string[]): Schema => ({ enum: values })
const arrayOf = (items: Schema): Schema => ({ type: "array", items })
const thinkingLevels = ["low", "medium", "high", "xhigh", "max"]
const thinkingState = {
  supportsThinking: { ...bool, description: "Whether the current model supports thinking." },
  "thinkingLevel?": {
    ...strings(...thinkingLevels),
    description: "The effective effort, even on a model without thinking; omitted for the server default.",
  },
  "thinking?": {
    ...strings(...thinkingLevels),
    description:
      "The effort sent to the current model; omitted when unsupported or using the server default.",
  },
}

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
      "Starts a turn. Answered at once with the new turnId, before the turn runs; fails with `busy` while a turn or a /compact runs, including a turn that background sub-agents' results started (steer instead: it queues).",
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
        type: ["string", "boolean", "object", "array", "null"],
        description:
          'The answer: a string for select, input and diff-review (a select with sections also takes {"option": option, "key": key}); for confirm a boolean, "always" when it offers always, or {"other": text} when it offers other; for ask an array with one AskAnswer per question; an object for form.',
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
  "ui.focus": {
    description:
      "Tells the host whether this client's window has focus, so extensions can tell whether the user is looking (e.g. to notify only a user who is away). Emitted as a ui.focus event when it changes.",
    params: { focused: bool },
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
  "thinking.set": {
    description:
      'Sets the session thinking effort. The required level is low, medium, high, xhigh, max or "default". "default" sends no effort, overriding flags and settings rather than restoring them. Fails with `busy` while work runs. Unsupported models retain the level but send no effort.',
    params: { level: strings(...thinkingLevels, "default") },
  },
  state: { description: "A snapshot to resync from, e.g. after events.lost.", params: {} },
  "session.rename": {
    description: "Names the current session; overrides its automatic title.",
    params: { title: str },
  },
  "session.fork": {
    description: "Forks into a new session, optionally before the user message at index.",
    params: { "index?": { type: "integer", minimum: 0 } },
  },
  "session.resume": {
    description:
      "Switches to a stored session of this directory (its id from session.start or `amira -r`), keeping the current model; a session.start with reason resume follows. Fails with `not_found` for an unknown id and `busy` while a turn or a /compact runs.",
    params: { sessionId: str },
  },
  "command.list": { description: "Lists the slash commands; skills are listed by skill.list.", params: {} },
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
  "skill.list": {
    description: "Lists the skills, which a user runs by typing $<name> [arguments].",
    params: {},
  },
  "skill.run": {
    description:
      'Runs a skill as if the user typed $<name> <args>: usually it sends its instructions as a user message, which starts or steers a turn and is shown as the line typed. What it prints arrives as command.output events (command "$<name>"). Fails with `not_found` for an unknown skill and `command_failed` when it throws.',
    params: { name: str, "args?": str },
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
  "ui.focus": {},
  "session.read": {
    "messages?": arrayOf(ref("Message")),
    "turnId?": str,
    "reason?": strings("done", "error", "aborted"),
    "error?": str,
    "text?": { ...str, description: "The last assistant text of the turn." },
  },
  "model.set": { model: str },
  "thinking.set": thinkingState,
  state: {
    ...thinkingState,
    status: strings("idle", "working", "blocked", "error"),
    model: str,
    sessionId: str,
    "turnId?": str,
    busy: {
      ...bool,
      description: "Work is running: prompt, model.set and thinking.set fail with busy.",
    },
    messages: { ...num, description: "Number of messages in the history." },
    "lastAssistantText?": str,
    uiRequests: { ...arrayOf(ref("UiRequest")), description: "Dialogs still waiting for ui.respond." },
  },
  "session.resume": { sessionId: str },
  "session.rename": { sessionId: str, title: str },
  "session.fork": { sessionId: str },
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
  "skill.list": {
    skills: arrayOf(
      obj({
        name: str,
        description: str,
        hint: { ...str, description: 'Shown after the name, e.g. "[arguments]".' },
        source: str,
      }),
    ),
  },
  "skill.run": {
    skill: str,
    output: { ...arrayOf(str), description: "Everything the skill printed, in order." },
  },
}

const modelRef = obj({ provider: str, model: str })
const toolResult = obj({
  content: arrayOf(oneOf(ref("TextBlock"), ref("ImageBlock"))),
  "isError?": bool,
  "details?": {},
})

const usage = obj({
  input: num,
  output: num,
  "reasoning?": num,
  cacheRead: num,
  cacheWrite: num,
  "cost?": num,
  "webSearchRequests?": num,
  "webSearchCost?": num,
})
const budget = obj({ "tokens?": num, "costUsd?": num })
const spawnGroup = obj({
  id: str,
  name: str,
  parentSessionId: str,
  state: strings("active", "ending", "ended"),
  limits: obj({
    "maxConcurrent?": num,
    "maxAgents?": num,
    "budget?": budget,
    "maxTurnsPerAgent?": num,
  }),
  "compact?": bool,
  "status?": str,
  usage,
  tokens: num,
  agents: obj({ total: num, queued: num, working: num, idle: num, ended: num }),
  "endReason?": str,
  "exceeded?": bool,
})

const EVENT_DATA: Partial<Record<keyof EventMap, Schema>> = {
  "session.start": obj({
    reason: strings("startup", "resume", "fork", "clear"),
    cwd: str,
    "title?": str,
    model: modelRef,
    "sessionFile?": str,
    "resume?": arrayOf(str),
    "contextTokens?": num,
    "contextWindow?": num,
  }),
  "workspace.changed": obj({
    cwd: str,
    "repoRoot?": str,
    "branch?": str,
    "head?": str,
    "isWorktree?": bool,
    "dirty?": bool,
  }),
  "session.title": obj({ title: str }),
  "session.end": obj({ reason: strings("exit", "error", "switch") }),
  "status.changed": obj({
    status: strings("idle", "working", "blocked", "error"),
    "reason?": str,
    "pending?": num,
  }),
  "turn.start": obj({ prompt: ref("UserMessage") }),
  "turn.end": obj({
    reason: strings("done", "error", "aborted"),
    "error?": str,
    steps: num,
    "failure?": obj(
      {
        kind: strings("auth", "rate", "server", "network", "context", "config", "other"),
        summary: str,
        "hint?": str,
        "detail?": str,
      },
      "A failed model request in plain words: one line, the next step, and the provider's own text.",
    ),
  }),
  "model.retry": obj(
    {
      attempt: num,
      maxRetries: num,
      delayMs: num,
      error: str,
      kind: strings("auth", "rate", "server", "network", "context", "config", "other"),
      "status?": num,
    },
    "A failed model request is sent again after delayMs.",
  ),
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
    obj(
      { kind: strings("serverTool"), block: ref("ServerToolBlock") },
      "A tool the provider runs itself (its hosted web search) started or changed state; sent again on each change. Never executed locally: no tool.execute events.",
    ),
  ),
  "message.end": obj({ message: ref("AssistantMessage") }),
  "tool.execute.start": obj({
    toolCallId: str,
    name: str,
    args: { type: "object" },
    "traits?": ref("ToolTraits"),
    "writtenPaths?": arrayOf(str),
  }),
  "tool.execute.update": obj({ toolCallId: str, name: str, partial: toolResult }),
  "tool.execute.end": obj({
    toolCallId: str,
    name: str,
    result: toolResult,
    durationMs: num,
    "waitedMs?": {
      ...num,
      description: "Milliseconds waiting for an approver; absent if no approval wait was entered.",
    },
    "traits?": ref("ToolTraits"),
    "writtenPaths?": arrayOf(str),
    "rejected?": strings("blocked", "unknownTool", "invalidArgs", "aborted"),
    "approval?": {
      ...strings("user", "rule"),
      description:
        "The call ran after an approval: the user allowed it, or a rule they chose (don't ask again) did.",
    },
  }),
  "extension.loaded": obj({ source: str }),
  "extension.error": obj({ source: str, error: str }),
  "extension.notice": obj({ source: str, text: str, level: strings("info", "success", "warning", "error") }),
  "ui.render": obj({}),
  "events.lost": obj({ dropped: num }),
  "ui.request": { allOf: [ref("UiRequest"), obj({ requestId: str, "source?": str })] },
  "ui.resolved": obj({
    requestId: str,
    cancelled: bool,
    "value?": {
      type: ["string", "boolean"],
      description: "Left out for forms, secret inputs, ask answers and a confirm's free text.",
    },
  }),
  "ui.focus": obj(
    { focused: bool },
    "Whether the user's frontend has focus (from the TUI's terminal, or an rpc client's ui.focus); sent when it changes.",
  ),
  "ui.progress": obj({ requestId: str, action: str, text: str }),
  "ui.waiting": obj({ pending: num, hidden: bool, change: strings("opened", "resolved", "visibility") }),
  "model.changed": obj({ from: modelRef, to: modelRef }),
  "thinking.changed": obj(
    { "thinking?": strings(...thinkingLevels) },
    "The session's runtime effort changed; thinking is omitted when no effort is sent to its model.",
  ),
  "compact.start": obj({
    reason: strings("threshold", "manual", "overflow"),
    replacing: num,
    kept: num,
    "tokens?": num,
    "native?": { ...bool, description: "The provider's server is asked to compact." },
  }),
  "compact.end": obj({
    summary: { ...str, description: "Empty for a server-side compaction without readable text." },
    replaced: num,
    kept: num,
    reason: strings("threshold", "manual", "overflow"),
    "tokensBefore?": num,
    "tokensAfter?": { ...num, description: "Estimated; the next reply reports the real size." },
    "contextWindow?": num,
    "model?": { ...modelRef, description: "The model that wrote the summary." },
    "native?": { ...modelRef, description: "Set when the provider's server compacted it, for this model." },
    "layout?": strings("tail", "recent-user"),
    "fallback?": { ...str, description: "Why server-side compaction was not used though it is on." },
    "usage?": { ...usage, description: "What the compaction's requests cost." },
  }),
  "compact.failed": obj({ error: str, "blocked?": bool, "empty?": bool }),
  "command.output": obj({
    command: { ...str, description: 'The command that printed it, or "$<name>" for a skill.' },
    text: str,
    level: strings("info", "warning", "error"),
  }),
  "subagent.start": obj({
    childSessionId: str,
    "role?": str,
    "title?": str,
    "toolCallId?": str,
    prompt: str,
    model: modelRef,
    depth: num,
    cwd: str,
    context: strings("fresh", "fork"),
    queued: bool,
    "persistent?": bool,
    "groupId?": str,
  }),
  "subagent.end": obj({
    childSessionId: str,
    "toolCallId?": str,
    status: strings("done", "error", "aborted"),
    "error?": str,
    "note?": str,
    "turns?": num,
    "undelivered?": num,
    usage: usage,
    durationMs: num,
  }),
  "subagent.state": obj(
    { childSessionId: str, state: strings("queued", "working", "idle"), turns: num },
    "A persistent sub-agent started a turn (working), waits for a place to run one (queued), or waits for a message (idle).",
  ),
  "group.start": obj({ group: spawnGroup }),
  "group.update": obj({ group: spawnGroup }),
  "group.end": obj({ group: spawnGroup }),
  "budget.update": obj({ tokens: num, "costUsd?": num, "limit?": budget }),
  "budget.exceeded": obj({ tokens: num, "costUsd?": num, limit: budget }),
  "notice.retry": obj(
    { attempt: num, attempts: num, delayMs: num, "error?": str },
    "A turn carrying background sub-agents' results failed: they are sent again in delayMs, starting a turn (attempt of attempts). Sending a message first takes them along instead.",
  ),
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
      ToolTraits: obj({
        "readOnly?": bool,
        "writesFiles?": oneOf(bool, strings("paths")),
        "shell?": strings("bash", "powershell"),
        "editor?": strings("edit", "apply_patch"),
        "usesMutationHook?": bool,
        "artifactReader?": bool,
        "toolSearch?": bool,
        "interactive?": bool,
      }),
      TextBlock: obj({
        type: strings("text"),
        text: str,
        "citations?": {
          ...arrayOf(obj({ url: str, "title?": str, "start?": num, "end?": num })),
          description:
            "Sources the provider cited (e.g. url_citation annotations after a hosted web search); start and end are the cited span of text, as the provider counts it.",
        },
      }),
      ServerToolBlock: obj(
        {
          type: strings("serverTool"),
          id: str,
          name: { ...str, description: 'What ran, e.g. "web_search".' },
          input: {
            type: "object",
            description:
              'What it was asked, as the provider said, e.g. {"type": "search", "query": "..."} or {"type": "open_page", "url": "..."}.',
          },
          status: strings("running", "done", "failed"),
          "sources?": arrayOf(obj({ url: str, "title?": str })),
          "searchEntryPoint?": obj({ "renderedContent?": str, "sdkBlob?": str }),
        },
        "A tool the provider ran on its own servers during the reply (its hosted web search). Not a tool call: it has no result message.",
      ),
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
          "origin?": {
            ...str,
            description:
              'Set when the user did not write the message: "subagent" for background sub-agents\' results sent to the session. Show it as a notice; a turn it starts is otherwise an ordinary turn.',
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
            ref("ServerToolBlock"),
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
        obj({
          kind: strings("select"),
          title: str,
          options: arrayOf(str),
          "initial?": { ...str, description: "The option initially highlighted; defaults to the first." },
          "sections?": {
            ...arrayOf(
              obj({
                at: num,
                "title?": str,
                "choose?": str,
                "keys?": arrayOf(obj({ key: str, label: str })),
              }),
            ),
            description:
              'Parts of the list, each from option index `at` to the next: a heading, what Enter does there, and keys besides Enter. A key pressed on an option answers {"option": option, "key": key}; the option alone answers as Enter.',
          },
          "descriptions?": {
            ...arrayOf(str),
            description: 'Muted text shown with the option of the same index ("" for none).',
          },
          "searchTexts?": {
            ...arrayOf(str),
            description:
              "Conversation text searched as case-insensitive substrings; matching snippets appear under options. Section keys use Ctrl while searching.",
          },
        }),
        obj({
          kind: strings("confirm"),
          title: str,
          "message?": str,
          "always?": {
            type: ["boolean", "string"],
            description: `Also offer "Yes, and don't ask again this session"; answered with "always". A string says what it covers instead of "this session", e.g. "this session for bash (policy)".`,
          },
          "other?": {
            ...bool,
            description:
              'Also offer free text meaning no, and what to do instead; answered with {"other": text}.',
          },
          "preview?": {
            ...arrayOf(obj({ kind: str, text: str, "lineNo?": num })),
            description:
              "What the call would do, as its tool presents it (a command, a diff): tool lines by kind (code, diff-add, diff-remove, diff-context, muted, ...).",
          },
        }),
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
          { kind: strings("ask"), title: str, questions: arrayOf(ref("AskQuestion")) },
          'Questions from the ask_user tool, shown one after another; answer with an array holding one AskAnswer per question, in order. Every question also takes free text ("Other").',
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
      AskQuestion: obj({
        question: str,
        "header?": { ...str, description: "A short name for the question, at most 12 characters." },
        options: arrayOf(obj({ label: str, "description?": str })),
        "multiSelect?": { ...bool, description: "Several options may be chosen together." },
      }),
      AskAnswer: obj(
        {
          selected: { ...arrayOf(str), description: "Labels of the options chosen." },
          "other?": {
            ...str,
            description: "Text typed instead of (or, when multiSelect, next to) an option.",
          },
        },
        "A single-choice question takes exactly one label or other text; a multiSelect one any number.",
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

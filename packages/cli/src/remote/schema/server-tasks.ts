import { array, bool, constrain, integer, object, text, union, enumeration as values } from "./base.ts"
import { coreEvent } from "./events.ts"
import { acknowledgement, subagent } from "./frontend.ts"
import { message } from "./messages.ts"
import { backgroundJob } from "./workspace.ts"

const scope = { "conversationId?": text }
const ref = { conversationId: text, "incarnation?": text }
const page = { "offset?": integer, "limit?": constrain(integer, { minimum: 1, maximum: 100 }) }
const output = constrain(text, { maxLength: 32_768 })

/** Host-only B10 task/history operations; no process start or executable conversation handles. */
export const serverTaskSchemas = {
  "jobs.list": {
    params: object({ ...scope, ...page }),
    result: object({ jobs: array(backgroundJob), "nextOffset?": integer }),
  },
  "jobs.output": {
    params: object({
      ...scope,
      id: text,
      "from?": integer,
      "maxChars?": constrain(integer, { minimum: 1, maximum: 32_768 }),
    }),
    result: object({
      text: output,
      from: integer,
      to: integer,
      dropped: integer,
      availableTo: integer,
      truncated: bool,
    }),
  },
  "jobs.stop": {
    params: object({ ...scope, id: text, "graceMs?": constrain(integer, { maximum: 10_000 }) }),
    result: backgroundJob,
  },
  "jobs.wait": {
    params: object({
      ...scope,
      id: text,
      "from?": integer,
      timeoutMs: constrain(integer, { maximum: 600_000 }),
      "contains?": constrain(text, { maxLength: 256 }),
    }),
    result: object({ reason: values("match", "exit", "timeout", "aborted"), "line?": output }),
  },
  "conversations.list": {
    params: object({}),
    result: object({
      subagents: array(subagent),
      conversations: array(
        object({
          id: text,
          name: text,
          cwd: text,
          incarnation: text,
          "acceptsImages?": bool,
          state: values("idle", "working", "blocked", "stopped", "error"),
          busy: bool,
        }),
      ),
    }),
  },
  "conversations.history": {
    params: object({ ...ref, ...page, "snapshot?": text }),
    result: object({
      snapshot: text,
      sessionGeneration: integer,
      messages: array(message),
      watermark: object({ daemonEpoch: text, seq: integer }),
      activity: object({ events: array(coreEvent) }),
      "renderedTurnIds?": array(text),
      "nextOffset?": integer,
    }),
  },
  "conversations.focus": { params: object(ref), result: object({ ...ref, sessionGeneration: integer }) },
  "conversations.unfocus": { params: object({}), result: acknowledgement },
  "conversations.control": {
    params: union(
      object({ conversationId: text, action: values("pause", "resume", "stop") }),
      object({ conversationId: text, action: values("message"), text }),
    ),
    result: object({ accepted: bool, sessionGeneration: integer }),
  },
}

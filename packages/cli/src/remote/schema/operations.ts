import type { FrontendOperations } from "@amira/core"
import type { ServerOperations } from "../../server/operations.ts"
import type { RemoteOperation } from "../protocol.ts"
import {
  array,
  bool,
  constrain,
  integer,
  object,
  type Schema,
  text,
  union,
  enumeration as values,
} from "./base.ts"
import { formDraft, formEvaluation, formMutation, formValues, uiAck, uiAnswer } from "./forms.ts"
import {
  acknowledgement,
  commandOutcome,
  frontendState,
  nullableStoredSession,
  rewindPlan,
  serverModels,
  sessionList,
  status,
  transcript,
} from "./frontend.ts"
import { compactResult, modelRequest, reasoning, userMessage } from "./messages.ts"

const empty = object({})
const command = object({
  line: text,
  "invocationId?": text,
  "keys?": array(object({ keys: text, description: text })),
  "glyphs?": object({ separator: text, more: text }),
})
const input = union(text, userMessage)
const index = object({ index: integer })
const draft = object(formDraft)

/** Every operation has its own closed input and output DTO. No method-name-to-arbitrary-JSON fallback. */
export const operationSchemas = {
  "state.read": { params: empty, result: frontendState },
  "transcript.read": { params: empty, result: transcript },
  "turn.prompt": {
    params: object({ message: input, "turnId?": text, "expectedHoldId?": text }),
    result: acknowledgement,
  },
  "turn.steer": {
    params: object({
      message: input,
      "turnId?": text,
      "expectedTurnId?": text,
      "expectedHoldId?": text,
      "expectedIdle?": bool,
    }),
    result: acknowledgement,
  },
  "turn.abort": { params: object({ "turnId?": text, "holdId?": text }), result: acknowledgement },
  "command.run": { params: command, result: commandOutcome },
  "skill.run": { params: command, result: commandOutcome },
  "input.run": { params: command, result: commandOutcome },
  "session.resume": { params: object({ id: text }), result: acknowledgement },
  "session.clear": { params: empty, result: acknowledgement },
  "session.fork": { params: index, result: acknowledgement },
  "session.rewind": { params: object({ index: integer, "restoreFiles?": bool }), result: acknowledgement },
  "session.planRewind": { params: index, result: rewindPlan },
  "conversation.send": {
    params: object({ conversationId: text, incarnation: text, message: input, "turnId?": text }),
    result: acknowledgement,
  },
  "conversation.stop": {
    params: object({
      conversationId: text,
      incarnation: text,
      "reason?": text,
      "expectedTurnId?": text,
      "expectedHoldId?": text,
    }),
    result: acknowledgement,
  },
  "sessions.list": {
    params: object({ "offset?": integer, "limit?": constrain(integer, { minimum: 1, maximum: 100 }) }),
    result: sessionList,
  },
  "sessions.read": { params: object({ id: text }), result: nullableStoredSession },
  "models.list": { params: empty, result: serverModels },
  "model.set": { params: object({ model: text }), result: acknowledgement },
  "thinking.set": { params: object({ level: union(reasoning, values("default")) }), result: acknowledgement },
  "fastMode.set": { params: object({ enabled: bool }), result: acknowledgement },
  "status.read": { params: empty, result: status },
  "ui.respond": { params: object({ requestId: text, value: uiAnswer }), result: uiAck },
  "ui.cancel": { params: object({ requestId: text }), result: uiAck },
  "form.open": { params: object({ requestId: text }), result: object({ editor: text, revision: integer }) },
  "form.evaluate": {
    params: object({
      requestId: text,
      draft: object({ ...formDraft, "previous?": formValues, "automaticValues?": formValues }),
    }),
    result: formEvaluation,
  },
  "form.action": {
    params: object({ requestId: text, draft: object({ ...formDraft, action: text, "automatic?": bool }) }),
    result: formMutation,
  },
  "form.submit": { params: object({ requestId: text, draft }), result: formMutation },
  "form.cancel": {
    params: object({ requestId: text, "editor?": text, "revision?": integer }),
    result: uiAck,
  },
  "model.stream": { params: object({ request: modelRequest }), result: object({ accepted: values(true) }) },
  "model.compact": { params: object({ request: modelRequest }), result: compactResult },
} satisfies Record<
  RemoteOperation | keyof FrontendOperations | keyof ServerOperations,
  { params: Schema; result: Schema }
>

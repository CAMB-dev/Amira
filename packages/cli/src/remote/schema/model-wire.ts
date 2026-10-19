import {
  array,
  bool,
  id,
  integer,
  number,
  object,
  type Schema,
  text,
  union,
  enumeration as values,
} from "./base.ts"
import { compactResult, modelRequest, streamEvent, usage } from "./messages.ts"

const receipt = object({
  aggregate: bool,
  "knownCost?": number,
  hasReportedCost: bool,
  "knownSearchCost?": number,
  unpricedSearchRequests: number,
  unpricedTokens: number,
  unknownContributions: number,
  unpricedContributions: number,
  unreportedContributions: number,
})
const wire = <T>(value: Schema<T>) => object({ value, usage: array(object({ path: array(text), receipt })) })
export const modelOpen = object({
  callId: id,
  revision: id,
  operation: values("stream", "compact"),
  request: wire(modelRequest),
  resume: bool,
  after: integer,
})
export const modelFramePayload = union(
  object({ kind: values("stream"), data: wire(streamEvent) }),
  object({ kind: values("compact"), data: wire(compactResult) }),
  object({ kind: values("progress") }),
  object({
    kind: values("receipt"),
    data: wire(object({ id: text, late: bool, "usage?": usage })),
  }),
  object({ kind: values("failure"), code: id }),
)

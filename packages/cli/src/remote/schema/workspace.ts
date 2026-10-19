import {
  array,
  bool,
  integer,
  nil,
  number,
  object,
  record,
  type SchemaType,
  text,
  union,
  enumeration as values,
} from "./base.ts"
import { coreEvent } from "./events.ts"
import { uiRequest } from "./forms.ts"
import { budget, serverModels, snapshot, status, subagent } from "./frontend.ts"
import { usage, userMessage } from "./messages.ts"

/** SpawnGroupInfo's public listing shape, matching the group core event payloads. */
const group = object({
  id: text,
  name: text,
  parentSessionId: text,
  state: values("active", "ending", "ended"),
  limits: object({
    "maxConcurrent?": number,
    "maxAgents?": number,
    "budget?": budget,
    "maxTurnsPerAgent?": number,
  }),
  "compact?": bool,
  "status?": text,
  usage,
  tokens: number,
  agents: object({
    total: number,
    "paused?": number,
    queued: number,
    working: number,
    idle: number,
    ended: number,
  }),
  "outcomes?": object({ done: number, failed: number, stopped: number }),
  "endReason?": text,
  "exceeded?": bool,
})

/** Deliberate public job fields only: no opaque metadata, host log paths, or raw errors. */
export const backgroundJob = object({
  id: text,
  command: text,
  "kind?": values("job", "monitor"),
  cwd: text,
  "owner?": text,
  startedAt: number,
  status: values("starting", "running", "exited", "stopped", "failed"),
  "pid?": integer,
  contained: bool,
  exitCode: union(number, nil),
  signal: union(text, nil),
  "endedAt?": number,
  stopRequested: bool,
  outputChars: integer,
})
export type RemoteJobInfo = SchemaType<typeof backgroundJob>

export const workspaceSemantic = object({
  status,
  models: serverModels,
  subagents: array(subagent),
  groups: array(group),
})

export const inputQueue = array(
  object({
    id: text,
    holdId: text,
    kind: values("prompt", "steer"),
    message: userMessage,
    "turnId?": text,
  }),
)

export const noticeInbox = object({
  queue: array(object({ id: text, message: userMessage })),
  expected: integer,
})

export const noticeRetry = union(object({ attempt: integer, at: number }), nil)
export const holdState = union(object({ id: text, what: text }), nil)
export const ownerState = object({
  "parentSessionId?": text,
  status: values("idle", "working", "blocked", "error"),
  busy: bool,
  turnId: union(text, nil),
  hold: holdState,
  inputQueue,
  steering: array(userMessage),
  noticeInbox,
  noticeRetry,
})
export type RemoteOwnerState = SchemaType<typeof ownerState>

/** Captured at one workspace cursor; core events retain their original envelopes. */
export const workspaceSnapshot = object({
  frontend: snapshot,
  semantic: workspaceSemantic,
  pendingRequests: array(uiRequest),
  startupEvents: array(coreEvent),
  activity: object({ events: array(coreEvent) }),
  owners: record(ownerState),
  jobs: array(backgroundJob),
})
export type RemoteWorkspaceSnapshot = SchemaType<typeof workspaceSnapshot>

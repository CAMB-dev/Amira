import type { Budget, CompactionInfo, FileRewindPlan, SessionInfo, SubagentInfo } from "@amira/api"
import type {
  CommandOutcome,
  FrontendAcknowledgement,
  FrontendSnapshot,
  FrontendState,
  FrontendTranscript,
  FrontendUpdate,
} from "@amira/core"
import { object } from "../../src/remote/schema/base.ts"
import * as schema from "../../src/remote/schema/frontend.ts"
import type { ServerModel, ServerOperations, ServerSessionHistory } from "../../src/server/operations.ts"
import type { ServerEffect } from "../../src/server/runtime.ts"
import type { AssertNone, Difference } from "./schema-parity-types.ts"

const compaction = object(schema.compaction)
type Checked =
  | "budget"
  | "compaction"
  | "frontendState"
  | "transcript"
  | "snapshot"
  | "update"
  | "acknowledgement"
  | "commandOutcome"
  | "rewindPlan"
  | "sessionInfo"
  | "subagent"
  | "storedSession"
  | "sessionList"
  | "serverModels"
  | "status"
  | "serverEffect"
  | "nullableStoredSession"
export type FrontendSchemaParity = [
  AssertNone<Exclude<keyof typeof schema, Checked> | Exclude<Checked, keyof typeof schema>>,
  AssertNone<Difference<typeof schema.budget, Budget>>,
  AssertNone<Difference<typeof compaction, CompactionInfo>>,
  AssertNone<Difference<typeof schema.frontendState, FrontendState>>,
  AssertNone<Difference<typeof schema.transcript, FrontendTranscript>>,
  AssertNone<Difference<typeof schema.snapshot, FrontendSnapshot>>,
  AssertNone<Difference<typeof schema.update, FrontendUpdate>>,
  AssertNone<Difference<typeof schema.acknowledgement, FrontendAcknowledgement>>,
  AssertNone<Difference<typeof schema.commandOutcome, CommandOutcome>>,
  AssertNone<Difference<typeof schema.rewindPlan, FileRewindPlan>>,
  AssertNone<Difference<typeof schema.sessionInfo, SessionInfo>>,
  AssertNone<Difference<typeof schema.subagent, SubagentInfo>>,
  AssertNone<Difference<typeof schema.storedSession, ServerSessionHistory>>,
  AssertNone<Difference<typeof schema.sessionList, ServerOperations["sessions.list"]["result"]>>,
  AssertNone<Difference<typeof schema.serverModels, ServerModel[]>>,
  AssertNone<Difference<typeof schema.status, ServerOperations["status.read"]["result"]>>,
  AssertNone<Difference<typeof schema.serverEffect, ServerEffect>>,
  AssertNone<Difference<typeof schema.nullableStoredSession, ServerSessionHistory | null>>,
]

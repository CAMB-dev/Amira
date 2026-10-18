import type { CompactResult, ModelRequest } from "@amira/ai"
import type { UiAnswer } from "@amira/api"
import type { FrontendOperations } from "@amira/core"
import type { RemoteOperation } from "../../src/remote/protocol.ts"
import type { operationSchemas } from "../../src/remote/schema/operations.ts"
import type { ServerOperations } from "../../src/server/operations.ts"
import type { AssertNone, Difference } from "./schema-parity-types.ts"

// Forms have revisioned operations instead of accepting their raw values through ui.respond.
export type WireOperations = Omit<FrontendOperations & ServerOperations, "ui.respond"> & {
  "ui.respond": {
    params: Omit<ServerOperations["ui.respond"]["params"], "value"> & {
      value: UiAnswer[Exclude<keyof UiAnswer, "form">] | null
    }
    result: ServerOperations["ui.respond"]["result"]
  }
  "model.stream": { params: { request: ModelRequest }; result: { accepted: true } }
  "model.compact": { params: { request: ModelRequest }; result: CompactResult }
}
type OperationDifferences = {
  [K in RemoteOperation]:
    | Difference<(typeof operationSchemas)[K]["params"], WireOperations[K]["params"]>
    | Difference<(typeof operationSchemas)[K]["result"], WireOperations[K]["result"]>
}[RemoteOperation]
export type OperationSchemaParity = AssertNone<OperationDifferences>

import type { EventMap } from "@amira/api"
import type { coreEvent, coreEventData } from "../../src/remote/schema/events.ts"
import type { ServerEvent, ServerUiRequest } from "../../src/server/runtime.ts"
import type { AssertNone, Difference } from "./schema-parity-types.ts"

type EventDataDifferences = {
  [K in keyof EventMap]: Difference<
    (typeof coreEventData)[K],
    K extends "ui.request" ? ServerUiRequest : EventMap[K]
  >
}[keyof EventMap]
export type EventSchemaParity = [
  AssertNone<EventDataDifferences>,
  AssertNone<Difference<typeof coreEvent, ServerEvent>>,
]

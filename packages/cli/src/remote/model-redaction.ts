import type { StreamEvent } from "@amira/ai"
import { ModelOutboundFilter } from "./model-outbound-filter.ts"

export { redactModelValue } from "./model-string-masks.ts"

/** Compatibility adapter; all publication kinds use the same chronological filter. */
export class ModelStreamRedactor {
  private filter: ModelOutboundFilter
  constructor(secrets: readonly string[]) {
    this.filter = new ModelOutboundFilter(secrets, { maxBytes: 2 * 1024 * 1024 })
  }
  push(event: StreamEvent): StreamEvent[] {
    const items = this.filter.push({ kind: "event", value: event })
    if (event.type === "done" || event.type === "error") items.push(...this.filter.flush())
    return items.flatMap((item) => (item.kind === "event" ? [item.value] : []))
  }
  finish(): StreamEvent[] {
    return this.filter.flush().flatMap((item) => (item.kind === "event" ? [item.value] : []))
  }
}

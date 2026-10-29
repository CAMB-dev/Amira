import { REMOTE_FRAME_SCHEMAS, validateRemoteFrame } from "../remote-schema.ts"
import { RemoteError } from "./errors.ts"
import { REMOTE_GATED_VALUES, type RemoteJson, type RemoteMessage } from "./protocol.ts"
import { matches, type Schema } from "./schema/base.ts"

type Gate = (typeof REMOTE_GATED_VALUES)[number]

/** Walk only schema-owned DTO fields, never opaque tool args, signatures or user details. */
function omitGated(value: RemoteJson, schema: Schema, gates: readonly Gate[]): void {
  const alternatives = schema.oneOf ?? schema.anyOf
  if (alternatives) {
    const selected = alternatives.find((branch) => matches(value, branch))
    if (selected) omitGated(value, selected, gates)
    return
  }
  if (Array.isArray(value)) {
    if (schema.items) for (const item of value) omitGated(item, schema.items, gates)
  } else if (value !== null && typeof value === "object") {
    for (const gate of gates)
      if (schema.properties?.[gate.property] && value[gate.property] === gate.value)
        delete value[gate.property]
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key] ?? schema.additionalProperties
      if (property) omitGated(item, property, gates)
    }
  }
}

/** Downgrade optional gated values for v1 peers without losing actual limits or changing retained data. */
export function remoteMessageForPeer(message: RemoteMessage, capabilities: readonly string[]): RemoteMessage {
  const gates = REMOTE_GATED_VALUES.filter((gate) => !capabilities.includes(gate.capability))
  if (!gates.length) return message
  // Validate/copy before inspecting: getters, toJSON hooks and unknown fields must still fail closed.
  const frame = validateRemoteFrame(message, { outgoing: true })
  if (frame.kind === "chunk") throw new RemoteError("invalid_frame", "Cannot send a nested chunk")
  omitGated(frame as unknown as RemoteJson, REMOTE_FRAME_SCHEMAS[frame.kind], gates)
  return frame
}

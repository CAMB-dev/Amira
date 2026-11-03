import { REMOTE_FRAME_SCHEMAS, validateRemoteFrame } from "../remote-schema.ts"
import { prepareRemoteMessage } from "./codec.ts"
import { RemoteError } from "./errors.ts"
import {
  REMOTE_GATED_FIELDS,
  REMOTE_GATED_FRAMES,
  REMOTE_GATED_VALUES,
  type RemoteJson,
  type RemoteMessage,
  remotePeerCapabilities,
} from "./protocol.ts"
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

/**
 * Downgrade a frame for a v1 peer without losing actual limits or changing retained data: gated
 * values and fields are omitted, and a gated frame is not sent at all (undefined).
 */
export function remoteMessageForPeer(
  message: RemoteMessage,
  capabilities: readonly string[],
): RemoteMessage | undefined {
  const peer = remotePeerCapabilities(capabilities)
  if (REMOTE_GATED_FRAMES.some((gate) => gate.kind === message.kind && !peer.includes(gate.capability)))
    return undefined
  const gates = REMOTE_GATED_VALUES.filter((gate) => !peer.includes(gate.capability))
  const fields = REMOTE_GATED_FIELDS.filter(
    (gate) =>
      gate.frame === message.kind && !peer.includes(gate.capability) && Object.hasOwn(message, gate.property),
  )
  if (!gates.length && !fields.length) return message
  // Validate/copy before inspecting: getters, toJSON hooks and unknown fields must still fail closed.
  const frame = validateRemoteFrame(message, { outgoing: true })
  if (frame.kind === "chunk") throw new RemoteError("invalid_frame", "Cannot send a nested chunk")
  for (const gate of fields) delete (frame as unknown as Record<string, unknown>)[gate.property]
  if (gates.length) omitGated(frame as unknown as RemoteJson, REMOTE_FRAME_SCHEMAS[frame.kind], gates)
  return frame
}

/** Peers with the same key receive byte-identical frames, so one encoding serves them all. */
export function remoteGateKey(capabilities: readonly string[]): string {
  const peer = remotePeerCapabilities(capabilities)
  return [
    ...new Set(
      [...REMOTE_GATED_VALUES, ...REMOTE_GATED_FIELDS, ...REMOTE_GATED_FRAMES].map((gate) => gate.capability),
    ),
  ]
    .filter((capability) => !peer.includes(capability))
    .sort()
    .join(" ")
}

export type PreparedRemoteMessage = ReturnType<typeof prepareRemoteMessage>

/** Filter, validate and encode once for a peer; undefined when the peer must not see the frame. */
export function prepareForPeer(
  message: RemoteMessage,
  capabilities: readonly string[],
): PreparedRemoteMessage | undefined {
  const filtered = remoteMessageForPeer(message, capabilities)
  return filtered && prepareRemoteMessage(filtered)
}

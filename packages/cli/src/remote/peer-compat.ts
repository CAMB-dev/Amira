import { REMOTE_FRAME_SCHEMAS, validateRemoteFrame } from "../remote-schema.ts"
import { RemoteError } from "./errors.ts"
import { CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY, type RemoteJson, type RemoteMessage } from "./protocol.ts"
import { matches, type Schema } from "./schema/base.ts"

/** Walk only schema-owned DTO fields, never opaque tool args, signatures or user details. */
function omitProviderSource(value: RemoteJson, schema: Schema): void {
  const alternatives = schema.oneOf ?? schema.anyOf
  if (alternatives) {
    const selected = alternatives.find((branch) => matches(value, branch))
    if (selected) omitProviderSource(value, selected)
    return
  }
  if (Array.isArray(value)) {
    if (schema.items) for (const item of value) omitProviderSource(item, schema.items)
  } else if (value !== null && typeof value === "object") {
    if (schema.properties?.contextWindowSource && value.contextWindowSource === "provider")
      delete value.contextWindowSource
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key] ?? schema.additionalProperties
      if (property) omitProviderSource(item, property)
    }
  }
}

/** Downgrade the optional enum for v1 peers without losing actual limits or changing retained data. */
export function remoteMessageForPeer(message: RemoteMessage, capabilities: readonly string[]): RemoteMessage {
  if (capabilities.includes(CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY)) return message
  // Validate/copy before inspecting: getters, toJSON hooks and unknown fields must still fail closed.
  const frame = validateRemoteFrame(message, { outgoing: true })
  if (frame.kind === "chunk") throw new RemoteError("invalid_frame", "Cannot send a nested chunk")
  omitProviderSource(frame as unknown as RemoteJson, REMOTE_FRAME_SCHEMAS[frame.kind])
  return frame
}

import type { FrontendAttachment } from "@amira/core"
import type { RemoteAgentPort } from "./agent-port.ts"
import type { RemoteAttachedClient } from "./protocol.ts"

/** Longest client field shown; buildId and target are id-patterned, but every field is self-reported. */
const FIELD_CHARS = 48

/**
 * Terminal controls (C0, DEL, C1), the soft hyphen, the Arabic letter mark, line/paragraph
 * separators, bidi and zero-width format characters.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are what is removed
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g

/** Display text only: controls stripped, whitespace collapsed, length capped by code point. */
export function plainClientText(value: string, max = FIELD_CHARS): string {
  const chars = Array.from(value.replace(UNSAFE, "").replace(/\s+/g, " ").trim())
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")
}

/** "amira-gui 0.2.0 (win32-x64)": who a presence frame says is attached. */
export function clientLabel(client: RemoteAttachedClient): string {
  const name = plainClientText(client.buildId) || "another client"
  const version = client.version === undefined ? "" : plainClientText(client.version)
  const target = plainClientText(client.target)
  return `${name}${version ? ` ${version}` : ""}${target ? ` (${target})` : ""}`
}

/**
 * This connection's role and the other clients on the workspace. Without roles on the daemon
 * there is no presence: a controller shows nothing, as before.
 */
export function remoteAttachment(
  port: Pick<RemoteAgentPort, "role" | "readOnly" | "presence" | "rolesSupported">,
  notice?: string,
): FrontendAttachment | undefined {
  if (!port.role) return undefined
  const role = port.readOnly ? "viewer" : "controller"
  const presence = port.presence
  if (role === "controller" && !port.rolesSupported) return undefined
  // Unknown states read as none; a controller in grace is not there to answer anything.
  const held = presence?.controller.state === "attached" ? presence.controller.client : undefined
  const controller = held && clientLabel(held)
  // A viewer's own entry is in the list, and nothing says which one it is.
  const viewers = Math.max(0, (presence?.viewers.length ?? 0) - (port.role === "viewer" ? 1 : 0))
  return Object.freeze({
    role,
    viewers,
    ...(role === "viewer" && controller ? { controller } : {}),
    ...(notice ? { notice } : {}),
  })
}

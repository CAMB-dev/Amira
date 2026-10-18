/** Optional lifecycle information declared by an extension package or index entry. */
export type ExtensionStatus = "experimental" | "wip" | "deprecated"

export interface ExtensionStatusMetadata {
  status?: ExtensionStatus
  statusMessage?: string
  /** A suggested replacement; meaningful only when status is deprecated. */
  replacedBy?: string
}

/** Host-only diagnostic copy; deliberately not re-exported by the public API. */
export function unknownExtensionStatusWarning(name: string, status: unknown): string {
  return `${name}: unknown extension status ${JSON.stringify(status) ?? String(status)}; ignored`
}

/** ASCII-safe labels shared by package lists and host-owned management interfaces. */
export function extensionStatusBadge(value: ExtensionStatusMetadata): string {
  switch (value.status) {
    case "experimental":
      return "[experimental]"
    case "wip":
      return "[wip]"
    case "deprecated":
      return "[deprecated]"
    default:
      return ""
  }
}

/** All English lifecycle copy lives here so frontends do not invent their own wording. */
export function extensionStatusNotice(
  name: string,
  value: ExtensionStatusMetadata,
): { level: "note" | "warning"; message: string } | undefined {
  const safe = (text: string) =>
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: untrusted manifest text
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  const label = safe(name)
  const message = value.statusMessage ? safe(value.statusMessage) : ""
  const suffix = message ? `: ${message}` : ""
  switch (value.status) {
    case "experimental":
      return { level: "note", message: `note: ${label} is experimental${suffix}` }
    case "wip":
      return { level: "warning", message: `warning: ${label} is work in progress${suffix}` }
    case "deprecated": {
      const replacement = value.replacedBy ? safe(value.replacedBy) : ""
      return {
        level: "warning",
        message: `warning: ${label} is deprecated${replacement ? `; use ${replacement} instead` : ""}${suffix}`,
      }
    }
    default:
      return undefined
  }
}

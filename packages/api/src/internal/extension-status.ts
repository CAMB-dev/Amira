import { type ExtensionStatusMetadata, unknownExtensionStatusWarning } from "../extension-status.ts"

/** Copies lifecycle metadata without leaking unrelated manifest or host fields. */
export function extensionStatusMetadata(value: ExtensionStatusMetadata): ExtensionStatusMetadata {
  const { status } = value
  if (status !== "experimental" && status !== "wip" && status !== "deprecated") return {}
  return {
    status,
    ...(typeof value.statusMessage === "string" && value.statusMessage
      ? { statusMessage: value.statusMessage }
      : {}),
    ...(status === "deprecated" && typeof value.replacedBy === "string" && value.replacedBy
      ? { replacedBy: value.replacedBy }
      : {}),
  }
}

/** Unknown lifecycle values are advisory mistakes, never installation or loading failures. */
export function parseExtensionStatus(
  value: { status?: unknown; statusMessage?: unknown; replacedBy?: unknown },
  warn: (message: string) => void,
  name: string,
): ExtensionStatusMetadata {
  const status = value.status
  if (status === undefined) return {}
  if (status !== "experimental" && status !== "wip" && status !== "deprecated") {
    warn(unknownExtensionStatusWarning(name, status))
    return {}
  }
  return extensionStatusMetadata({
    status,
    ...(typeof value.statusMessage === "string" ? { statusMessage: value.statusMessage } : {}),
    ...(typeof value.replacedBy === "string" ? { replacedBy: value.replacedBy } : {}),
  })
}

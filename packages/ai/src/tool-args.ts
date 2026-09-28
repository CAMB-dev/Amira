/** Key under which unparseable tool arguments are kept, so the loop can report them to the model. */
export const INVALID_ARGS_KEY = "__invalidJson"

/**
 * Parses streamed tool-call arguments. Invalid JSON is kept under INVALID_ARGS_KEY
 * rather than thrown away; repairing it is a later concern of this layer.
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {}
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
    return { [INVALID_ARGS_KEY]: raw }
  } catch {
    return { [INVALID_ARGS_KEY]: raw }
  }
}

export function invalidArgs(args: Record<string, unknown>): string | undefined {
  const v = args[INVALID_ARGS_KEY]
  return typeof v === "string" ? v : undefined
}

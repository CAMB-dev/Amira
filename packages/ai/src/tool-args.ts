import { repairJsonObject } from "./json-repair.ts"

/** Key under which unparseable tool arguments are kept, so the loop can report them to the model. */
export const INVALID_ARGS_KEY = "__invalidJson"

/**
 * Parses streamed tool-call arguments. Common mistakes are repaired (D40); what cannot be
 * repaired is kept under INVALID_ARGS_KEY rather than thrown away.
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {}
  let v: unknown
  try {
    v = JSON.parse(raw)
    // Some models encode the arguments twice.
    if (typeof v === "string") v = JSON.parse(v)
  } catch {}
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
  return repairJsonObject(raw) ?? { [INVALID_ARGS_KEY]: raw }
}

export function invalidArgs(args: Record<string, unknown>): string | undefined {
  const v = args[INVALID_ARGS_KEY]
  return typeof v === "string" ? v : undefined
}

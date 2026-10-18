import type { MessageDisplay, UserContent } from "@amira/ai"

export type ErrorCode =
  | "parse_error"
  | "invalid_request"
  | "unknown_command"
  | "invalid_params"
  | "busy"
  | "not_found"
  | "not_supported"
  | "command_failed"
  | "internal"

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type Id = string | number | null
export type Params = Record<string, unknown>

/** Blank input is ignored; invalid JSON and non-object commands retain their legacy errors. */
export function parseRequest(line: string): Params | undefined {
  if (!line.trim()) return undefined
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch (err) {
    throw new RpcError("parse_error", err instanceof Error ? err.message : String(err))
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    throw new RpcError("invalid_request", "a command must be a JSON object")
  }
  return msg as Params
}

export function text(p: Params, key = "text"): string {
  const v = p[key]
  if (typeof v !== "string") throw new RpcError("invalid_params", `"${key}" must be a string`)
  return v
}

export function display(value: unknown): MessageDisplay | undefined {
  if (value === undefined) return undefined
  const d = value as { text?: unknown; note?: unknown } | null
  if (typeof d?.text !== "string" || !d.text.trim() || (d.note !== undefined && typeof d.note !== "string")) {
    throw new RpcError("invalid_params", '"display" must be {text, note?} with string values, text not blank')
  }
  return { text: d.text, ...(d.note !== undefined ? { note: d.note } : {}) }
}

export function attachments(value: unknown): UserContent[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RpcError("invalid_params", '"attachments" must be an array')
  return value.map((a, i) => {
    if (a?.type === "text" && typeof a.text === "string") return { type: "text", text: a.text }
    if (a?.type === "image" && typeof a.mimeType === "string" && typeof a.data === "string") {
      return { type: "image", mimeType: a.mimeType, data: a.data }
    }
    throw new RpcError(
      "invalid_params",
      `attachments[${i}] must be {type:"text",text} or {type:"image",mimeType,data}`,
    )
  })
}

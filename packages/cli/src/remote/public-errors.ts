import type { FrontendUpdate } from "@amira/core"

type ErrorUpdate = Extract<FrontendUpdate, { kind: "error" }>
const messages = {
  invalid_snapshot: "Workspace display state is unavailable.",
} satisfies Record<ErrorUpdate["error"]["code"], string>

/** Remote diagnostics are public facts, never exception text from the executing host. */
export function publicUpdateError(code: unknown = "invalid_snapshot"): ErrorUpdate {
  const key =
    typeof code === "string" && Object.hasOwn(messages, code)
      ? (code as keyof typeof messages)
      : "invalid_snapshot"
  const error: ErrorUpdate["error"] = { code: key, message: messages[key] }
  return Object.freeze(
    Object.assign(Object.create(null), {
      kind: "error",
      error: Object.freeze(Object.assign(Object.create(null), error)),
    }),
  )
}

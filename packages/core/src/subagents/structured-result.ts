import { type JSONSchema, type Message, type UserMessage, userMessage } from "@amira/ai"
import { RETURN_RESULT_TOOL, type ToolDefinition, textResult } from "@amira/api"
import { validateValue } from "../json-schema.ts"

/** What a child spawned with a schema is asked for, and what it handed back so far. */
export interface ResultSpec {
  schema: JSONSchema
  /** The schema is not an object's: the tool takes it as `{ value }`. */
  wrapped: boolean
  /**
   * Attempts that failed: a call whose value did not fit, or a turn that ended without any
   * such call and without a valid result. One turn with a bad call counts once, not twice.
   */
  strikes: number
  /** The turn running now already counted a call that did not fit. */
  struck?: boolean
  /** The last reason an attempt failed. */
  problem?: string
  returned?: { value: unknown }
  /** No attempts are left. */
  failed?: boolean
}

export function isObjectSchema(schema: JSONSchema): boolean {
  return schema.type === "object" || (schema.type === undefined && typeof schema.properties === "object")
}

export function resultInstructions(): string {
  return [
    "# Result",
    `When you have finished the task, hand back your result by calling the ${RETURN_RESULT_TOOL} tool; its parameters describe the result expected. Your turn ends with that call, so make it last, and do not also write the result out as text. If the call reports a problem, call it again with a corrected result.`,
  ].join("\n")
}

export function resultReminder(spec: ResultSpec): UserMessage {
  const why = spec.problem ? ` (${spec.problem})` : ""
  return userMessage(
    `You have not handed back a valid result yet${why}. Call ${RETURN_RESULT_TOOL} now with your result, matching its parameters. (Sent automatically.)`,
    { text: `◆ asked again for its result${why}`, origin: "subagent" },
  )
}

/** The tool a child with a schema returns its result with; it checks the value fully. */
export function returnResultTool(spec: ResultSpec, retries: number): ToolDefinition {
  const parameters: JSONSchema = spec.wrapped
    ? { type: "object", properties: { value: spec.schema }, required: ["value"] }
    : spec.schema
  return {
    name: RETURN_RESULT_TOOL,
    description:
      "Hands back the result of your task, as the parameters describe it. Call it once, when you are done; your turn ends with it.",
    parameters,
    traits: { readOnly: true },
    async execute(args) {
      const value = spec.wrapped ? (args as { value?: unknown }).value : args
      const problems = validateValue(spec.schema, value)
      if (problems.length) {
        const left = retries + 1 - (spec.strikes + 1)
        return textResult(
          `The result does not fit: ${problems.join("; ")}.${left > 0 ? ` Call ${RETURN_RESULT_TOOL} again with a corrected result.` : ""}`,
          true,
        )
      }
      spec.returned = { value: structuredClone(value) }
      return textResult("Result received.")
    },
  }
}

/** Counts failed structured-result attempts after a tool batch or an ended turn. */
export function checkResult(
  messages: readonly Message[],
  spec: ResultSpec,
  retries: number,
  turnEnded = false,
): boolean {
  if (spec.returned) return true
  const limit = retries + 1
  if (turnEnded) {
    // A turn whose bad call was counted already is not counted again for ending without one.
    if (!spec.struck) {
      spec.strikes++
      spec.problem ??= `it ended its turn without calling ${RETURN_RESULT_TOOL}`
    }
    spec.struck = false
  } else {
    const from = messages.findLastIndex((m) => m.role === "assistant")
    for (const m of messages.slice(from + 1)) {
      if (m.role === "toolResult" && m.toolName === RETURN_RESULT_TOOL && m.isError) {
        spec.strikes++
        spec.struck = true
        const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ")
        spec.problem = text.replace(/\s+/g, " ").trim().slice(0, 500)
      }
    }
  }
  if (spec.strikes >= limit) spec.failed = true
  // Out of attempts: the turn ends, and so does the child, with an error.
  return spec.failed === true
}

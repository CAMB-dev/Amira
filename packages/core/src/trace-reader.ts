import { readFile } from "node:fs/promises"
import type { TraceRecord } from "@amira/api"

/** Reads completed v1 records; missing/unreadable files and torn lines are harmless. */
export async function readTrace(file: string): Promise<TraceRecord[]> {
  let text: string
  try {
    text = await readFile(`${file}.trace.jsonl`, "utf8")
  } catch {
    return []
  }
  const records: TraceRecord[] = []
  let supported = false
  for (const line of text.split("\n")) {
    try {
      const record: unknown = JSON.parse(line)
      if (!object(record)) continue
      if (record.type === "trace") supported = record.v === 1 && isRecord(record)
      if (supported && isRecord(record)) records.push(record)
    } catch {
      // A crashed writer or a snapshot taken during an append can leave a torn line.
    }
  }
  return records
}

type Check = (value: unknown) => boolean
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const string: Check = (value) => typeof value === "string"
const number: Check = (value) => typeof value === "number" && Number.isFinite(value)
const boolean: Check = (value) => typeof value === "boolean"
const array =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check)
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value)

function fields(value: Record<string, unknown>) {
  return {
    required: (check: Check, ...keys: string[]) => keys.every((key) => check(value[key])),
    optional: (check: Check, ...keys: string[]) =>
      keys.every((key) => value[key] === undefined || check(value[key])),
  }
}

function usage(value: unknown): boolean {
  if (!object(value)) return false
  const { required, optional } = fields(value)
  return (
    required(number, "input", "output", "cacheRead", "cacheWrite") &&
    optional(number, "reasoning", "webSearchRequests", "webSearchCost", "cost")
  )
}

function retry(value: unknown): boolean {
  if (!object(value)) return false
  const { required } = fields(value)
  return required(number, "at", "delayMs") && required(string, "kind")
}

function failure(value: unknown): boolean {
  return object(value) && fields(value).required(string, "kind", "message")
}

function isRecord(value: Record<string, unknown>): value is Record<string, unknown> & TraceRecord {
  const { required, optional } = fields(value)
  switch (value.type) {
    case "diagnostic":
      return required(number, "at") && required(string, "message")
    case "trace":
      return (
        value.v === 1 &&
        required(string, "sessionId") &&
        required(number, "startedAt") &&
        optional(string, "parentSessionId", "role", "title")
      )
    case "turn":
      return (
        required(string, "turnId") &&
        required(number, "start", "end", "steps") &&
        required(oneOf("done", "error", "aborted"), "reason") &&
        optional(failure, "failure")
      )
    case "model":
      return (
        required(string, "model") &&
        required(number, "start", "end") &&
        optional(string, "turnId", "stopReason") &&
        optional(number, "firstToken") &&
        optional(usage, "usage") &&
        optional(array(retry), "retries")
      )
    case "tool":
      return (
        required(string, "toolCallId", "name", "argsPreview", "resultPreview") &&
        required(number, "start", "end", "durationMs", "argsChars", "resultChars") &&
        required(oneOf("ok", "error", "denied", "aborted", "invalid", "unknown-tool"), "outcome") &&
        optional(string, "turnId", "artifact") &&
        optional(number, "approvalWaitMs") &&
        optional(oneOf("user", "rule"), "approval") &&
        optional(array(string), "writtenPaths")
      )
    case "status":
      return (
        required(number, "at") &&
        required(oneOf("idle", "working", "blocked", "error"), "status") &&
        optional(string, "reason")
      )
    case "subagent":
      return (
        required(string, "childSessionId", "status") &&
        required(number, "start", "end", "durationMs") &&
        optional(string, "toolCallId", "role", "title", "groupId", "error") &&
        optional(number, "queuedAt") &&
        optional(usage, "usage")
      )
    case "compact":
      return (
        required(string, "reason") &&
        required(number, "start", "end") &&
        optional(number, "tokensBefore", "tokensAfter") &&
        optional(boolean, "native", "fallback") &&
        optional(usage, "usage")
      )
    case "side":
      return (
        required(string, "model") &&
        required(number, "at") &&
        optional(string, "label") &&
        optional(usage, "usage")
      )
    default:
      return false
  }
}

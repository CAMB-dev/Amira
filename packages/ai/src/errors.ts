import type { ModelError } from "./types.ts"

/**
 * What kind of failure a model request met, for what to tell the user:
 * - `auth`: the key was rejected (401, 403);
 * - `rate`: a rate limit (429);
 * - `server`: the provider failed (5xx, overloaded);
 * - `network`: the provider could not be reached, or the connection broke;
 * - `context`: the request did not fit the model's context window;
 * - `config`: nothing was sent (no model, no provider, no key);
 * - `other`: anything else, e.g. a request the provider refused.
 */
export type ModelErrorKind = "auth" | "rate" | "server" | "network" | "context" | "config" | "other"

/** A failed model request as the user reads it: one line, the next step, and the raw text. */
export interface ModelErrorInfo {
  kind: ModelErrorKind
  /** One line in plain words, e.g. "The API key was rejected by api.deepseek.com (HTTP 401)". */
  summary: string
  /** What to do next, e.g. "Set a new key with /provider key deepseek". */
  hint?: string
  /** What the provider said, as it said it (JSON bodies included), when that adds to the summary. */
  detail?: string
}

/** Recovery after a partial reply times out: shared by the raw error and the TUI notice. */
export const IDLE_TIMEOUT_HINT = "Type a message to continue, or press ↑ to resend."

/** Codes of failures that happen before anything is sent (the ai client's own). */
const CONFIG_CODES = new Set(["no_model", "unknown_provider", "unknown_dialect", "missing_api_key"])

/** How providers say a request is over the context window, in their codes or messages. */
const CONTEXT_CODES = new Set(["context_length_exceeded", "string_above_max_length", "request_too_large"])
const CONTEXT_TEXT =
  /context[ _-]?(length|window|limit)|maximum context|prompt is too long|input is too long|too many (input )?tokens|exceeds? the (model'?s? )?(context|token limit|maximum)|reduce the length of the messages|input token count/i

/** Whether the error says the request did not fit the model's context window. */
export function isContextOverflow(e: ModelError): boolean {
  if (e.code && CONTEXT_CODES.has(e.code)) return true
  if (e.status !== undefined && e.status !== 400 && e.status !== 413 && e.status !== 422) return false
  return CONTEXT_TEXT.test(e.message)
}

export function modelErrorKind(e: ModelError): ModelErrorKind {
  if (e.code && CONFIG_CODES.has(e.code)) return "config"
  if (isContextOverflow(e)) return "context"
  const s = e.status
  if (s === 401 || s === 403) return "auth"
  if (s === 429) return "rate"
  if (s !== undefined && (s >= 500 || s === 408)) return "server"
  if (s === undefined && /^(request|stream) failed/.test(e.message)) return "network"
  return "other"
}

export interface DescribeOptions {
  /** The provider's id, for the commands in hints (e.g. /provider key <id>). */
  provider?: string
}

/**
 * The user's reading of a failed model request (the wording follows the provider probe's):
 * a line, the next step, and the provider's own text as detail. `error.host` and
 * `error.retries` (set by the ai client) name the host and say it was retried.
 */
export function describeModelError(e: ModelError, opts: DescribeOptions = {}): ModelErrorInfo {
  const kind = e.kind ?? modelErrorKind(e)
  const where = e.host || "the provider"
  const said = providerMessage(e.message)
  const http = e.status !== undefined ? ` (HTTP ${e.status})` : ""
  const retried = e.retries ? `, retried ${e.retries} ${e.retries === 1 ? "time" : "times"}` : ""
  const detail = e.message
  const id = opts.provider
  // Locally generated idle timeouts after visible content need the continuation hint in
  // the primary TUI notice, not folded into the generic server error's detail.
  const idleSuffix = `. ${IDLE_TIMEOUT_HINT}`
  if (e.code === "timeout" && e.message.endsWith(idleSuffix)) {
    return {
      kind,
      summary: `${capitalize(e.message.slice(0, -idleSuffix.length))}${retried}`,
      hint: IDLE_TIMEOUT_HINT,
      detail,
    }
  }
  switch (kind) {
    case "auth":
      return {
        kind,
        summary: `The API key was rejected by ${where}${http}`,
        hint: id ? `Set a new key with /provider key ${id}` : "Set a new key with /provider key <id>",
        detail,
      }
    case "rate":
      return {
        kind,
        summary: `Rate limited by ${where}${http}${retried}`,
        hint: "Try again in a moment, or switch models with /model",
        detail,
      }
    case "server":
      return {
        kind,
        summary: `${where} failed to answer${http}${retried}`,
        hint: "Try again later, or switch models with /model",
        detail,
      }
    case "network": {
      const why = e.message.replace(/^(request|stream) failed:\s*/, "")
      const broke = e.message.startsWith("stream failed")
      return {
        kind,
        summary: broke
          ? `The connection to ${where} broke off${retried}: ${short(why)}`
          : `Cannot reach ${where}${retried}: ${short(why)}`,
        hint: id
          ? `Check your network, or the provider's base URL with /provider edit ${id}`
          : "Check your network, or the provider's base URL with /provider",
      }
    }
    case "context":
      return {
        kind,
        summary: `The conversation is too long for the model's context window${http}`,
        hint: "Run /compact, or switch to a model with a larger window with /model",
        detail,
      }
    case "config":
      return { kind, summary: capitalize(e.message) }
    default:
      return {
        kind,
        summary: `Model request failed${http}: ${short(said)}`,
        hint: "Send again, or switch models with /model",
        ...(said !== e.message ? { detail } : {}),
      }
  }
}

/** The message inside an HTTP error body ("HTTP 400: {"error":{"message":…}}"), else the text itself. */
export function providerMessage(message: string): string {
  const m = /^HTTP \d{3}: ([\s\S]*)$/.exec(message)
  if (!m) return message
  const body = m[1]!.trim()
  try {
    const j = JSON.parse(body)
    const e = Array.isArray(j) ? j[0]?.error : j?.error
    const text = typeof e === "string" ? e : (e?.message ?? j?.message)
    if (typeof text === "string" && text) return text
  } catch {}
  return body || message
}

function short(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

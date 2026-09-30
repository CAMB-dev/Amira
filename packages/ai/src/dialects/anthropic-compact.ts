import type { DialectCompaction, DialectCompactOutcome, DialectContext } from "../dialect.ts"
import { isUnsupportedCompaction } from "../native-compaction.ts"
import type { ModelError, ModelRequest, Usage } from "../types.ts"
import { anthropicError, isRetryableStatus } from "./anthropic-errors.ts"
import type { AnthropicMessage } from "./anthropic-messages.ts"
import { decodeCompactionBlock } from "./anthropic-messages.ts"
import { requestBody } from "./anthropic-request.ts"

/**
 * The beta of compaction on demand: the request carries `compaction: {type: "summarize"}` and
 * this header, as does every later request that carries the compaction block.
 */
export const COMPACT_BETA = "compact-2026-09-04"

/** Headers with `beta` added to any anthropic-beta list already there (whatever its case). */
export function withBeta(headers: Record<string, string>, beta: string): Record<string, string> {
  const out: Record<string, string> = {}
  const betas: string[] = []
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "anthropic-beta")
      betas.push(
        ...v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    else out[k] = v
  }
  if (!betas.includes(beta)) betas.push(beta)
  out["anthropic-beta"] = betas.join(",")
  return out
}

/** Whether a request body's messages carry a compaction block (and so need the beta). */
export function carriesCompaction(messages: unknown): boolean {
  return (
    Array.isArray(messages) &&
    (messages as AnthropicMessage[]).some((m) => m.content.some((b) => b.type === "compaction"))
  )
}

/** Errors that concern this compaction, not whether the endpoint has the feature. */
const OWN_ERRORS =
  /compaction_(unavailable|signature_invalid|content_mismatch|nothing_to_summarize|block_misplaced)/

/**
 * Anthropic's compaction on demand (beta compact-2026-09-04): the history to compact, sent
 * with the conversation's system prompt and tools and `compaction: {type: "summarize"}`,
 * comes back as one signed compaction block with a readable summary. On by default only for
 * api.anthropic.com. It replays as an assistant message of its own, first in `messages`, so
 * the only layout is "tail". What is not confirmed first hand: the request is sent without
 * streaming, as the docs show no stream events for the block; `usage.iterations` entries of
 * type "compaction" hold the tokens (top-level usage is taken when there are none).
 */
export const anthropicCompaction: DialectCompaction = {
  methods: ["summarize"],
  layouts: ["tail"],
  official(baseUrl) {
    try {
      return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com"
    } catch {
      return false
    }
  },
  compact: (_method, req, ctx) => summarize(req, ctx),
}

async function summarize(req: ModelRequest, ctx: DialectContext): Promise<DialectCompactOutcome> {
  const body = { ...requestBody(req, ctx.compat), stream: false, compaction: { type: "summarize" } }
  if (ctx.signal.aborted) return aborted()
  let res: Response
  try {
    res = await ctx.fetch(messagesUrlOf(ctx.endpoint.baseUrl), {
      method: "POST",
      headers: withBeta(
        {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(ctx.endpoint.apiKey ? { "x-api-key": ctx.endpoint.apiKey } : {}),
          ...ctx.endpoint.headers,
        },
        COMPACT_BETA,
      ),
      body: JSON.stringify(body),
      signal: ctx.signal,
    })
  } catch (e) {
    if (ctx.signal.aborted) return aborted()
    return failure({ message: `request failed: ${(e as Error).message}` }, true)
  }
  let text: string
  try {
    text = await res.text()
  } catch (e) {
    if (ctx.signal.aborted) return aborted()
    return failure({ message: `stream failed: ${(e as Error).message}` }, true)
  }
  let json: any
  try {
    json = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const parsed =
      json && typeof json === "object" && "error" in json ? anthropicError(json, res.status) : undefined
    const error: ModelError = {
      ...parsed?.error,
      message: `HTTP ${res.status}: ${parsed ? parsed.error.message : text.slice(0, 500)}`,
      status: res.status,
    }
    return failure(error, isRetryableStatus(res.status))
  }
  if (json?.type !== "message" || !Array.isArray(json.content)) {
    return {
      ok: false,
      error: { message: `expected a message, got: ${text.slice(0, 200)}` },
      unsupported: true,
      retryable: false,
    }
  }
  const usage = usageOf(json.usage)
  const blocks = (json.content as unknown[]).flatMap((b) => {
    const c = decodeCompactionBlock(JSON.stringify(b))
    return c ? [c] : []
  })
  const [block, ...more] = blocks
  if (block && !more.length) {
    return { ok: true, value: JSON.stringify(block), summary: block.content, ...(usage ? { usage } : {}) }
  }
  // No block but an answer: the server ignored the compaction field. No block and nothing
  // else: no summary could be written this time (stop_reason says why).
  const answered = json.content.length > 0 && !block
  const why = block
    ? `expected exactly one compaction block, got ${blocks.length}`
    : answered
      ? "the server answered without compacting"
      : `no summary was written (stop_reason: ${json.stop_reason ?? "unknown"})`
  return {
    ok: false,
    error: { message: why },
    unsupported: answered,
    retryable: false,
    ...(usage ? { usage } : {}),
  }
}

/** Tokens of the compaction pass: its `usage.iterations` entries, else the top-level counts. */
function usageOf(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined
  const n = (v: unknown) => (typeof v === "number" ? v : 0)
  const parts = Array.isArray(u.iterations)
    ? (u.iterations as any[]).filter((i) => i?.type === "compaction")
    : []
  const from = parts.length ? parts : [u]
  const out: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const p of from) {
    out.input += n(p.input_tokens)
    out.output += n(p.output_tokens)
    out.cacheRead += n(p.cache_read_input_tokens)
    out.cacheWrite += n(p.cache_creation_input_tokens)
  }
  return out
}

function messagesUrlOf(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "")
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`
}

function failure(error: ModelError, retryable: boolean): DialectCompactOutcome {
  const own = OWN_ERRORS.test(`${error.code ?? ""} ${error.message}`)
  return {
    ok: false,
    error,
    unsupported: !own && isUnsupportedCompaction(error.status, error.message),
    retryable,
  }
}

function aborted(): DialectCompactOutcome {
  return { ok: false, error: { message: "aborted", code: "aborted" }, unsupported: false, retryable: false }
}

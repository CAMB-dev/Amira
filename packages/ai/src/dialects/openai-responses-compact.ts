import type { DialectCompaction, DialectCompactOutcome, DialectContext } from "../dialect.ts"
import { isUnsupportedCompaction } from "../native-compaction.ts"
import { requestHeaders } from "../request-headers.ts"
import { isOpenAIVendorUrl } from "../server-tools.ts"
import { adaptThinking } from "../thinking.ts"
import type { ModelError, ModelRequest, StreamEvent, Usage } from "../types.ts"
import { parseJSON, postStream, type StreamRequest } from "./http-stream.ts"
import { isRetryableStatus } from "./openai-chat-errors.ts"
import { mapUsage, ResponsesAccumulator } from "./openai-responses-accumulate.ts"
import {
  type CompactionItem,
  decodeCompaction,
  RESPONSES_DIALECT,
  toResponsesInput,
} from "./openai-responses-input.ts"

/** The vendor's own Responses API (api.openai.com, Azure OpenAI), where compaction is on by default. */
export const isOfficialResponsesUrl = isOpenAIVendorUrl

/**
 * The Responses API's server-side compaction. Two ways, in order:
 * - "trigger": the history with a `compaction_trigger` item last, as an ordinary streaming
 *   /responses request (what Codex uses). It works only if the reply holds exactly one
 *   compaction item; a server that does not know the trigger may just answer, which counts
 *   as unsupported.
 * - "endpoint": `POST /responses/compact`, a plain JSON request; only the compaction item of
 *   the window it returns is kept, and Amira lays out the rest itself (Unconfirmed: the guide
 *   asks for the returned window to be used as is; the retained items it returns are the user
 *   messages, which the "recent-user" layout keeps too).
 * `context_management` (compaction in the middle of a normal reply) is not used.
 */
export function responsesCompaction(
  body: (req: ModelRequest) => Record<string, unknown>,
  readers: Readers,
): DialectCompaction {
  return {
    methods: ["trigger", "endpoint"],
    layouts: ["tail", "recent-user"],
    midTurn: true,
    official: isOfficialResponsesUrl,
    compact(method, req, ctx, onProgress) {
      return method === "endpoint" ? viaEndpoint(req, ctx) : viaTrigger(req, ctx, body, readers, onProgress)
    },
  }
}

async function viaTrigger(
  req: ModelRequest,
  ctx: DialectContext,
  body: (req: ModelRequest) => Record<string, unknown>,
  readers: Readers,
  onProgress?: () => void,
): Promise<DialectCompactOutcome> {
  const acc = new ResponsesAccumulator({ provider: req.model.provider, model: req.model.id }, onProgress)
  const payload = body(req)
  // "Must be the final input item."
  ;(payload.input as unknown[]).push({ type: "compaction_trigger" })
  const { apiKey, baseUrl } = ctx.endpoint
  let terminal: StreamEvent | undefined
  for await (const ev of postStream({
    ctx,
    acc,
    url: `${baseUrl.replace(/\/$/, "")}/responses`,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    body: payload,
    ...readers,
  })) {
    if (ev.type === "done" || ev.type === "error") terminal = ev
  }
  const usage = acc.message.usage
  if (terminal?.type === "error") return failure(terminal.error, terminal.retryable, usage)
  return oneItem(acc.compactions, usage, "compaction_trigger")
}

async function viaEndpoint(req: ModelRequest, ctx: DialectContext): Promise<DialectCompactOutcome> {
  const { apiKey, baseUrl, headers } = ctx.endpoint
  // Only the fields the reference lists for this endpoint (Codex also sent tools, reasoning
  // and text before it stopped using it; unconfirmed whether the server takes them).
  const payload: Record<string, unknown> = {
    model: req.model.id,
    input: toResponsesInput(adaptThinking(req.messages, RESPONSES_DIALECT), {
      images: req.model.caps.images,
    }),
  }
  if (req.systemPrompt) payload.instructions = req.systemPrompt
  if (ctx.signal.aborted) return aborted()
  let res: Response
  try {
    res = await ctx.fetch(`${baseUrl.replace(/\/$/, "")}/responses/compact`, {
      method: "POST",
      headers: requestHeaders(
        {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        headers,
        ctx.userAgent,
      ),
      body: JSON.stringify(payload),
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
  if (!res.ok) {
    const error: ModelError = { message: `HTTP ${res.status}: ${text.slice(0, 500)}`, status: res.status }
    return failure(error, isRetryableStatus(res.status))
  }
  const json = parseJSON(text)
  if (!Array.isArray(json?.output)) {
    // Not the compacted window: a server without this route answering something else.
    return {
      ok: false,
      error: { message: `expected a compacted window from /responses/compact, got: ${text.slice(0, 200)}` },
      unsupported: true,
      retryable: false,
    }
  }
  const items = (json.output as unknown[]).flatMap((item) => {
    const c = decodeCompaction(JSON.stringify(item))
    return c ? [c] : []
  })
  return oneItem(items, json.usage ? mapUsage(json.usage) : undefined, "/responses/compact")
}

type Readers = Pick<StreamRequest<ResponsesAccumulator>, "readSSE" | "readPlain">

/** Success only with exactly one compaction item, as Codex checks. */
function oneItem(items: CompactionItem[], usage: Usage | undefined, how: string): DialectCompactOutcome {
  const [item, ...more] = items
  if (!item) {
    // A server that does not know the trigger may simply answer the conversation.
    return {
      ok: false,
      error: { message: `the server returned no compaction item for ${how}` },
      unsupported: true,
      retryable: false,
      ...(usage ? { usage } : {}),
    }
  }
  if (more.length) {
    return {
      ok: false,
      error: { message: `expected exactly one compaction item for ${how}, got ${items.length}` },
      unsupported: false,
      retryable: false,
      ...(usage ? { usage } : {}),
    }
  }
  return { ok: true, value: JSON.stringify(item), ...(usage ? { usage } : {}) }
}

function failure(error: ModelError, retryable: boolean, usage?: Usage): DialectCompactOutcome {
  if (error.code === "aborted") return aborted()
  return {
    ok: false,
    error,
    unsupported: isUnsupportedCompaction(error.status, error.message),
    retryable,
    ...(usage && (usage.input || usage.output) ? { usage } : {}),
  }
}

function aborted(): DialectCompactOutcome {
  return { ok: false, error: { message: "aborted", code: "aborted" }, unsupported: false, retryable: false }
}

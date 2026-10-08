import { createAi } from "./client.ts"
import type { ProviderCompat } from "./dialect.ts"
import { ANTHROPIC_VERSION } from "./dialects/anthropic.ts"
import { requestHeaders } from "./request-headers.ts"
import { userMessage } from "./types.ts"

/** Where to reach a provider that may not be registered yet, e.g. one being set up in a form. */
export interface ProbeEndpoint {
  dialect: string
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  compat?: ProviderCompat
}

export interface ProbeOptions {
  fetch?: typeof fetch
  /** User-Agent for HTTP requests; endpoint headers can override it. */
  userAgent?: string
  /** Gives up after this long. Default 15 s for listing, 30 s for a test request. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** A model a provider lists; the limits are there when its list endpoint says (Gemini, OpenRouter). */
export interface ListedModel {
  id: string
  name?: string
  contextWindow?: number
  maxOutput?: number
}

export type ProbeFailure =
  | "auth"
  | "not_found"
  | "network"
  | "timeout"
  | "http"
  | "format"
  | "unsupported"
  | "aborted"

/** A failed probe, with a message fit to show the user (the API key is never in it). */
export class ProbeError extends Error {
  constructor(
    message: string,
    readonly kind: ProbeFailure,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** Dialects whose model list Amira knows how to read. */
export const LISTABLE_DIALECTS = ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"]

const PAGES = 20

/**
 * Asks a provider which models it has: GET {baseUrl}/models for OpenAI-compatible servers,
 * GET /v1/models (paged) for Anthropic, and the models list (paged, only models that can
 * generate content) for Gemini. Throws a ProbeError that says what went wrong.
 */
export async function listModels(ep: ProbeEndpoint, opts: ProbeOptions = {}): Promise<ListedModel[]> {
  const base = ep.baseUrl.replace(/\/+$/, "")
  const get = (url: string, headers: Record<string, string>) =>
    getJson(
      url,
      requestHeaders({ accept: "application/json", ...headers }, ep.headers, opts.userAgent),
      ep.apiKey,
      opts,
      opts.timeoutMs ?? 15_000,
    )
  switch (ep.dialect) {
    case "openai-chat":
    case "openai-responses": {
      const body = await get(`${base}/models`, ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {})
      const data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : undefined
      if (!data) throw new ProbeError(`${host(base)} answered without a model list ("data")`, "format")
      return uniq(
        data.flatMap((m: any): ListedModel[] => {
          if (typeof m?.id !== "string" || !m.id) return []
          const out: ListedModel = { id: m.id }
          if (typeof m.name === "string" && m.name !== m.id) out.name = m.name
          const ctx = m.context_length ?? m.context_window ?? m.max_model_len
          if (positive(ctx)) out.contextWindow = ctx
          const maxOut = m.top_provider?.max_completion_tokens ?? m.max_output_tokens
          if (positive(maxOut)) out.maxOutput = maxOut
          return [out]
        }),
      )
    }
    case "anthropic-messages": {
      const root = /\/v1$/.test(base) ? base : `${base}/v1`
      const headers: Record<string, string> = {
        "anthropic-version": ANTHROPIC_VERSION,
        ...(ep.apiKey ? { "x-api-key": ep.apiKey } : {}),
      }
      const out: ListedModel[] = []
      let after: string | undefined
      for (let page = 0; page < PAGES; page++) {
        const q = new URLSearchParams({ limit: "1000", ...(after ? { after_id: after } : {}) })
        const body = await get(`${root}/models?${q}`, headers)
        if (!Array.isArray(body?.data))
          throw new ProbeError(`${host(base)} answered without a model list`, "format")
        for (const m of body.data) {
          if (typeof m?.id !== "string") continue
          out.push({ id: m.id, ...(typeof m.display_name === "string" ? { name: m.display_name } : {}) })
        }
        if (!body.has_more || typeof body.last_id !== "string") break
        after = body.last_id
      }
      return uniq(out)
    }
    case "google-gemini": {
      const headers: Record<string, string> = ep.apiKey ? { "x-goog-api-key": ep.apiKey } : {}
      const out: ListedModel[] = []
      let token: string | undefined
      for (let page = 0; page < PAGES; page++) {
        const q = new URLSearchParams({ pageSize: "1000", ...(token ? { pageToken: token } : {}) })
        const body = await get(`${base}/models?${q}`, headers)
        if (!Array.isArray(body?.models))
          throw new ProbeError(`${host(base)} answered without a model list`, "format")
        for (const m of body.models) {
          if (typeof m?.name !== "string") continue
          const methods = m.supportedGenerationMethods
          if (Array.isArray(methods) && !methods.includes("generateContent")) continue
          const item: ListedModel = { id: m.name.replace(/^models\//, "") }
          if (typeof m.displayName === "string") item.name = m.displayName
          if (positive(m.inputTokenLimit)) item.contextWindow = m.inputTokenLimit
          if (positive(m.outputTokenLimit)) item.maxOutput = m.outputTokenLimit
          out.push(item)
        }
        if (typeof body.nextPageToken !== "string" || !body.nextPageToken) break
        token = body.nextPageToken
      }
      return uniq(out)
    }
    default:
      throw new ProbeError(
        `listing models is not supported for dialect "${ep.dialect}"; type the model ids instead`,
        "unsupported",
      )
  }
}

export interface ConnectionTest {
  ok: boolean
  /** From sending the request to its end. */
  latencyMs: number
  /** "OK: deepseek-chat answered in 412 ms", or what went wrong, without the API key. */
  message: string
  failure?: ProbeFailure
  status?: number
}

/**
 * Sends one tiny request (a short prompt, at most 16 output tokens, no retries) to `model`
 * through the provider's dialect, and says how it went: OK with the latency, the key was
 * rejected (401/403), wrong base URL or model (404), or which host could not be reached.
 */
export async function testConnection(
  ep: ProbeEndpoint,
  model: string,
  opts: ProbeOptions = {},
): Promise<ConnectionTest> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const ai = createAi({
    providers: [
      {
        id: "probe",
        dialect: ep.dialect,
        baseUrl: ep.baseUrl,
        ...(ep.apiKey ? { apiKey: ep.apiKey } : {}),
        ...(ep.headers ? { headers: ep.headers } : {}),
        ...(ep.compat ? { compat: ep.compat } : {}),
      },
    ],
    env: {},
    retry: { retries: 0 },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
  })
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const where = host(ep.baseUrl)
  const fail = (message: string, failure: ProbeFailure, status?: number): ConnectionTest => ({
    ok: false,
    latencyMs: elapsed(),
    message: redact(message, ep.apiKey),
    failure,
    ...(status !== undefined ? { status } : {}),
  })
  let info: ReturnType<typeof ai.model>
  try {
    info = ai.model(`probe/${model}`)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), "format")
  }
  try {
    const stream = ai.stream(
      { model: info, systemPrompt: "", messages: [userMessage("Say OK.")], tools: [], maxTokens: 16 },
      signal,
    )
    for await (const ev of stream) {
      if (ev.type === "done") {
        const ms = elapsed()
        return { ok: true, latencyMs: ms, message: `OK: ${model} answered in ${ms} ms` }
      }
      if (ev.type !== "error") continue
      const { status, message } = ev.error
      if (timeout.aborted)
        return fail(`no answer from ${where} within ${Math.round(timeoutMs / 1000)} s`, "timeout")
      if (opts.signal?.aborted) return fail("cancelled", "aborted")
      if (status === 401 || status === 403) {
        return fail(
          `the API key was rejected by ${where} (HTTP ${status}): ${short(message)}`,
          "auth",
          status,
        )
      }
      if (status === 404) {
        return fail(
          `HTTP 404 from ${where}: wrong base URL, or no model "${model}" there`,
          "not_found",
          status,
        )
      }
      if (status !== undefined) return fail(`HTTP ${status} from ${where}: ${short(message)}`, "http", status)
      if (message.startsWith("request failed")) {
        return fail(`cannot reach ${where}: ${message.replace(/^request failed:\s*/, "")}`, "network")
      }
      return fail(short(message), "http")
    }
    return fail("the response ended without a result", "format")
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), "network")
  }
}

/** Replaces the key, and anything that looks like part of it, in text meant for the user. */
export function redact(text: string, apiKey: string | undefined): string {
  if (!apiKey || apiKey.length < 4) return text
  let out = text.split(apiKey).join("***")
  // Error bodies sometimes echo the key half-masked, e.g. "sk-abc...wxyz"; drop its ends too.
  if (apiKey.length >= 12) {
    for (const part of [apiKey.slice(0, 8), apiKey.slice(-6)]) out = out.split(part).join("***")
  }
  return out
}

/** The host of a URL, for messages; the text itself when it is no URL. */
export function host(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  apiKey: string | undefined,
  opts: ProbeOptions,
  timeoutMs: number,
): Promise<any> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const where = host(url)
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(url, { headers, signal })
  } catch (err) {
    if (opts.signal?.aborted) throw new ProbeError("cancelled", "aborted")
    if (timeout.aborted)
      throw new ProbeError(`no answer from ${where} within ${Math.round(timeoutMs / 1000)} s`, "timeout")
    const why = err instanceof Error ? err.message : String(err)
    throw new ProbeError(redact(`cannot reach ${where}: ${why}`, apiKey), "network")
  }
  const text = await res.text().catch(() => "")
  if (res.status === 401 || res.status === 403) {
    throw new ProbeError(
      redact(`the API key was rejected by ${where} (HTTP ${res.status}): ${short(errorText(text))}`, apiKey),
      "auth",
      res.status,
    )
  }
  if (res.status === 404) {
    throw new ProbeError(
      `HTTP 404 from ${where}: is the base URL right? (asked ${stripQuery(url)})`,
      "not_found",
      404,
    )
  }
  if (!res.ok) {
    throw new ProbeError(
      redact(`HTTP ${res.status} from ${where}: ${short(errorText(text))}`, apiKey),
      "http",
      res.status,
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ProbeError(`${where} did not answer with JSON: is the base URL right?`, "format")
  }
}

/** The message of a JSON error body, or the text itself. */
function errorText(text: string): string {
  try {
    const j = JSON.parse(text)
    const e = Array.isArray(j) ? j[0]?.error : j?.error
    const m = typeof e === "string" ? e : (e?.message ?? j?.message)
    if (typeof m === "string" && m) return m
  } catch {}
  return text || "(no details)"
}

function stripQuery(url: string): string {
  return url.replace(/\?.*$/, "")
}

function short(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function uniq(models: ListedModel[]): ListedModel[] {
  const seen = new Set<string>()
  return models.filter((m) => !seen.has(m.id) && seen.add(m.id))
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0

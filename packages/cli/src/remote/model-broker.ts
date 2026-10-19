import type {
  Ai,
  CompactReceipt,
  CompactResult,
  ModelError,
  ModelInfo,
  ModelRequest,
  NativeCompaction,
  ReplayTarget,
  StreamEvent,
} from "@amira/ai"
import { emptyUsage } from "@amira/ai"
import { transferUsageAccounting } from "@amira/ai/accounting"
import { withAiRequestBoundary } from "@amira/ai/local"
import {
  assertModelOutbound,
  copyModelInfo,
  decodeCompactReceipt,
  decodeCompactResult,
  decodeModelEvent,
  decodeModelRequest,
  encodeCompactReceipt,
  encodeCompactResult,
  encodeModelEvent,
  encodeModelRequest,
  ModelOutboundError,
} from "./model-codec.ts"
import { ModelOutboundFilter, type ModelOutboundItem } from "./model-outbound-filter.ts"
import { redactModelValue } from "./model-string-masks.ts"
import type { ProviderBindings, ResolvedBinding } from "./provider-bindings.ts"

export interface ModelBrokerCall {
  bindingRevision: string
  request: ModelRequest
}

/** Only these credential-free facts are available to ProxyAi's synchronous queries. */
export interface ModelMetadata {
  revision: string
  model: ModelInfo
  available: boolean
  replay: ReplayTarget
  native?: NativeCompaction
}

export interface ModelBroker {
  /** Final envelope audit; kept local and never exposes the credential facts themselves. */
  assertOutbound?(call: ModelBrokerCall, frame: unknown): void
  metadata(models: readonly ModelInfo[]): ModelMetadata[]
  stream(call: ModelBrokerCall, signal?: AbortSignal): AsyncIterable<StreamEvent>
  compact(
    call: ModelBrokerCall,
    signal?: AbortSignal,
    onProgress?: () => void,
    onUsage?: (receipt: CompactReceipt) => void | Promise<void>,
  ): Promise<CompactResult>
}

function mapProvider<T>(value: T, from: string, to: string, identity = false): T {
  if (Array.isArray(value)) return value.map((item) => mapProvider(item, from, to)) as T
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, child] of Object.entries(value)) {
    // Never reinterpret arbitrary tool JSON, signed values or frontend-only details.
    if (["args", "input", "parameters", "details", "display", "searchEntryPoint"].includes(key))
      result[key] = child
    else {
      const childIdentity =
        (key === "model" && (record.role === "assistant" || Object.hasOwn(record, "systemPrompt"))) ||
        (key === "signature" && typeof record.type === "string") ||
        (key === "checkpoint" && record.ok === true)
      result[key] =
        identity && key === "provider" && child === from ? to : mapProvider(child, from, to, childIdentity)
    }
    if (key === "usage" && child && typeof child === "object")
      transferUsageAccounting(
        child as Parameters<typeof transferUsageAccounting>[0],
        result[key] as Parameters<typeof transferUsageAccounting>[1],
      )
  }
  return result as T
}

function safeModelError(error: ModelError): ModelError {
  const { status, kind, retries } = error
  return {
    message: "Local model provider request failed",
    code: "local_model_failure",
    ...(status !== undefined ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(retries !== undefined ? { retries } : {}),
  }
}

const unknownUsage = () => ({ ...emptyUsage(), pricingUnknown: true, outputReported: false })
const rejectedResponse = (): ModelError => ({
  message: "Local model response failed security validation",
  code: "proxy_broker_lost",
  kind: "network",
})

function safeError(event: StreamEvent): StreamEvent {
  return event.type === "error" || event.type === "retry"
    ? { ...event, error: safeModelError(event.error) }
    : event
}

export function createModelBroker({ ai, bindings }: { ai: Ai; bindings: ProviderBindings }): ModelBroker {
  const publications = new Map<string, { revision: string; filter: ModelOutboundFilter }>()
  const filterFor = (binding: ResolvedBinding) => {
    const publication = publications.get(binding.provider)
    return publication?.revision === binding.revision
      ? publication.filter.fork()
      : new ModelOutboundFilter(binding.secrets)
  }
  function prepare(call: ModelBrokerCall): { binding: ResolvedBinding; request: ModelRequest; local: Ai } {
    if (
      !call ||
      Object.keys(call).some((key) => key !== "bindingRevision" && key !== "request") ||
      typeof call.bindingRevision !== "string" ||
      !call.bindingRevision
    )
      throw new Error("Invalid model binding revision")
    const request = decodeModelRequest(encodeModelRequest(call.request))
    const binding = bindings.resolve(request.model, call.bindingRevision)
    return {
      binding,
      request: mapProvider(request, binding.provider, binding.localProvider),
      local: withAiRequestBoundary(ai, { origin: binding.endpointOrigin }),
    }
  }
  const restore = <T>(value: T, binding: ResolvedBinding): T =>
    redactModelValue(mapProvider(value, binding.localProvider, binding.provider), binding.secrets)

  return {
    assertOutbound(call, frame) {
      assertModelOutbound(frame, bindings.resolve(call.request.model, call.bindingRevision).secrets)
    },
    metadata(models) {
      const approved: ResolvedBinding[] = []
      const values: ModelMetadata[] = models.map((model) => {
        const remote = copyModelInfo(model)
        let binding: ResolvedBinding
        try {
          binding = bindings.resolve(remote)
        } catch {
          return {
            revision: "unbound",
            model: remote,
            available: false,
            replay: {
              dialect: remote.dialect,
              provider: remote.provider,
              host: "",
              model: remote.id,
              webSearch: false,
            },
          }
        }
        approved.push(binding)
        const local = { ...remote, provider: binding.localProvider }
        const target = ai.replayTarget(local)
        const native = ai.nativeCompaction(local)
        // Explicit construction, never spread Ai.providers()/providerEndpoint() into a DTO.
        return {
          revision: binding.revision,
          model: remote,
          available: ai.hasKey(binding.localProvider),
          replay: {
            dialect: remote.dialect,
            provider: remote.provider,
            host: new URL(`https://${target.host}`).host,
            model: remote.id,
            webSearch: target.webSearch && remote.caps.webSearch !== false,
          },
          ...(native
            ? {
                native: {
                  dialect: native.dialect,
                  methods: [...native.methods],
                  layouts: [...native.layouts],
                  midTurn: native.midTurn,
                },
              }
            : {}),
        }
      })
      const secrets = [...new Set(approved.flatMap((binding) => [...binding.secrets]))]
      const filter = new ModelOutboundFilter(secrets)
      const items = [...filter.push({ kind: "metadata", value: values }), ...filter.flush()]
      const metadata = items.find((item) => item.kind === "metadata")
      if (metadata?.kind !== "metadata") throw new ModelOutboundError()
      assertModelOutbound(metadata.value, secrets)
      publications.clear()
      for (const binding of approved)
        publications.set(binding.provider, { revision: binding.revision, filter: filter.fork() })
      return metadata.value
    },
    async *stream(call, signal) {
      const { binding, request, local } = prepare(call)
      const controller = new AbortController()
      const abort = () => controller.abort()
      if (signal?.aborted) controller.abort()
      signal?.addEventListener("abort", abort, { once: true })
      const filter = filterFor(binding)
      const partial: { type: "text" | "thinking"; text: string }[] = []
      let terminal = false
      const remember = (event: StreamEvent) => {
        if (event.type === "done" || event.type === "error") terminal = true
        if (event.type === "request.end") partial.length = 0
        if (event.type !== "text.delta" && event.type !== "thinking.delta") return event
        const type = event.type === "text.delta" ? "text" : "thinking"
        const last = partial.at(-1)
        if (last?.type === type) last.text += event.text
        else partial.push({ type, text: event.text })
        return event
      }
      try {
        for await (const event of local.stream(request, controller.signal)) {
          bindings.resolve(call.request.model, call.bindingRevision)
          let checked: StreamEvent
          try {
            const mapped = safeError(mapProvider(event, binding.localProvider, binding.provider))
            // Validate before queueing; the redactor also visits object keys and arbitrary tool JSON.
            checked = decodeModelEvent(encodeModelEvent(mapped))
          } catch {
            // Unrepresentable output is a boundary rejection, not a recoverable provider failure.
            throw new ModelOutboundError()
          }
          for (const safe of filter.push({ kind: "event", value: checked }))
            if (safe.kind === "event")
              yield remember(decodeModelEvent(encodeModelEvent(safe.value, binding.secrets)))
        }
        for (const safe of filter.flush())
          if (safe.kind === "event")
            yield remember(decodeModelEvent(encodeModelEvent(safe.value, binding.secrets)))
        if (!terminal) throw new Error("Model stream ended without a terminal event")
      } catch (error) {
        let rejected = error instanceof ModelOutboundError
        // Flush only audited partial updates, never an unsafe queued terminal.
        try {
          for (const safe of filter.flush()) {
            if (safe.kind !== "event" || safe.value.type === "done" || safe.value.type === "error") continue
            yield remember(decodeModelEvent(encodeModelEvent(safe.value, binding.secrets)))
          }
        } catch (flushError) {
          rejected ||= flushError instanceof ModelOutboundError
        }
        // Neither provider exceptions nor unrepresentable credentials cross this boundary.
        // Discarded terminal accounting is unknown even when the provider or iterator threw.
        const failed: StreamEvent = restore(
          {
            type: "error",
            retryable: false,
            error: rejected
              ? rejectedResponse()
              : { message: "Local model request failed", code: "local_model_failure", kind: "other" },
            message: {
              role: "assistant",
              content: partial,
              model: { provider: call.request.model.provider, model: call.request.model.id },
              usage: unknownUsage(),
              stopReason: signal?.aborted ? "aborted" : "error",
            },
          },
          binding,
        )
        filter.discard()
        for (const safe of [...filter.push({ kind: "event", value: failed }), ...filter.flush()])
          if (safe.kind === "event") yield decodeModelEvent(encodeModelEvent(safe.value, binding.secrets))
      } finally {
        controller.abort()
        signal?.removeEventListener("abort", abort)
      }
    },
    async compact(call, signal, onProgress, onUsage) {
      const { binding, request, local } = prepare(call)
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      let rejected = false
      let settled = false
      let output: CompactResult | undefined
      const filter = filterFor(binding)
      const deliver = (items: ModelOutboundItem[]) => {
        for (const item of items) {
          if (item.kind === "receipt") {
            const safe = decodeCompactReceipt(encodeCompactReceipt(item.value, binding.secrets))
            try {
              void Promise.resolve(onUsage?.(safe)).catch(() => {})
            } catch {}
          } else if (item.kind === "compact")
            output = decodeCompactResult(encodeCompactResult(item.value, binding.secrets))
          else throw new ModelOutboundError()
        }
      }
      try {
        const result = await local.compact(request, controller.signal, onProgress, (receipt) => {
          try {
            const value = decodeCompactReceipt(
              encodeCompactReceipt(mapProvider(receipt, binding.localProvider, binding.provider)),
            )
            deliver(filter.push({ kind: "receipt", value }))
            if (settled) deliver(filter.flush())
          } catch {
            rejected = true
            controller.abort()
            filter.discard()
            // Missing physical usage is incomplete, never a fabricated zero charge.
            deliver(
              filter.push({
                kind: "receipt",
                value: { id: receipt.id, late: receipt.late, usage: undefined },
              }),
            )
            deliver(filter.flush())
          }
        })
        bindings.resolve(call.request.model, call.bindingRevision)
        if (rejected) throw new ModelOutboundError()
        const cleaned = {
          ...result,
          tried: result.tried.map((attempt) => ({
            method: attempt.method,
            unsupported: attempt.unsupported,
            error: "Local compaction attempt failed",
          })),
          ...(!result.ok
            ? {
                error: "Local model compaction failed",
                ...(result.failure ? { failure: safeModelError(result.failure) } : {}),
              }
            : {}),
        }
        deliver(
          filter.push({
            kind: "compact",
            value: mapProvider(cleaned, binding.localProvider, binding.provider),
          }),
        )
        deliver(filter.flush())
        if (!output) throw new ModelOutboundError()
        return output
      } catch (error) {
        rejected ||= error instanceof ModelOutboundError
        const failed: CompactResult = restore(
          {
            ok: false,
            error: "Local model compaction failed",
            ...(rejected ? { failure: rejectedResponse() } : {}),
            usage: unknownUsage(),
            usageIncomplete: true,
            tried: [],
          },
          binding,
        )
        filter.discard()
        deliver(filter.push({ kind: "compact", value: failed }))
        deliver(filter.flush())
        if (!output) throw new ModelOutboundError()
        return output
      } finally {
        settled = true
        signal?.removeEventListener("abort", abort)
        controller.abort()
      }
    },
  }
}

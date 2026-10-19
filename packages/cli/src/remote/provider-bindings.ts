import { createHash, randomUUID } from "node:crypto"
import type { Ai, ModelInfo } from "@amira/ai"
import { resolvedEndpointCredentials } from "@amira/ai/local"
import { secretVariants } from "./secret-variants.ts"

/** Supplied by LOCAL approval UI/config only, never by an incoming model request. */
export interface ProviderBindingApproval {
  provider: string
  dialect: string
  localProvider: string
  endpointOrigin: string
}

interface Binding extends ProviderBindingApproval {
  revision: string
  fingerprint: string
  secrets: readonly string[]
}

export interface ResolvedBinding {
  provider: string
  localProvider: string
  dialect: string
  endpointOrigin: string
  revision: string
  /** Immutable, local-only facts shared by the approved snapshot's redactor and outbound audit. */
  secrets: readonly string[]
}

export class ModelBindingError extends Error {
  readonly code = "model_binding_rejected"
  constructor() {
    super("Model provider binding is missing, stale, or no longer approved")
  }
}

function endpointSnapshot(ai: Ai, approval: ProviderBindingApproval) {
  const provider = ai.providers().find((item) => item.id === approval.localProvider)
  if (!provider || provider.dialect !== approval.dialect) throw new ModelBindingError()
  const endpoint = ai.providerEndpoint(approval.localProvider)
  const url = new URL(endpoint.baseUrl)
  if (url.origin !== approval.endpointOrigin || !["http:", "https:"].includes(url.protocol))
    throw new ModelBindingError()
  const headers = Object.entries(endpoint.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const substitutions = resolvedEndpointCredentials(endpoint)
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        provider.dialect,
        endpoint.baseUrl,
        endpoint.apiKey,
        headers,
        substitutions,
        endpoint.credentialSource,
        provider.keySource,
        provider.apiKeyEnv,
        provider.apiKeyEnvFallbacks,
        provider.headers,
      ]),
    )
    .digest("hex")
  return { fingerprint, endpoint, url, headers, substitutions }
}

function snapshotSecrets({ endpoint, url, headers, substitutions }: ReturnType<typeof endpointSnapshot>) {
  const raw = [
    endpoint.apiKey,
    endpoint.baseUrl,
    url.username,
    url.password,
    ...headers.flat(),
    ...substitutions,
    ...url.searchParams.values(),
    ...url.search
      .slice(1)
      .split("&")
      .map((part) => part.slice(part.indexOf("=") + 1)),
    ...url.pathname.split("/").filter(Boolean),
    url.hash.slice(1),
  ].filter((value): value is string => Boolean(value))
  const headerValues = [endpoint.apiKey, ...headers.map(([, value]) => value), ...substitutions].filter(
    (value): value is string => Boolean(value),
  )
  return secretVariants(raw, headerValues)
}

/** In-memory approval registry; revocation or any resolved endpoint/credential change fails closed. */
export class ProviderBindings {
  readonly #ai: Ai
  readonly #bindings = new Map<string, Binding>()
  constructor(ai: Ai, approvals: ProviderBindingApproval[] = []) {
    this.#ai = ai
    for (const approval of approvals) this.approve(approval)
  }

  approve(approval: ProviderBindingApproval): string {
    try {
      const snapshot = endpointSnapshot(this.#ai, approval)
      const revision = randomUUID()
      this.#bindings.set(approval.provider, {
        ...approval,
        revision,
        fingerprint: snapshot.fingerprint,
        secrets: snapshotSecrets(snapshot),
      })
      return revision
    } catch {
      throw new ModelBindingError()
    }
  }

  revoke(provider: string): void {
    this.#bindings.delete(provider)
  }

  resolve(model: Pick<ModelInfo, "provider" | "dialect">, revision?: string): ResolvedBinding {
    const binding = this.#bindings.get(model.provider)
    if (
      !binding ||
      binding.dialect !== model.dialect ||
      (revision !== undefined && revision !== binding.revision)
    )
      throw new ModelBindingError()
    try {
      const snapshot = endpointSnapshot(this.#ai, binding)
      if (snapshot.fingerprint !== binding.fingerprint) throw new ModelBindingError()
      return {
        provider: binding.provider,
        localProvider: binding.localProvider,
        dialect: binding.dialect,
        endpointOrigin: binding.endpointOrigin,
        revision: binding.revision,
        secrets: binding.secrets,
      }
    } catch {
      throw new ModelBindingError()
    }
  }
}

export const createProviderBindings = (ai: Ai, approvals: ProviderBindingApproval[] = []) =>
  new ProviderBindings(ai, approvals)

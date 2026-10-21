import type { Ai } from "@amira/ai"
import type { FrontendExecuteOptions } from "@amira/core"
import type { ServerOperations } from "../server/operations.ts"
import type { BindingApprovals } from "./binding-approvals.ts"
import { createModelBroker } from "./model-broker.ts"
import { type ProviderBindingApproval, ProviderBindings } from "./provider-bindings.ts"
import { hasRemoteControlCharacters } from "./ssh.ts"

interface BindingRequester {
  request<K extends "proxy.describe" | "proxy.bind">(
    operation: K,
    params: ServerOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<ServerOperations[K]["result"]>
}

/** Local approval is never a remote form: no credential, endpoint or auth object crosses the wire. */
export function localModelBindings(
  ai: Ai,
  approve: (binding: ProviderBindingApproval & { remoteOrigin?: string }) => Promise<boolean>,
  approvals?: BindingApprovals,
) {
  const bindings = new ProviderBindings(ai)
  const broker = createModelBroker({ ai, bindings })
  const approvedOrigins = new Map<string, string>()
  return {
    broker,
    async negotiate(port: BindingRequester) {
      const description = await port.request("proxy.describe", {})
      if (!description.enabled) return
      const providers = new Map(description.models.map((model) => [model.provider, model]))
      for (const [provider, model] of providers) {
        const remoteOrigin = description.origins.find((item) => item.provider === provider)?.origin
        if ([provider, model.dialect, remoteOrigin ?? ""].some(hasRemoteControlCharacters))
          throw new Error("Remote provider identities must not contain terminal controls")
        const identity = JSON.stringify([model.dialect, remoteOrigin])
        if (approvedOrigins.get(provider) !== identity) bindings.revoke(provider)
        try {
          bindings.resolve(model)
          continue
        } catch {
          // A changed endpoint or credential invalidates the old approval, even on reconnect.
        }
        const local = ai.providers().find((item) => item.id === provider && item.dialect === model.dialect)
        if (!local) continue
        const endpointOrigin = new URL(ai.providerEndpoint(local.id).baseUrl).origin
        const approval = { provider, dialect: model.dialect, localProvider: local.id, endpointOrigin }
        const consent = { ...approval, remoteOrigin }
        const fingerprint = bindings.approvalFingerprint(approval)
        const remembered = await approvals?.approved(consent, fingerprint)
        if (remembered || (await approve(consent))) {
          bindings.approve(approval)
          approvedOrigins.set(provider, identity)
          if (!remembered) await approvals?.remember(consent, fingerprint)
        }
      }
      const metadata = broker.metadata(description.models)
      await port.request("proxy.bind", { metadata })
      return metadata
        .filter((item) => !item.available)
        .map((item) => `${item.model.provider}/${item.model.id}`)
    },
  }
}

import type { CommandDefinition } from "@amira/api"
import type { FrontendConnectionIssue } from "@amira/core"
import type { RemoteAgentPort, RemoteAttachIntent } from "./agent-port.ts"
import { clientLabel } from "./presence.ts"
import type { ProviderBindingApproval } from "./provider-bindings.ts"

type RolePort = Pick<RemoteAgentPort, "readOnly" | "presence" | "subscribePresence">

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined

/** Plain words for a refused /take; the daemon's reject text is generic on purpose. */
export function takeFailureText(error: unknown): string {
  switch (codeOf(error)) {
    case "controller_busy":
      return "Could not take control: the current controller cannot be taken over right now. It may be an Amira release without takeover support, or control changed hands less than a second ago. Try again shortly, or detach the other client."
    case "unsupported_capability":
      return "Could not take control: the current controller runs models through its own provider connection, and this TUI (attached with --remote-key) cannot take that over. Detach the other client first."
    case "workspace_busy":
      return "Could not take control: the workspace is busy while other viewers load it. Try again shortly."
    case "permission_denied":
      return "Could not take control: the server no longer accepts this TUI's credentials. Detach and attach again."
    default:
      return `Could not take control: ${error instanceof Error ? error.message : "the remote attachment failed"}.`
  }
}

type BindingQuestion = ProviderBindingApproval & { remoteOrigin?: string }

/**
 * Who answers a new provider binding: the terminal prompt before the UI opens, the UI's own
 * dialog while a /take binds models, and nobody otherwise (an ordinary reconnect keeps what
 * was approved before).
 */
export function bindingApprover(deps: {
  mounted(): boolean
  promoting(): boolean
  beforeMount?(binding: BindingQuestion): Promise<boolean>
  confirm(title: string, message: string): Promise<boolean>
}): (binding: BindingQuestion) => Promise<boolean> {
  return async (binding) => {
    if (!deps.mounted()) return (await deps.beforeMount?.(binding)) === true
    if (!deps.promoting()) return false
    return (
      (await deps.confirm(
        `Allow remote provider ${binding.provider} to use local provider ${binding.localProvider}?`,
        `Dialect ${binding.dialect}, expected remote endpoint ${binding.remoteOrigin ?? "unspecified"}, local endpoint ${binding.endpointOrigin}. Requests are billed to that local account.`,
      )) === true
    )
  }
}

/** The one-time transcript notice when control moves away; the banner persists after it. */
export const CONTROL_TAKEN_ISSUE: FrontendConnectionIssue = Object.freeze({
  code: "controller_taken",
  message: "Another client took control of this workspace.",
  recovery: "This TUI reconnects as a read-only viewer. Use /take to take control back.",
  retryable: true,
})

/**
 * Role changes of one remote TUI. Roles are fixed per connection, so taking control and
 * losing it are both reconnects; `reconnect` is the attach loop's own guarded retry.
 */
export function remoteRoleControl(deps: {
  port: RolePort
  presentation: {
    setAttachmentNotice(notice?: string): void
    setConnectionIssue(issue?: FrontendConnectionIssue): void
  }
  /** Reconnects with the intent, reporting nothing; resolves once attached, rejects otherwise. */
  reconnect(intent: RemoteAttachIntent): Promise<void>
  /** The attach loop's usual reconnect, with its failure reporting and retries. */
  restore(): void
  /** Runs after control was taken, e.g. model negotiation; returns lines to print. */
  promoted?(): Promise<readonly string[]>
  busy(): boolean
}) {
  let taken = false
  let named = false
  const name = () => {
    const client = deps.port.presence?.controller.client
    if (!taken || named || deps.port.presence?.controller.state !== "attached" || !client) return
    named = true
    deps.presentation.setAttachmentNotice(`Control was taken by ${clientLabel(client)}.`)
  }
  const offPresence = deps.port.subscribePresence(name)
  const command: CommandDefinition = {
    name: "take",
    description: "Take control of the remote workspace from the client that controls it",
    async run(_args, ctx) {
      if (!deps.port.readOnly) return ctx.print("This TUI already controls the workspace.")
      if (deps.busy()) return ctx.print("A reconnect is in progress. Try /take again in a moment.", "warning")
      ctx.print("Taking control…")
      try {
        await deps.reconnect("take")
      } catch (error) {
        ctx.print(takeFailureText(error), "error")
        // The viewer connection closed for the attempt; watch again from the same cursor.
        deps.restore()
        return
      }
      if (deps.port.readOnly)
        return ctx.print("Could not take control: the server attached this TUI as a viewer.", "error")
      taken = false
      named = false
      deps.presentation.setAttachmentNotice()
      ctx.print("You now control this workspace. Waiting dialogs can be answered here.")
      for (const line of (await deps.promoted?.().catch(() => [])) ?? []) ctx.print(line, "warning")
    },
  }
  return {
    command,
    /** True when the disconnect was a takeover: the caller reconnects as a viewer at once. */
    lost(reason: unknown): boolean {
      if (codeOf(reason) !== "controller_taken") return false
      taken = true
      named = false
      deps.presentation.setAttachmentNotice("Another client took control of this workspace.")
      deps.presentation.setConnectionIssue(CONTROL_TAKEN_ISSUE)
      return true
    },
    dispose: offPresence,
  }
}

import { randomUUID } from "node:crypto"
import path from "node:path"
import { createAi } from "@amira/ai"
import { type InteractiveOptions, runInteractive } from "@amira/tui"
import { remoteBuiltinPresenters } from "../frontend/builtin-presenters.ts"
import { loadProviderModelCache } from "../provider-models.ts"
import { createRemoteAgentPort } from "./agent-port.ts"
import { createRemoteOverlayBackend } from "./agent-port-requests.ts"
import { attachRetries } from "./attach-retry.ts"
import { bindingApprover, remoteRoleControl } from "./attach-roles.ts"
import { BindingApprovals } from "./binding-approvals.ts"
import type { RemoteAttachContext } from "./command.ts"
import { remoteConversationSource } from "./conversations.ts"
import { createRemoteFileSource } from "./file-source.ts"
import { localModelBindings } from "./local-models.ts"
import { loadRemoteLocalSettings } from "./local-settings.ts"
import { ModelBrokerPeer } from "./model-peer.ts"
import { remotePresentationPort } from "./presentation-port.ts"
import { CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY, REMOTE_PEER_LIMITS } from "./protocol.ts"
import { observeSshRelay } from "./relay-io.ts"
import { REMOTE_SESSIONS_VIEW } from "./session-browser.ts"
import { createRemoteViews } from "./views.ts"

/** Mount only local presentation. The remote port owns no local agent, tools or conversation store. */
export async function attachRemoteUi(
  context: RemoteAttachContext,
  options: {
    local?: ReturnType<typeof loadRemoteLocalSettings>
    approve?: Parameters<typeof localModelBindings>[1]
    interactive?: (options: InteractiveOptions) => Promise<number>
    terminal?: InteractiveOptions["terminal"]
  } = {},
): Promise<number> {
  const local = options.local ?? loadRemoteLocalSettings()
  let mounted = false
  /** A /take is binding models: the only time a new binding is asked after the UI opened. */
  let promoting = false
  let unavailable: string[] = []
  const models =
    context.modelMode === "remote-key"
      ? undefined
      : localModelBindings(
          createAi({
            ...local.credentials(),
            env: process.env,
            modelLimits: loadProviderModelCache(path.join(local.home, "cache", "provider-models.json"))
              .lookup,
          }),
          // Once the UI owns the terminal, a /take asks in its own dialog.
          bindingApprover({
            mounted: () => mounted,
            promoting: () => promoting,
            beforeMount: options.approve,
            confirm: (title, message) => presentation.confirm(title, message),
          }),
          new BindingApprovals(local.home, context.host, context.workspace),
        )
  const brokerPeer = models ? new ModelBrokerPeer(models.broker) : undefined
  const sessions = new Set<Awaited<ReturnType<RemoteAttachContext["open"]>>>()
  let replacementPending = false
  const port = await createRemoteAgentPort({
    hello: {
      v: 1,
      kind: "hello",
      clientId: randomUUID(),
      workspace: context.workspace,
      release: context.installedRelease,
      limits: REMOTE_PEER_LIMITS,
      capabilities: [
        CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY,
        "forms.live",
        "files",
        "jobs",
        context.modelMode === "remote-key" ? "model.remote-key" : "model.proxy",
      ],
      snapshot: true,
    },
    // The first TUI on a workspace controls it; any later one watches until it takes control.
    intent: "auto",
    brokerPeer,
    validateWelcome: (welcome) => {
      replacementPending = context.validateWelcome(welcome).replacementPending
    },
    async connect(signal) {
      if (signal.aborted) throw new Error("Remote attachment cancelled")
      const session = observeSshRelay(await context.open())
      if (signal.aborted) {
        session.close()
        await session.exited.catch(() => {})
        throw new Error("Remote attachment cancelled")
      }
      sessions.add(session)
      const close = () => session.close()
      signal.addEventListener("abort", close, { once: true })
      void session.exited
        .finally(() => {
          sessions.delete(session)
          signal.removeEventListener("abort", close)
        })
        .catch(() => {})
      return session
    },
  }).catch(async (error) => {
    brokerPeer?.close()
    for (const session of sessions) session.close()
    await Promise.allSettled([...sessions].map((session) => session.exited))
    throw error
  })
  const presentation = remotePresentationPort(port)
  const views = createRemoteViews(port)
  const requests = createRemoteOverlayBackend(port)
  const dialogs = presentation.requests(requests)
  const conversations = remoteConversationSource(port)
  const files = createRemoteFileSource(port)
  // Declared before use: the retry loop reports takeovers through the role control.
  let roles: ReturnType<typeof remoteRoleControl> | undefined
  const retries = attachRetries({
    port,
    negotiate: models && (() => models.negotiate(port)),
    setConnectionIssue: presentation.setConnectionIssue,
    lost: (reason) => roles?.lost(reason) === true,
  })
  roles = remoteRoleControl({
    port,
    presentation,
    busy: () => retries.busy,
    reconnect: retries.reconnect,
    restore: retries.restore,
    async promoted() {
      promoting = true
      try {
        const missing = (await models?.negotiate(port)) ?? []
        return missing.length
          ? [
              `Local provider binding unavailable for ${missing.join(", ")}. Configure and approve the provider on this computer, then reattach.`,
            ]
          : []
      } finally {
        promoting = false
      }
    },
  })
  const offTake = presentation.registerCommand(roles.command)
  const offSessions = presentation.registerCommand({
    name: "sessions",
    description: "Browse this workspace's stored sessions read-only, without switching to one",
    run(_args, ctx) {
      if (!ctx.openView?.({ kind: REMOTE_SESSIONS_VIEW, data: {} }))
        ctx.print("Stored sessions cannot be shown here.", "warning")
    },
  })
  const offReconnect = presentation.registerCommand({
    name: "reconnect",
    description: "Retry attaching after fixing a remote connection or setup issue",
    run(_args, ctx) {
      const outcome = retries.manual()
      if (outcome === "in-progress") return ctx.print("Reconnect is already in progress.")
      if (outcome === "connected") return ctx.print("The remote workspace is already connected.")
    },
  })
  try {
    unavailable = (port.readOnly ? undefined : await models?.negotiate(port)) ?? []
    await presentation.refreshCommands()
    mounted = true
    return await (options.interactive ?? runInteractive)({
      frontend: presentation.frontend,
      startupEvents: [...port.startupEvents],
      status: presentation.status,
      completions: presentation.completions,
      terminal: options.terminal,
      registerCommand: presentation.registerCommand,
      subscribeFrontendEffects: presentation.subscribeFrontendEffects,
      conversations,
      toolRenderers: remoteBuiltinPresenters,
      views,
      files,
      localCwd: process.cwd(),
      filesForCwd: (cwd) => {
        const scope = conversations.scopeForCwd(cwd)
        if (!scope) throw new Error("Remote file scope is unavailable")
        return createRemoteFileSource(port, scope)
      },
      async readWorkspaceImage(cwd, path, signal) {
        const scope = cwd === port.snapshot.state.cwd ? undefined : conversations.scopeForCwd(cwd)
        if (cwd !== port.snapshot.state.cwd && !scope) throw new Error("Remote image scope is unavailable")
        const result = await port.request(
          "images.read",
          { path, ...(scope && { scope }) },
          { signal, sessionGeneration: port.sessionGeneration },
        )
        return { data: result.data, mimeType: result.mimeType, name: result.name }
      },
      requests: dialogs,
      themes: local.themes,
      keybindings: local.keybindings,
      settings: local.settings,
      history: local.history,
      runningJobs: () =>
        port.workspaceSnapshot.jobs.filter((job) => ["starting", "running"].includes(job.status)).length,
      notice: [
        `Remote: ${context.host}:${port.authority!.workspace}. Quitting detaches; running work stays remote.`,
        ...(replacementPending
          ? [
              `Installed server ${context.installedRelease.version} (${context.installedRelease.buildId}); running daemon ${port.authority!.release.version} (${port.authority!.release.buildId}). Replacement waits for idle.`,
            ]
          : []),
        ...(unavailable.length
          ? [
              `Local provider binding unavailable for ${unavailable.join(", ")}. Configure and approve the provider on this computer, then reattach.`,
            ]
          : []),
        ...local.warnings,
      ].join("\n"),
    })
  } finally {
    retries.stop()
    offReconnect()
    offTake()
    offSessions()
    roles.dispose()
    requests.dispose()
    conversations.dispose()
    views.dispose()
    presentation.dispose()
    files.dispose?.()
    await port.detach()
    brokerPeer?.close()
    for (const session of sessions) session.close()
    await Promise.allSettled([...sessions].map((session) => session.exited))
  }
}

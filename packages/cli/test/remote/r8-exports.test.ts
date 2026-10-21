import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { RemoteAgentPort } from "../../src/remote/agent-port.ts"
import type { RemoteAttachContext } from "../../src/remote/command.ts"
import type { RemoteConnection } from "../../src/remote/connection.ts"
import type { RemoteProbe } from "../../src/remote/install.ts"
import type { SshSession } from "../../src/remote/ssh.ts"

// Host-only lifecycle contracts: no extension API additions.
test("relay preparation is asynchronous and probes expose observed executable hashes", async () => {
  const hash: Pick<RemoteProbe, "installedHash"> = { installedHash: "a".repeat(64) }
  const attach: Pick<RemoteAttachContext, "open"> = {
    open: async (): Promise<SshSession> => {
      throw new Error("fixture relay unavailable")
    },
  }
  const pending: Promise<SshSession> = attach.open()
  await expect(pending).rejects.toThrow("fixture relay unavailable")
  expect(hash.installedHash).toHaveLength(64)
  const process: Pick<SshSession, "exitStatus"> = { exitStatus: Promise.resolve(1) }
  const causes: Pick<RemoteConnection, "failureReason"> & Pick<RemoteAgentPort, "disconnectionReason"> = {
    failureReason: "protocol",
    disconnectionReason: "relay",
  }
  expect(await process.exitStatus).toBe(1)
  expect(Object.keys(causes).sort()).toEqual(["disconnectionReason", "failureReason"])
})

test("B13/B14 host-only exports remain explicit, independent of the extension API", async () => {
  const modules = {
    port: await import("../../src/remote/agent-port.ts"),
    forms: await import("../../src/remote/agent-port-forms.ts"),
    requests: await import("../../src/remote/agent-port-requests.ts"),
    operations: await import("../../src/remote/agent-port-operations.ts"),
    state: await import("../../src/remote/agent-port-state.ts"),
    artifacts: await import("../../src/remote/artifacts.ts"),
    approvals: await import("../../src/remote/binding-approvals.ts"),
    ui: await import("../../src/remote/attach-ui.ts"),
    commands: await import("../../src/remote/command.ts"),
    conversations: await import("../../src/remote/conversations.ts"),
    scripts: await import("../../src/remote/deployment-scripts.ts"),
    effects: await import("../../src/remote/effect-delivery.ts"),
    install: await import("../../src/remote/install.ts"),
    models: await import("../../src/remote/local-models.ts"),
    settings: await import("../../src/remote/local-settings.ts"),
    cli: await import("../../src/remote/main.ts"),
    presentation: await import("../../src/remote/presentation-port.ts"),
    identity: await import("../../src/remote/release-identity.ts"),
    reconnect: await import("../../src/remote/reconnect-failure.ts"),
    relay: await import("../../src/remote/relay-io.ts"),
    bindings: await import("../../src/remote/schema/bindings.ts"),
    ssh: await import("../../src/remote/ssh.ts"),
    targets: await import("../../src/remote/targets.ts"),
    views: await import("../../src/remote/views.ts"),
    presenters: await import("../../src/frontend/builtin-presenters.ts"),
  }
  expect(
    Object.fromEntries(Object.entries(modules).map(([key, value]) => [key, Object.keys(value).sort()])),
  ).toEqual({
    port: ["RemoteAgentPort", "createRemoteAgentPort"],
    forms: ["createRemoteFormBackend"],
    requests: ["createRemoteOverlayBackend"],
    operations: ["RemoteAgentOperations"],
    state: ["RemoteAgentState"],
    approvals: ["BindingApprovals"],
    artifacts: [
      "directoryServerArtifacts",
      "releaseServerArtifacts",
      "verifyServerBundle",
      "verifyServerManifest",
    ],
    ui: ["attachRemoteUi"],
    commands: ["REMOTE_USAGE", "parseRemoteCommand", "runRemoteCommand"],
    conversations: ["remoteConversationSource"],
    scripts: ["ATTACH_REMOTE_KEY_SCRIPT", "ATTACH_SCRIPT", "INSTALL_SCRIPT", "PROBE_SCRIPT"],
    effects: ["waitForRemoteEffects"],
    install: [
      "assertDaemonCompatibility",
      "compatibleRemoteDaemon",
      "installRemoteServer",
      "openRemoteRelay",
      "parseRemoteProbe",
      "parseServerIdentity",
      "probeRemote",
      "sameRelease",
      "validateRemotePath",
    ],
    models: ["localModelBindings"],
    settings: ["loadRemoteLocalSettings"],
    cli: ["runRemoteCli"],
    presentation: ["remotePresentationPort"],
    identity: ["serverVersionIdentity"],
    reconnect: ["RemoteSetupError", "classifyReconnectFailure", "setupDiagnostic", "sshExitError"],
    relay: ["observeSshRelay"],
    bindings: ["bindingMetadata", "bindingSchemas"],
    ssh: [
      "hasRemoteControlCharacters",
      "launchSsh",
      "quoteShell",
      "runSsh",
      "spawnSshProcess",
      "sshArgv",
      "validateSshHost",
    ],
    targets: ["RemoteTargetStore", "decodeRemoteTarget", "validateTargetName"],
    views: ["createRemoteViews"],
    presenters: ["remoteBuiltinPresenters"],
  })
})

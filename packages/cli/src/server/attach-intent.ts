import {
  ATTACH_INTENTS,
  ATTACH_ROLES,
  type RemoteAttachedClient,
  type RemoteRelease,
} from "../remote/protocol.ts"

/** legacy: no role string, today's controller-or-busy rule byte for byte. */
export type AttachIntent = "legacy" | "controller" | "viewer" | "auto" | "take"

/**
 * A viewer can read the whole workspace, so roles ship on a platform only once its daemon checks
 * the socket peer. Only Linux does today; elsewhere every role string is ignored, as by an old
 * daemon. The parsing below stays platform-neutral so it is tested everywhere.
 */
export function rolesEnabledOn(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux"
}

/** A client sends at most one intent; with several, take wins over viewer, and viewer over auto. */
export function attachIntent(capabilities: readonly string[], rolesEnabled: boolean): AttachIntent {
  if (!rolesEnabled) return "legacy"
  if (capabilities.includes(ATTACH_INTENTS.take)) return "take"
  if (capabilities.includes(ATTACH_INTENTS.viewer)) return "viewer"
  if (capabilities.includes(ATTACH_INTENTS.auto)) return "auto"
  return capabilities.includes(ATTACH_ROLES) ? "controller" : "legacy"
}

const printableVersion = /^[0-9A-Za-z.+-]{1,64}$/

/** Display text only: buildId and target are already id-patterned; other versions are omitted. */
export function attachedClient(release: RemoteRelease): RemoteAttachedClient {
  return {
    buildId: release.buildId,
    target: release.target,
    ...(printableVersion.test(release.version) ? { version: release.version } : {}),
  }
}

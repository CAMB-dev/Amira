import type { RemoteRelease } from "./protocol.ts"

/** Canonical, settings-free executable identity shared by the probe and atomic installer. */
export function serverVersionIdentity(release: RemoteRelease) {
  return {
    product: "amira-server" as const,
    version: release.version,
    buildId: release.buildId,
    target: release.target,
  }
}

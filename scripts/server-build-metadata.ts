import { validateBuildMetadata } from "./build-metadata.ts"

// Production servers use the conservative x64 CPU target. ARM64 is built only in CI;
// neither target is cross-compiled as part of offline Windows acceptance.
export const serverTargets = [
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
] as const satisfies readonly Bun.Build.CompileTarget[]
export type ServerTarget = (typeof serverTargets)[number]
export interface ServerBuildMetadata {
  product: "amira-server"
  version: string
  buildId: string
  channel: "stable" | "next"
  targets: ServerTarget[]
}

/** Release identities are full commit SHAs; local bundles must be visibly developmental. */
export function validateServerBuildId(value: unknown): string {
  const match =
    typeof value === "string" ? /^(?:[a-f0-9]{40}|development-[a-z0-9][a-z0-9._-]{0,95})$/.exec(value) : null
  if (!match || match[0] !== value) throw new Error("Invalid server build identity")
  return value as string
}

export function validateServerMetadata(value: unknown): ServerBuildMetadata {
  const build = validateBuildMetadata(value)
  if (
    (value as Record<string, unknown>).product !== "amira-server" ||
    !build.targets.every((target) => serverTargets.some((supported) => supported === target))
  ) {
    throw new Error("Invalid server build metadata")
  }
  return {
    product: "amira-server",
    ...build,
    buildId: validateServerBuildId((value as Record<string, unknown>).buildId),
    targets: build.targets as ServerTarget[],
  }
}

export function serverArtifact(target: ServerTarget) {
  return `amira-server-${target}`
}

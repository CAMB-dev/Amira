// Confirmed against Bun 1.4.2's CompileTarget union; do not silently accept other targets.
export const targets = [
  "bun-windows-x64",
  "bun-windows-x64-baseline",
  "bun-linux-x64",
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
] as const satisfies readonly Bun.Build.CompileTarget[]

export type Target = (typeof targets)[number]
export interface BuildMetadata {
  version: string
  channel: "stable" | "next"
  targets: Target[]
}

function isTarget(value: unknown): value is Target {
  return targets.some((target) => target === value)
}

/** One boundary for build options and on-disk metadata consumed by packaging/signing. */
export function validateBuildMetadata(value: unknown): BuildMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid build metadata")
  }
  const metadata = value as Record<string, unknown>
  const { version, channel, targets: selected } = metadata
  // SemVer permits zero-prefixed build identifiers, but not numeric prerelease identifiers.
  if (typeof version !== "string") throw new Error("Invalid build version")
  const match =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    )
  if (!match || match[0] !== version || match[1]?.split(".").some((part) => /^0\d+$/.test(part))) {
    throw new Error("Invalid build version")
  }
  if (channel !== "stable" && channel !== "next") throw new Error("Invalid build channel")
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    !selected.every(isTarget) ||
    new Set(selected).size !== selected.length
  ) {
    throw new Error("Invalid build targets")
  }
  return { version, channel, targets: [...selected] }
}

import { npmPlatforms } from "./npm-platforms.ts"

export type InstallSource = "npm" | "pnpm" | "bun" | "releases" | "dev"

/** Inspect the real executable path, not the launcher/symlink on PATH. No filesystem or home access. */
export function installSource(executable = process.execPath): InstallSource {
  const normalized = executable.replaceAll("\\", "/").toLowerCase()
  const packaged = npmPlatforms.some(({ name, os }) => {
    const binary = os === "win32" ? "amira.exe" : "amira"
    return ["", "bin/"].some((directory) =>
      normalized.endsWith(`/node_modules/${name}/${directory}${binary}`),
    )
  })
  if (packaged) {
    if (normalized.includes("/.pnpm/") || normalized.includes("/pnpm/global/")) return "pnpm"
    if (normalized.includes("/.bun/install/global/")) return "bun"
    return "npm"
  }
  return /(?:^|\/)(?:bun|node)(?:\.exe)?$/i.test(normalized) ? "dev" : "releases"
}

/** Package-manager installs must never replace their own executable. */
export function upgradeCommand(source: InstallSource): string | undefined {
  switch (source) {
    case "npm":
      return "npm i -g amira"
    case "pnpm":
      return "pnpm add -g amira"
    case "bun":
      return "bun add -g amira"
    default:
      return undefined
  }
}

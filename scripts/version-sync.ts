import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const number = "(?:0|[1-9]\\d*)"
const tagPattern = new RegExp(`^v(${number}\\.${number}\\.${number}(?:-rc\\.${number})?)$`)

export function releaseVersion(tag: string) {
  const match = tagPattern.exec(tag)
  if (!match || match[0] !== tag)
    throw new Error(`Invalid release tag: ${tag}; expected vX.Y.Z or vX.Y.Z-rc.N`)
  return match[1]!
}

export function bumpedVersion(current: string, bump: string) {
  releaseVersion(`v${current}`)
  if (bump.startsWith("v")) return releaseVersion(bump)
  const [base, prerelease] = current.split("-rc.")
  const [major, minor, patch] = base!.split(".").map(Number) as [number, number, number]
  if (bump === "major") return `${major + 1}.0.0`
  if (bump === "minor") return `${major}.${minor + 1}.0`
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`
  if (bump === "rc") return `${base}-rc.${prerelease === undefined ? 1 : Number(prerelease) + 1}`
  throw new Error(`Invalid version bump: ${bump}`)
}

// Only the CLI owns the release version; private workspaces keep independent placeholder versions.
export async function syncVersion(argv: string[], root = path.resolve(import.meta.dir, "..")) {
  const [command, value, ...extra] = argv
  if (extra.length || !["sync", "bump", "check"].includes(command ?? "")) {
    throw new Error("Usage: version-sync.ts sync vX.Y.Z | bump patch|minor|major|rc|vX.Y.Z | check vX.Y.Z")
  }
  const file = path.join(root, "packages/cli/package.json")
  const source = await readFile(file, "utf8")
  const pkg = JSON.parse(source)
  const version = command === "bump" ? bumpedVersion(pkg.version, value ?? "") : releaseVersion(value ?? "")
  const lockfile = path.join(root, "bun.lock")
  const lock = await readFile(lockfile, "utf8")
  // Bun's lockfile permits trailing commas. Replace only the CLI workspace version, not its layout.
  const lockVersion = /("packages\/cli"\s*:\s*\{[^{}]*?"version"\s*:\s*")([^"]+)(")/
  const match = lockVersion.exec(lock)
  if (!match) throw new Error("bun.lock is missing the CLI workspace version")
  if (command === "check") {
    if (pkg.version !== version)
      throw new Error(`Tag ${value} does not match CLI package version ${pkg.version}`)
    if (match[2] !== version) throw new Error(`bun.lock CLI version ${match[2]} does not match ${version}`)
  } else {
    await writeFile(
      file,
      source.replace(/("version"\s*:\s*")[^"]+(")/, (_, before, after) => `${before}${version}${after}`),
    )
    await writeFile(
      lockfile,
      lock.replace(lockVersion, (_, before, _old, after) => `${before}${version}${after}`),
    )
  }
  return version
}

if (import.meta.main) console.log(await syncVersion(process.argv.slice(2)))

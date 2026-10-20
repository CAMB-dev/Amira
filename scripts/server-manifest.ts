import { createHash } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  type ServerBuildMetadata,
  serverArtifact,
  serverTargets,
  validateServerMetadata,
} from "./server-build-metadata.ts"
import { manifestCommand } from "./sign-manifest.ts"

async function metadata(directory: string, build?: ServerBuildMetadata) {
  return validateServerMetadata(
    build ?? JSON.parse(await readFile(path.join(directory, "server-build.json"), "utf8")),
  )
}

async function artifacts(directory: string, build: ServerBuildMetadata) {
  return Promise.all(
    [...build.targets].sort().map(async (target) => {
      const file = serverArtifact(target)
      const bytes = await readFile(path.join(directory, file))
      if (!bytes.length) throw new Error(`Empty server artifact: ${file}`)
      return {
        target,
        file,
        // These are the uploaded executable bytes, not an archive's size/hash.
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }
    }),
  )
}

/** Separate product namespace; deterministic bytes permit immutable release recovery. */
export async function generateServerManifest(directory: string, build?: ServerBuildMetadata) {
  const checked = await metadata(directory, build)
  return `${JSON.stringify(
    {
      product: "amira-server",
      version: checked.version,
      buildId: checked.buildId,
      channel: checked.channel,
      artifacts: await artifacts(directory, checked),
    },
    null,
    2,
  )}\n`
}

export async function generateServerChecksums(directory: string, build: ServerBuildMetadata) {
  return (await artifacts(directory, validateServerMetadata(build)))
    .map((artifact) => `${artifact.sha256}  ${artifact.file}\n`)
    .join("")
}

/** Called only after signature verification; never rewrites published bytes or signatures. */
export async function recoverServerMetadata(directory: string, build: ServerBuildMetadata) {
  const checked = validateServerMetadata(build)
  // A failed retry cannot leave earlier provenance blessing changed or incomplete files.
  await rm(path.join(directory, "server-build.json"), { force: true })
  const published = await readFile(path.join(directory, "server-manifest.json"), "utf8")
  if (published !== (await generateServerManifest(directory, checked))) {
    throw new Error("Published server manifest does not match release metadata and raw artifacts")
  }
  if (
    (await readFile(path.join(directory, "SERVER_SHA256SUMS"), "utf8")) !==
    (await generateServerChecksums(directory, checked))
  ) {
    throw new Error("Published server checksums do not match raw artifacts")
  }
  await writeFile(path.join(directory, "server-build.json"), `${JSON.stringify(checked, null, 2)}\n`)
}

export async function serverManifestCommand(argv: string[]) {
  if (argv[0] === "sign" || argv[0] === "verify") {
    await manifestCommand(argv, "server-manifest.json")
    return
  }
  const command = argv[0]
  if (command !== "generate" && command !== "recover") {
    throw new Error("Usage: server-manifest.ts generate|sign|verify|recover [options]")
  }
  const options = new Map<string, string>()
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!
    const value = argv[i + 1]
    if (
      !["--dist", "--version", "--channel", "--target", "--build-id"].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      options.has(flag)
    ) {
      throw new Error(`Invalid server manifest option: ${flag}`)
    }
    options.set(flag, value)
  }
  const directory = options.get("--dist") ?? "dist"
  let build: ServerBuildMetadata | undefined
  if (
    command === "recover" ||
    ["--version", "--channel", "--target", "--build-id"].some((flag) => options.has(flag))
  ) {
    build = validateServerMetadata({
      product: "amira-server",
      version: options.get("--version"),
      buildId: options.get("--build-id"),
      channel: options.get("--channel"),
      targets: options.get("--target") === "all" ? [...serverTargets] : options.get("--target")?.split(","),
    })
  }
  if (command === "recover") {
    await recoverServerMetadata(directory, build!)
  } else {
    await writeFile(
      path.join(directory, "server-manifest.json"),
      await generateServerManifest(directory, build),
    )
  }
}

if (import.meta.main) await serverManifestCommand(process.argv.slice(2))

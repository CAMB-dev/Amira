import { createHash, createPublicKey, randomUUID, verify } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  type ServerBuildMetadata,
  type ServerTarget,
  serverArtifact,
  serverTargets,
  validateServerBuildId,
  validateServerMetadata,
} from "../../../../scripts/server-build-metadata.ts"
import { downloadBytes } from "../update/manifest.ts"
import type { RemoteRelease } from "./protocol.ts"

export type { ServerTarget } from "../../../../scripts/server-build-metadata.ts"
export interface ServerArtifact {
  target: ServerTarget
  file: string
  size: number
  sha256: string
}
export interface ServerManifest extends Omit<ServerBuildMetadata, "targets"> {
  artifacts: ServerArtifact[]
}
export interface ServerBundle {
  manifest: Uint8Array
  signature: string
  binary: Uint8Array
}
export interface ServerArtifactSource {
  load(target: ServerTarget): Promise<ServerBundle>
}
export interface VerifiedServerArtifact {
  manifest: ServerManifest
  artifact: ServerArtifact
  binary: Uint8Array
  release: RemoteRelease
}

/** Verify raw signed bytes before parsing. CLI update manifests cannot authorize server artifacts. */
export function verifyServerManifest(bytes: Uint8Array, signature: string, pem: string): ServerManifest {
  if (!pem) throw new Error("Configure a trusted server release public key before remote setup")
  if (bytes.length > 64 * 1024) throw new Error("Server manifest exceeds the size limit")
  const key = createPublicKey(pem)
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature.trim()) ||
    !verify(null, bytes, key, Buffer.from(signature.trim(), "base64"))
  )
    throw new Error("Server manifest signature verification failed")
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>
  if (!value || !Array.isArray(value.artifacts) || !value.artifacts.length)
    throw new Error("Invalid server manifest")
  const checked = validateServerMetadata({
    ...value,
    targets: value.artifacts.map((item) => item?.target),
  })
  const artifacts = value.artifacts.map((item): ServerArtifact => {
    if (
      !item ||
      !serverTargets.includes(item.target) ||
      item.file !== serverArtifact(item.target) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 1 ||
      item.size > 512 * 1024 * 1024 ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error("Invalid raw server artifact")
    return { target: item.target, file: item.file, size: item.size, sha256: item.sha256 }
  })
  return {
    product: checked.product,
    version: checked.version,
    channel: checked.channel,
    buildId: checked.buildId,
    artifacts,
  }
}

export function verifyServerBundle(
  bundle: ServerBundle,
  publicKey: string,
  expected: Pick<RemoteRelease, "version" | "buildId">,
  target: ServerTarget,
): VerifiedServerArtifact {
  const manifest = verifyServerManifest(bundle.manifest, bundle.signature, publicKey)
  if (manifest.version !== expected.version || manifest.buildId !== expected.buildId)
    throw new Error("Server bundle does not match this client's explicit build identity")
  const artifact = manifest.artifacts.find((item) => item.target === target)
  if (!artifact) throw new Error(`Server bundle does not contain ${target}`)
  // Own the verified bytes: a caller cannot mutate its buffer during consent/upload.
  const binary = Buffer.from(bundle.binary)
  if (
    binary.length !== artifact.size ||
    createHash("sha256").update(binary).digest("hex") !== artifact.sha256
  )
    throw new Error("Raw server artifact size or SHA-256 verification failed")
  return {
    manifest,
    artifact,
    binary,
    release: { version: manifest.version, buildId: manifest.buildId, target },
  }
}

async function boundedRead(file: string, maximum: number): Promise<Buffer> {
  if ((await stat(file)).size > maximum) throw new Error("Server bundle file exceeds the size limit")
  const bytes = await readFile(file)
  if (bytes.length > maximum) throw new Error("Server bundle file exceeds the size limit")
  return bytes
}

/** Offline-first. The trust key is supplied by the client, never read from the bundle. */
export function directoryServerArtifacts(directory: string): ServerArtifactSource {
  return {
    async load(target) {
      if (!serverTargets.includes(target)) throw new Error("Unsupported server target")
      return {
        manifest: await boundedRead(path.join(directory, "server-manifest.json"), 64 * 1024),
        signature: (await boundedRead(path.join(directory, "server-manifest.json.sig"), 1024)).toString(
          "utf8",
        ),
        binary: await boundedRead(path.join(directory, serverArtifact(target)), 512 * 1024 * 1024),
      }
    },
  }
}

export interface ServerReleaseArtifactOptions {
  /** Owned local cache directory, not a remote path and not discovered from the user's home. */
  cacheDirectory: string
  /** Trusted client-selected release asset directory, never supplied by the remote host. */
  baseUrl: string
  publicKey: string
  release: Pick<RemoteRelease, "version" | "buildId">
  download?(url: string, maximum: number): Promise<Uint8Array>
}

async function cacheFile(directory: string, name: string, bytes: Uint8Array): Promise<void> {
  const temporary = path.join(directory, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
    await rename(temporary, path.join(directory, name))
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Cache first, authenticated local download second. Offline callers inject download or use a bundle. */
export function releaseServerArtifacts(options: ServerReleaseArtifactOptions): ServerArtifactSource {
  const buildId = validateServerBuildId(options.release.buildId)
  if (!options.publicKey || createPublicKey(options.publicKey).asymmetricKeyType !== "ed25519")
    throw new Error("Configure a trusted Ed25519 server release public key")
  const base = new URL(`${options.baseUrl.replace(/\/+$/, "")}/`)
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
    throw new Error("Use an HTTPS release asset directory without credentials, query or fragment")
  const download = options.download ?? downloadBytes
  return {
    async load(target) {
      if (!serverTargets.includes(target)) throw new Error("Unsupported server target")
      // A commit can ship as both stable and nightly with different embedded versions.
      // Hash the version component so release text never becomes a filesystem path.
      const versionKey = createHash("sha256").update(options.release.version).digest("hex")
      const directory = path.join(options.cacheDirectory, buildId, versionKey, target)
      try {
        const cached = await directoryServerArtifacts(directory).load(target)
        verifyServerBundle(cached, options.publicKey, options.release, target)
        return cached
      } catch {
        // Missing, partial or corrupt cache entries are never executed. Verify fresh bytes below.
      }
      if (buildId.startsWith("development-"))
        throw new Error(
          "Development remote mode requires an explicit signed --bundle and AMIRA_SERVER_BUILD_ID",
        )
      const manifest = await download(new URL("server-manifest.json", base).href, 64 * 1024)
      const signature = Buffer.from(
        await download(new URL("server-manifest.json.sig", base).href, 1024),
      ).toString("utf8")
      const checked = verifyServerManifest(manifest, signature, options.publicKey)
      if (checked.version !== options.release.version || checked.buildId !== buildId)
        throw new Error("Server release manifest does not match this client's explicit build identity")
      const artifact = checked.artifacts.find((item) => item.target === target)
      if (!artifact) throw new Error(`Server release does not contain ${target}`)
      const binary = await download(new URL(artifact.file, base).href, artifact.size)
      const bundle = { manifest, signature, binary }
      verifyServerBundle(bundle, options.publicKey, options.release, target)
      // Each file publishes by rename only after the entire bundle is authenticated. A racing
      // reader re-verifies all three files, so a partial cache can never authorize execution.
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await cacheFile(directory, artifact.file, binary)
      await cacheFile(directory, "server-manifest.json", manifest)
      await cacheFile(directory, "server-manifest.json.sig", Buffer.from(signature))
      return bundle
    },
  }
}

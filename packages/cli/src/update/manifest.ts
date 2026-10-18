import { createPublicKey, verify } from "node:crypto"
import { parseVersion } from "./semver.ts"

export type UpdateChannel = "stable" | "next"
export interface ReleaseArtifact {
  target: string
  file: string
  size: number
  sha256: string
}
export interface ReleaseManifest {
  version: string
  channel: UpdateChannel
  artifacts: ReleaseArtifact[]
}

const supportedTargets = new Set([
  "bun-windows-x64",
  "bun-windows-x64-baseline",
  "bun-linux-x64",
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
])

export function isUpdateTarget(value: unknown): value is string {
  return typeof value === "string" && supportedTargets.has(value)
}

/** Verify the exact downloaded bytes before interpreting any release metadata. */
export function verifyReleaseManifest(bytes: Uint8Array, signature: string, pem: string): ReleaseManifest {
  if (!pem)
    throw new Error("Release updates are disabled: no release public key is configured in this build.")
  const key = createPublicKey(pem)
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature.trim()) ||
    !verify(null, bytes, key, Buffer.from(signature.trim(), "base64"))
  ) {
    throw new Error("Release manifest signature verification failed")
  }
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid release manifest")
  const m = value as Record<string, unknown>
  if (
    typeof m.version !== "string" ||
    !parseVersion(m.version) ||
    (m.channel !== "stable" && m.channel !== "next") ||
    !Array.isArray(m.artifacts) ||
    !m.artifacts.length
  )
    throw new Error("Invalid release manifest")
  if (m.channel === "stable" && parseVersion(m.version)!.prerelease.length)
    throw new Error("Stable manifest contains a prerelease version")
  const seen = new Set<string>()
  const artifacts: ReleaseArtifact[] = []
  for (const item of m.artifacts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid release artifact")
    const a = item as Record<string, unknown>
    if (
      !isUpdateTarget(a.target) ||
      seen.has(a.target) ||
      a.file !== `amira-${a.target}.${a.target.startsWith("bun-windows-") ? "zip" : "tar.gz"}` ||
      typeof a.size !== "number" ||
      !Number.isSafeInteger(a.size) ||
      a.size <= 0 ||
      a.size > 512 * 1024 * 1024 ||
      typeof a.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(a.sha256)
    )
      throw new Error("Invalid release artifact")
    seen.add(a.target)
    artifacts.push({ target: a.target, file: a.file, size: a.size, sha256: a.sha256 })
  }
  return { version: m.version, channel: m.channel, artifacts }
}

export const releaseBase = "https://github.com/CAMB-dev/Amira/releases"
export function manifestUrl(channel: UpdateChannel): string {
  return channel === "stable"
    ? `${releaseBase}/latest/download/manifest.json`
    : "https://raw.githubusercontent.com/CAMB-dev/Amira/update-channels/next/manifest.json"
}

export async function downloadBytes(
  url: string,
  maximum: number,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(120_000)
  const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) throw new Error(`Release download failed (${response.status})`)
  if (Number(response.headers.get("content-length")) > maximum)
    throw new Error("Release download exceeds expected size")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Release download has no body")
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > maximum) throw new Error("Release download exceeds expected size")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks, length)
}

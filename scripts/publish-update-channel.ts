import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { verifyReleaseManifest } from "../packages/cli/src/update/manifest.ts"
import { releasePublicKey } from "../packages/cli/src/update/public-key.ts"
import { compareVersions } from "../packages/cli/src/update/semver.ts"

export type GitApi = (endpoint: string, body?: unknown, method?: "GET" | "POST" | "PATCH") => Promise<unknown>

export class GitApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "GitApiError"
  }
}

export interface ChannelMetadata {
  manifest: Uint8Array
  signature: string
}
interface RepositoryOptions {
  repository: string
  api: GitApi
}
export interface ChannelOptions extends RepositoryOptions, ChannelMetadata {
  /** Tests inject their own trusted public key. The CLI always uses the committed key. */
  publicKey?: string
}

const branch = "update-channels"
const ref = `refs/heads/${branch}`
export const ownershipFile = ".amira-update-channel.json"
const manifestFile = "next/manifest.json"
const signatureFile = `${manifestFile}.sig`

function repositoryIdentity(repository: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Expected a GitHub owner/repository")
  const name = repository.split("/")[1]
  if (name === "." || name === "..") throw new Error("Invalid repository name")
  return repository.toLowerCase()
}

export function ownershipText(repository: string): string {
  return `${JSON.stringify({ protocol: "amira-update-channels", version: 1, repository: repositoryIdentity(repository) }, null, 2)}\n`
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error("Invalid Git object SHA")
  return value
}

async function branchHead(api: GitApi): Promise<string | undefined> {
  let result: unknown
  try {
    result = await api(`git/ref/heads/${branch}`)
  } catch (error) {
    if (error instanceof GitApiError && error.status === 404) return undefined
    throw error
  }
  const value = object(result, "channel ref")
  const target = object(value.object, "channel ref target")
  if (value.ref !== ref || target.type !== "commit") throw new Error("Invalid channel ref")
  return sha(target.sha)
}

interface TreeEntry {
  path: string
  mode: string
  type: string
  sha: string
}

async function readBlob(api: GitApi, entry: TreeEntry, maximum: number): Promise<Buffer> {
  const blob = object(await api(`git/blobs/${entry.sha}`), "channel blob")
  if (
    blob.sha !== entry.sha ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    blob.content.length > maximum * 2
  )
    throw new Error("Invalid channel blob")
  const encoded = blob.content.replace(/\r?\n/g, "")
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error("Invalid channel blob encoding")
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length > maximum || blob.size !== bytes.length) throw new Error("Invalid channel blob size")
  return bytes
}

async function ownedBranch(options: RepositoryOptions) {
  const head = await branchHead(options.api)
  if (!head)
    throw new Error("The update-channels branch is missing; a maintainer must bootstrap it explicitly")
  const commit = object(await options.api(`git/commits/${head}`), "channel commit")
  if (commit.sha !== head) throw new Error("Invalid channel commit SHA")
  const treeSha = sha(object(commit.tree, "channel commit tree").sha)
  const result = object(await options.api(`git/trees/${treeSha}?recursive=1`), "channel tree")
  if (result.sha !== treeSha || result.truncated !== false || !Array.isArray(result.tree))
    throw new Error("Invalid or truncated channel tree")
  const entries = new Map<string, TreeEntry>()
  for (const item of result.tree) {
    const entry = object(item, "channel tree entry")
    const directory = entry.path === "next"
    if (
      typeof entry.path !== "string" ||
      entries.has(entry.path) ||
      !(directory || [ownershipFile, manifestFile, signatureFile].includes(entry.path)) ||
      entry.mode !== (directory ? "040000" : "100644") ||
      entry.type !== (directory ? "tree" : "blob")
    )
      throw new Error("Unexpected channel branch layout or file mode")
    entries.set(entry.path, {
      path: entry.path,
      mode: directory ? "040000" : "100644",
      type: directory ? "tree" : "blob",
      sha: sha(entry.sha),
    })
  }
  const marker = entries.get(ownershipFile)
  if (!marker) throw new Error("The update-channels branch has no ownership marker; refusing to adopt it")
  const expectedFiles =
    entries.size === 1 ? [ownershipFile] : [ownershipFile, "next", manifestFile, signatureFile]
  if (entries.size !== expectedFiles.length || expectedFiles.some((name) => !entries.has(name)))
    throw new Error("Unexpected channel branch layout: metadata must include both manifest and signature")
  const ownership = await readBlob(options.api, marker, 2048)
  // Canonical bytes bind this reserved layout to one repository and one protocol version.
  if (ownership.toString("utf8") !== ownershipText(options.repository))
    throw new Error("Channel branch ownership does not match this repository and protocol")
  return { head, entries }
}

function authenticatedMetadata(metadata: ChannelMetadata, publicKey: string) {
  const bytes = Buffer.from(metadata.manifest)
  if (bytes.length > 1024 * 1024 || !Buffer.from(bytes.toString("utf8")).equals(bytes))
    throw new Error("Invalid channel manifest bytes")
  const manifest = verifyReleaseManifest(bytes, metadata.signature, publicKey)
  if (manifest.channel !== "next") throw new Error("Channel metadata must use the next channel")
  return manifest
}

async function createCommit(
  api: GitApi,
  files: { path: string; content: string }[],
  message: string,
  parents: string[],
) {
  const tree = object(
    await api(
      "git/trees",
      {
        tree: files.map((file) => ({ ...file, mode: "100644", type: "blob" })),
      },
      "POST",
    ),
    "new channel tree",
  )
  const commit = object(
    await api(
      "git/commits",
      {
        message,
        tree: sha(tree.sha),
        parents,
      },
      "POST",
    ),
    "new channel commit",
  )
  return sha(commit.sha)
}

/** Explicit reservation only: never adopt or overwrite an existing branch. No signing key is needed. */
export async function bootstrapUpdateChannel(options: RepositoryOptions): Promise<void> {
  repositoryIdentity(options.repository)
  if (await branchHead(options.api))
    throw new Error("The update-channels branch already exists; refusing to adopt it")
  const commit = await createCommit(
    options.api,
    [{ path: ownershipFile, content: ownershipText(options.repository) }],
    "Reserve Amira update-channel metadata",
    [],
  )
  await options.api("git/refs", { ref, sha: commit }, "POST")
}

/** Verify both candidate and existing metadata before comparing versions or writing Git objects. */
export async function publishUpdateChannel(options: ChannelOptions): Promise<"published" | "unchanged"> {
  repositoryIdentity(options.repository)
  const state = await ownedBranch(options)
  const publicKey = options.publicKey ?? releasePublicKey
  const next = authenticatedMetadata(options, publicKey)
  const previous = state.entries.get(manifestFile)
  if (previous) {
    const current = authenticatedMetadata(
      {
        manifest: await readBlob(options.api, previous, 1024 * 1024),
        signature: (await readBlob(options.api, state.entries.get(signatureFile)!, 1024)).toString("utf8"),
      },
      publicKey,
    )
    if (compareVersions(next.version, current.version) <= 0) return "unchanged"
  }
  const commit = await createCommit(
    options.api,
    [
      { path: ownershipFile, content: ownershipText(options.repository) },
      { path: manifestFile, content: Buffer.from(options.manifest).toString("utf8") },
      { path: signatureFile, content: options.signature },
    ],
    `Next channel: ${next.version}`,
    [state.head],
  )
  // A concurrent ref advance must fail, never overwrite another publisher's history.
  await options.api(`git/refs/heads/${branch}`, { sha: commit, force: false }, "PATCH")
  return "published"
}

function githubApi(repository: string): GitApi {
  const identity = repositoryIdentity(repository)
  return async (endpoint, body, method = body === undefined ? "GET" : "POST") => {
    const argv = ["api", `repos/${identity}/${endpoint}`, "--method", method]
    if (body !== undefined) argv.push("--input", "-")
    let output: string
    try {
      output = execFileSync("gh", argv, {
        encoding: "utf8",
        input: body === undefined ? undefined : JSON.stringify(body),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error)
      const status = /\bHTTP (\d{3})\b/.exec(stderr)?.[1]
      throw new GitApiError(
        status ? Number(status) : 0,
        `GitHub API request failed (${endpoint}): ${stderr.trim()}`,
      )
    }
    return JSON.parse(output)
  }
}

export async function channelCommand(argv: string[], transport?: GitApi): Promise<void> {
  const [command, ...rest] = argv
  if (command !== "bootstrap" && command !== "publish")
    throw new Error(
      "Usage: publish-update-channel.ts bootstrap|publish --repo owner/repository [--dist dist]",
    )
  const flags = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!
    const value = rest[index + 1]
    if (
      !(flag === "--repo" || (command === "publish" && flag === "--dist")) ||
      !value ||
      value.startsWith("--") ||
      flags.has(flag)
    )
      throw new Error(`Invalid channel publisher option: ${flag}`)
    flags.set(flag, value)
  }
  const repository = flags.get("--repo")
  if (!repository) throw new Error("--repo owner/repository is required")
  const api = transport ?? githubApi(repository)
  if (command === "bootstrap") {
    await bootstrapUpdateChannel({ repository, api })
    console.log("Reserved the owned update-channels branch. No release metadata has been published.")
    return
  }
  const directory = flags.get("--dist") ?? "dist"
  const outcome = await publishUpdateChannel({
    repository,
    api,
    manifest: await readFile(path.join(directory, "manifest.json")),
    signature: await readFile(path.join(directory, "manifest.json.sig"), "utf8"),
  })
  console.log(
    outcome === "published"
      ? "Next-channel metadata published."
      : "Next channel already points to this or a newer authenticated release.",
  )
}

if (import.meta.main) await channelCommand(process.argv.slice(2))

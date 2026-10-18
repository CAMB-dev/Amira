import { expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import {
  bootstrapUpdateChannel,
  type ChannelMetadata,
  channelCommand,
  type GitApi,
  GitApiError,
  ownershipFile,
  ownershipText,
  publishUpdateChannel,
} from "./publish-update-channel.ts"

const repository = "CAMB-dev/Amira"
const keys = generateKeyPairSync("ed25519")
const otherKeys = generateKeyPairSync("ed25519")
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
const manifestFile = "next/manifest.json"
const signatureFile = `${manifestFile}.sig`

function metadata(version = "1.2.3-rc.2", key = keys.privateKey, channel = "next"): ChannelMetadata {
  const manifest = Buffer.from(
    JSON.stringify({
      version,
      channel,
      artifacts: [
        { target: "bun-linux-x64", file: "amira-bun-linux-x64.tar.gz", size: 123, sha256: "a".repeat(64) },
      ],
    }),
  )
  return { manifest, signature: `${sign(null, manifest, key).toString("base64")}\n` }
}

interface Entry {
  path: string
  mode: string
  type: string
  sha: string
}
interface Commit {
  sha: string
  tree: { sha: string }
  parents: string[]
  message: string
}
interface Call {
  endpoint: string
  body?: unknown
  method: string
}

class FakeGit {
  private counter = 0
  head?: string
  readonly blobs = new Map<string, Buffer>()
  readonly trees = new Map<string, { sha: string; tree: Entry[]; truncated: boolean }>()
  readonly commits = new Map<string, Commit>()
  readonly calls: Call[] = []
  errorEndpoint?: string
  refRace = false
  readonly racedHead = "f".repeat(40)

  private sha() {
    return (++this.counter).toString(16).padStart(40, "0")
  }
  private blob(content: string | Uint8Array) {
    const sha = this.sha()
    this.blobs.set(sha, Buffer.from(content))
    return sha
  }
  private tree(files: { path: string; content: string | Uint8Array; mode?: string; type?: string }[]) {
    const entries: Entry[] = []
    if (files.some((file) => file.path.startsWith("next/"))) {
      entries.push({ path: "next", mode: "040000", type: "tree", sha: this.sha() })
    }
    for (const file of files)
      entries.push({
        path: file.path,
        mode: file.mode ?? "100644",
        type: file.type ?? "blob",
        sha: this.blob(file.content),
      })
    const sha = this.sha()
    this.trees.set(sha, { sha, tree: entries, truncated: false })
    return sha
  }
  seed(files: Record<string, string | Uint8Array>) {
    const tree = this.tree(Object.entries(files).map(([path, content]) => ({ path, content })))
    const sha = this.sha()
    this.commits.set(sha, { sha, tree: { sha: tree }, parents: [], message: "fixture" })
    this.head = sha
    return this
  }
  owned(pointer?: ChannelMetadata) {
    return this.seed({
      [ownershipFile]: ownershipText(repository),
      ...(pointer ? { [manifestFile]: pointer.manifest, [signatureFile]: pointer.signature } : {}),
    })
  }
  headTree() {
    return this.trees.get(this.commits.get(this.head!)!.tree.sha)!
  }
  setFile(name: string, content: string | Uint8Array) {
    this.headTree().tree.find((entry) => entry.path === name)!.sha = this.blob(content)
  }
  writes() {
    return this.calls.filter((call) => call.method !== "GET")
  }

  readonly api: GitApi = async (endpoint, body, method = body === undefined ? "GET" : "POST") => {
    this.calls.push({ endpoint, body, method })
    if (endpoint === this.errorEndpoint) throw new GitApiError(503, "unavailable")
    if (endpoint === "git/ref/heads/update-channels") {
      if (!this.head) throw new GitApiError(404, "not found")
      return { ref: "refs/heads/update-channels", object: { type: "commit", sha: this.head } }
    }
    if (endpoint.startsWith("git/commits/") && method === "GET")
      return this.commits.get(endpoint.slice("git/commits/".length))
    const tree = /^git\/trees\/([a-f0-9]{40})\?recursive=1$/.exec(endpoint)
    if (tree) return this.trees.get(tree[1]!)
    if (endpoint.startsWith("git/blobs/")) {
      const sha = endpoint.slice("git/blobs/".length)
      const bytes = this.blobs.get(sha)!
      return { sha, encoding: "base64", content: bytes.toString("base64"), size: bytes.length }
    }
    if (endpoint === "git/trees" && method === "POST") {
      const files = body as { tree: { path: string; content: string; mode: string; type: string }[] }
      return { sha: this.tree(files.tree) }
    }
    if (endpoint === "git/commits" && method === "POST") {
      const value = body as { tree: string; parents: string[]; message: string }
      const sha = this.sha()
      this.commits.set(sha, {
        sha,
        tree: { sha: value.tree },
        parents: value.parents,
        message: value.message,
      })
      return { sha }
    }
    if (endpoint === "git/refs" && method === "POST") {
      if (this.refRace) this.head = this.racedHead
      if (this.head) throw new GitApiError(422, "ref already exists")
      this.head = (body as { sha: string }).sha
      return { object: { sha: this.head } }
    }
    if (endpoint === "git/refs/heads/update-channels" && method === "PATCH") {
      if (this.refRace) {
        this.head = this.racedHead
        throw new GitApiError(422, "not a fast forward")
      }
      const value = body as { sha: string; force: boolean }
      if (value.force !== false) throw new Error("A publisher must never force the ref")
      if (this.commits.get(value.sha)!.parents[0] !== this.head)
        throw new GitApiError(422, "not a fast forward")
      this.head = value.sha
      return { object: { sha: this.head } }
    }
    throw new Error(`Unexpected API request: ${method} ${endpoint}`)
  }
}

function publish(git: FakeGit, candidate = metadata(), key = publicKey) {
  return publishUpdateChannel({ repository, api: git.api, ...candidate, publicKey: key })
}

test("an existing unowned branch cannot suppress publication with an unsigned huge version", async () => {
  const git = new FakeGit().seed({ [manifestFile]: '{"version":"999999.0.0"}', [signatureFile]: "" })
  await expect(publish(git)).rejects.toThrow("ownership")
  expect(git.writes()).toEqual([])
})

test("normal publication requires an explicitly reserved branch", async () => {
  const git = new FakeGit()
  await expect(publish(git)).rejects.toThrow("bootstrap")
  expect(git.writes()).toEqual([])
})

test("bootstrap reserves only the ownership marker, then publication parents its commit", async () => {
  const git = new FakeGit()
  await bootstrapUpdateChannel({ repository, api: git.api })
  const reserved = git.head!
  expect(git.headTree().tree.map((entry) => entry.path)).toEqual([ownershipFile])
  expect(git.commits.get(reserved)!.parents).toEqual([])
  expect(git.blobs.get(git.headTree().tree[0]!.sha)!.toString()).toBe(ownershipText(repository))
  expect(await publish(git)).toBe("published")
  expect(git.commits.get(git.head!)!.parents).toEqual([reserved])
  expect(
    git
      .headTree()
      .tree.map((entry) => entry.path)
      .sort(),
  ).toEqual([ownershipFile, "next", manifestFile, signatureFile].sort())
  expect(git.calls.at(-1)).toEqual({
    endpoint: "git/refs/heads/update-channels",
    body: { sha: git.head, force: false },
    method: "PATCH",
  })
})

test("bootstrap refuses both unowned and already-owned existing branches", async () => {
  for (const git of [new FakeGit().seed({ README: "not channel data" }), new FakeGit().owned()]) {
    const head = git.head
    await expect(bootstrapUpdateChannel({ repository, api: git.api })).rejects.toThrow("refusing to adopt")
    expect(git.head).toBe(head)
    expect(git.writes()).toEqual([])
  }
})

test("a concurrent bootstrap never overwrites the branch created by another actor", async () => {
  const git = new FakeGit()
  git.refRace = true
  await expect(bootstrapUpdateChannel({ repository, api: git.api })).rejects.toThrow("ref already exists")
  expect(git.head).toBe(git.racedHead)
  expect(git.calls.at(-1)!.method).toBe("POST")
  expect(JSON.stringify(git.writes())).not.toContain('"force":true')
})

const badLayouts: [string, (git: FakeGit) => void][] = [
  [
    "unexpected file",
    (git) =>
      git.headTree().tree.push({ path: "README.md", mode: "100644", type: "blob", sha: "a".repeat(40) }),
  ],
  [
    "symlink",
    (git) => {
      git.headTree().tree.find((entry) => entry.path === ownershipFile)!.mode = "120000"
    },
  ],
  [
    "submodule",
    (git) =>
      Object.assign(git.headTree().tree.find((entry) => entry.path === manifestFile)!, {
        mode: "160000",
        type: "commit",
      }),
  ],
  [
    "executable file",
    (git) => {
      git.headTree().tree.find((entry) => entry.path === manifestFile)!.mode = "100755"
    },
  ],
  ["duplicate path", (git) => git.headTree().tree.push({ ...git.headTree().tree[0]! })],
  [
    "truncated tree",
    (git) => {
      git.headTree().truncated = true
    },
  ],
  [
    "missing signature file",
    (git) => {
      git.headTree().tree = git.headTree().tree.filter((entry) => entry.path !== signatureFile)
    },
  ],
  ["wrong repository", (git) => git.setFile(ownershipFile, ownershipText("other/repository"))],
  [
    "unknown protocol",
    (git) =>
      git.setFile(
        ownershipFile,
        ownershipText(repository).replace("amira-update-channels", "other-protocol"),
      ),
  ],
  [
    "unknown marker version",
    (git) => git.setFile(ownershipFile, ownershipText(repository).replace('"version": 1', '"version": 2')),
  ],
]
for (const [name, mutate] of badLayouts) {
  test(`publication rejects ${name} without writing Git objects`, async () => {
    const git = new FakeGit().owned(metadata("999999.0.0-rc.1"))
    mutate(git)
    await expect(publish(git)).rejects.toThrow()
    expect(git.writes()).toEqual([])
  })
}

for (const failure of ["missing signature", "tampered manifest", "wrong signing key"] as const) {
  test(`a huge existing version with ${failure} cannot suppress publication`, async () => {
    const current = metadata(
      "999999.0.0-rc.1",
      failure === "wrong signing key" ? otherKeys.privateKey : keys.privateKey,
    )
    if (failure === "missing signature") current.signature = ""
    if (failure === "tampered manifest")
      current.manifest = Buffer.from(Buffer.from(current.manifest).toString().replace("999999", "888888"))
    const git = new FakeGit().owned(current)
    await expect(publish(git)).rejects.toThrow("signature verification failed")
    expect(git.writes()).toEqual([])
  })
}

for (const failure of [
  "missing signature",
  "tampered manifest",
  "wrong signing key",
  "no trusted key",
  "wrong channel",
] as const) {
  test(`a candidate with ${failure} fails even when a valid newer pointer would skip it`, async () => {
    const git = new FakeGit().owned(metadata("999999.0.0-rc.1"))
    const candidate = metadata(
      "1.2.3-rc.1",
      failure === "wrong signing key" ? otherKeys.privateKey : keys.privateKey,
      failure === "wrong channel" ? "stable" : "next",
    )
    if (failure === "missing signature") candidate.signature = ""
    if (failure === "tampered manifest")
      candidate.manifest = Buffer.from(Buffer.from(candidate.manifest).toString().replace("1.2.3", "1.2.4"))
    await expect(publish(git, candidate, failure === "no trusted key" ? "" : publicKey)).rejects.toThrow()
    expect(git.writes()).toEqual([])
  })
}

for (const [current, next, expected] of [
  ["1.2.3-rc.1", "1.2.3-rc.2", "published"],
  ["1.2.3-rc.2", "1.2.3-rc.2", "unchanged"],
  ["1.2.3-rc.10", "1.2.3-rc.2", "unchanged"],
  ["1.2.3-rc.10", "1.3.0-rc.1", "published"],
] as const) {
  test(`authenticated ${current} -> ${next} is ${expected}`, async () => {
    const git = new FakeGit().owned(metadata(current))
    const head = git.head
    expect(await publish(git, metadata(next))).toBe(expected)
    if (expected === "unchanged") {
      expect(git.head).toBe(head)
      expect(git.writes()).toEqual([])
    } else expect(git.commits.get(git.head!)!.parents).toEqual([head!])
    expect(git.calls.filter((call) => call.endpoint.startsWith("git/blobs/"))).toHaveLength(3)
  })
}

test("Git API read errors fail closed instead of bootstrapping or skipping", async () => {
  for (const endpoint of ["git/ref/heads/update-channels", "tree", "manifest"]) {
    const git = new FakeGit().owned(metadata("999999.0.0-rc.1"))
    git.errorEndpoint =
      endpoint === "tree"
        ? `git/trees/${git.headTree().sha}?recursive=1`
        : endpoint === "manifest"
          ? `git/blobs/${git.headTree().tree.find((entry) => entry.path === manifestFile)!.sha}`
          : endpoint
    await expect(publish(git)).rejects.toThrow("unavailable")
    expect(git.writes()).toEqual([])
  }
})

test("a ref race fails without force-pushing or discarding the competing head", async () => {
  const git = new FakeGit().owned(metadata("1.2.3-rc.1"))
  const head = git.head
  git.refRace = true
  await expect(publish(git)).rejects.toThrow("not a fast forward")
  expect(git.head).toBe(git.racedHead)
  const commits = git.writes().filter((call) => call.endpoint === "git/commits")
  expect(commits).toHaveLength(1)
  expect(commits[0]!.body).toMatchObject({ parents: [head] })
  expect(git.calls.at(-1)!.body).toMatchObject({ force: false })
})

test("CLI bootstrap is explicit and rejects unknown key/bootstrap-adoption flags", async () => {
  const git = new FakeGit()
  for (const argv of [
    [],
    ["publish"],
    ["bootstrap", "--repo", repository, "--adopt", "true"],
    ["publish", "--repo", repository, "--public-key", "other.pem"],
  ]) {
    await expect(channelCommand(argv, git.api)).rejects.toThrow()
  }
  expect(git.calls).toEqual([])
  await channelCommand(["bootstrap", "--repo", repository], git.api)
  expect(git.headTree().tree.map((entry) => entry.path)).toEqual([ownershipFile])
})

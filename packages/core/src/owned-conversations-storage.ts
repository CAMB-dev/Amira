import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import type { ConversationSpec, OwnedConversationRef } from "@amira/api"
import { validateStoredWriteRoots, validateWriteRoots } from "./permissions/write-roots.ts"
import { SessionInUseError, SessionStore } from "./session-store.ts"

export interface SavedConversation {
  v: 1 | 2
  owner: string
  id: string
  spec: ConversationSpec & { model: string }
  runtimeTools: string[]
}

// SessionStore deliberately allows cooperating views in one process. Owned runtimes do not:
// their model contexts are independent writers, even when two hosts share a process.
const writers = new Set<string>()

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function ownedId(owner: string, key: string): string {
  return `s_${hash(JSON.stringify([owner, key])).slice(0, 32)}`
}

export function ownedDirectory(home: string, owner: string): string {
  const base = path.join(home, "owned-conversations")
  const dir = path.join(base, hash(owner))
  for (const candidate of [base, dir]) {
    if (
      existsSync(candidate) &&
      (lstatSync(candidate).isSymbolicLink() || !lstatSync(candidate).isDirectory())
    ) {
      throw new Error("invalid owned conversation storage directory")
    }
  }
  return dir
}

export function validateSpec(value: ConversationSpec, options?: { historical?: boolean }): ConversationSpec {
  const validateRoots = options?.historical ? validateStoredWriteRoots : validateWriteRoots
  if (!value || typeof value !== "object") throw new Error("invalid conversation spec")
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "key",
          "name",
          "cwd",
          "model",
          "systemPrompt",
          "callableTools",
          "writeRoots",
          "descendants",
        ].includes(key),
    )
  )
    throw new Error("unknown conversation policy")
  for (const field of ["key", "name", "cwd", "systemPrompt"] as const) {
    if (
      typeof value[field] !== "string" ||
      (field !== "systemPrompt" && !value[field].trim()) ||
      value[field].includes("\0")
    ) {
      throw new Error(`invalid conversation spec ${field}`)
    }
  }
  if (!path.isAbsolute(value.cwd)) throw new Error("conversation spec cwd must be absolute")
  if (value.model !== undefined && (typeof value.model !== "string" || !/^[^/\s]+\/.+/.test(value.model))) {
    throw new Error("invalid conversation spec model")
  }
  if (
    !Array.isArray(value.callableTools) ||
    value.callableTools.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name))
  ) {
    throw new Error("conversation spec requires a callableTools allowlist")
  }
  if (
    value.descendants !== undefined &&
    value.descendants !== "research" &&
    value.descendants !== "inherit"
  ) {
    throw new Error("invalid conversation spec descendants")
  }
  return {
    key: value.key,
    name: value.name,
    cwd: path.resolve(value.cwd),
    ...(value.model !== undefined ? { model: value.model } : {}),
    systemPrompt: value.systemPrompt,
    callableTools: [...new Set(value.callableTools)].sort(),
    ...(value.writeRoots !== undefined ? { writeRoots: [...validateRoots(value.writeRoots)!] } : {}),
    descendants: value.descendants ?? "research",
  }
}

export function readOwned(
  home: string,
  owner: string,
  id: string,
  options?: { historical?: boolean },
): SavedConversation {
  if (!/^s_[a-f0-9]{32}$/.test(id)) throw new Error("invalid owned conversation id")
  const file = path.join(ownedDirectory(home, owner), `${id}.spec.json`)
  let saved: SavedConversation
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())
      throw new Error("invalid owned conversation metadata file")
    saved = JSON.parse(readFileSync(file, "utf8"))
  } else {
    const sessionFile = path.join(ownedDirectory(home, owner), `${id}.jsonl`)
    if (!existsSync(sessionFile)) throw new Error("owned conversation not found for this owner")
    if (lstatSync(sessionFile).isSymbolicLink() || !lstatSync(sessionFile).isFile())
      throw new Error("invalid owned conversation session file")
    const identity = SessionStore.open(sessionFile, options).header.owned
    if (!identity) throw new Error("invalid conversation ownership record")
    saved = { ...identity, id }
  }
  if (
    (saved.v !== 1 && saved.v !== 2) ||
    saved.owner !== owner ||
    saved.id !== id ||
    ownedId(owner, saved.spec?.key) !== id
  ) {
    throw new Error("invalid conversation ownership record")
  }
  if (Object.keys(saved).some((key) => !["v", "owner", "id", "spec", "runtimeTools"].includes(key)))
    throw new Error("unknown persisted conversation policy")
  const spec = validateSpec(saved.spec, options)
  if (saved.v === 1 && (spec.writeRoots !== undefined || spec.descendants === "inherit"))
    throw new Error("conversation policy requires metadata version 2")
  if (JSON.stringify(saved.spec.writeRoots) !== JSON.stringify(spec.writeRoots))
    throw new Error("persisted writeRoots changed identity")
  if (
    !spec.model ||
    !Array.isArray(saved.runtimeTools) ||
    saved.runtimeTools.some((name) => typeof name !== "string" || !spec.callableTools.includes(name))
  ) {
    throw new Error("invalid persisted conversation spec")
  }
  return { ...saved, spec: { ...spec, model: spec.model } }
}

/** Resolve only validated owner identities, without claiming, publishing or repairing files. */
export function readOwnedRef(
  home: string,
  owner: string,
  ref: OwnedConversationRef,
): SavedConversation | undefined {
  if (!ref || typeof ref !== "object" || Object.keys(ref).length !== 1)
    throw new Error("invalid owned conversation reference")
  let id: string
  if ("key" in ref) {
    if (typeof ref.key !== "string" || !ref.key.trim() || ref.key.includes("\0"))
      throw new Error("invalid owned conversation key")
    id = ownedId(owner, ref.key)
  } else if ("id" in ref && typeof ref.id === "string" && /^s_[a-f0-9]{32}$/.test(ref.id)) {
    id = ref.id
  } else {
    throw new Error("invalid owned conversation reference")
  }
  const directory = ownedDirectory(home, owner)
  if (existsSync(path.join(directory, `${id}.spec.json`)) || existsSync(path.join(directory, `${id}.jsonl`)))
    return readOwned(home, owner, id, { historical: true })
  // IDs do not encode the owner. Distinguish a foreign ID from a genuinely missing record
  // using filenames only; never read or return another owner's metadata or transcript.
  const base = path.dirname(directory)
  if ("id" in ref && existsSync(base)) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
      if (
        existsSync(path.join(base, entry.name, `${id}.spec.json`)) ||
        existsSync(path.join(base, entry.name, `${id}.jsonl`))
      )
        throw new Error("owned conversation belongs to another owner")
    }
  }
  return undefined
}

/** Open an authorized store for reading only; no runtime, lease or directory creation. */
export function readOwnedStore(home: string, saved: SavedConversation): SessionStore {
  const file = path.join(ownedDirectory(home, saved.owner), `${saved.id}.jsonl`)
  if (!existsSync(file)) throw new Error("owned conversation session is missing")
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())
    throw new Error("invalid owned conversation session file")
  const store = SessionStore.open(file, { historical: true })
  const identity = store.header.owned
  if (
    store.id !== saved.id ||
    store.header.cwd !== saved.spec.cwd ||
    !identity ||
    identity.owner !== saved.owner ||
    identity.v !== saved.v ||
    JSON.stringify(validateSpec(identity.spec, { historical: true })) !==
      JSON.stringify(validateSpec(saved.spec, { historical: true })) ||
    JSON.stringify(identity.runtimeTools) !== JSON.stringify(saved.runtimeTools)
  )
    throw new Error("conversation store identity does not match its spec")
  return store
}

export function publishOwned(home: string, saved: SavedConversation): void {
  const file = path.join(ownedDirectory(home, saved.owner), `${saved.id}.spec.json`)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temporary, "wx")
    try {
      writeFileSync(fd, JSON.stringify(saved))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** The existing session lease is the cross-process authority; no parallel registry lease. */
export async function claimOwned(
  home: string,
  saved: SavedConversation,
  create: boolean,
  options?: { signal?: AbortSignal },
): Promise<{ store: SessionStore; release: () => void }> {
  const { owner, id, spec } = saved
  const cwd = spec.cwd
  const dir = ownedDirectory(home, owner)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()))
    throw new Error("invalid owned conversation session file")
  const identity = { v: saved.v, owner, spec, runtimeTools: saved.runtimeTools }
  const store = create ? SessionStore.create({ id, cwd, dir, owned: identity }) : SessionStore.open(file)
  const key = process.platform === "win32" ? store.file.toLowerCase() : store.file
  if (writers.has(key)) throw new Error("owned conversation is in use by another host")
  // Reserve before acquisition yields: even two pending hosts must not construct writers.
  writers.add(key)
  try {
    await store.withClaim(() => {
      const stored = store.header.owned
      if (
        store.id !== id ||
        store.header.cwd !== cwd ||
        !stored ||
        stored.owner !== owner ||
        stored.v !== saved.v ||
        JSON.stringify(validateSpec(stored.spec)) !== JSON.stringify(validateSpec(spec)) ||
        JSON.stringify(stored.runtimeTools) !== JSON.stringify(saved.runtimeTools)
      )
        throw new Error("conversation store identity does not match its spec")
      // withClaim releases its temporary ref; retain one for the owned runtime's lifetime.
      store.claim()
    }, options)
  } catch (error) {
    writers.delete(key)
    if (error instanceof SessionInUseError)
      throw new Error("owned conversation is in use by another host", { cause: error })
    throw error
  }
  let released = false
  return {
    store,
    release: () => {
      if (released) return
      released = true
      try {
        store.release()
      } finally {
        writers.delete(key)
      }
    },
  }
}

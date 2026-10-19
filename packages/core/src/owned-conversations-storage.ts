import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { ConversationSpec, OwnedConversationRef } from "@amira/api"
import {
  isOwnedLifecycleState,
  type OwnedLifecycleState,
  writeOwnedFile,
} from "./owned-conversations-lifecycle.ts"
import { validateStoredWriteRoots, validateWriteRoots } from "./permissions/write-roots.ts"
import { canonicalSessionFile } from "./session-path.ts"
import { SessionInUseError, SessionStore } from "./session-store.ts"

export type { OwnedLifecycleState } from "./owned-conversations-lifecycle.ts"

export interface SavedConversation {
  v: 1 | 2 | 3
  owner: string
  id: string
  spec: ConversationSpec & { model: string }
  runtimeTools: string[]
  /** Required for v3, forbidden on legacy records; never part of immutable policy. */
  lifecycle?: OwnedLifecycleState
}

// SessionStore deliberately allows cooperating views in one process. Owned runtimes do not:
// their model contexts are independent writers, even when two hosts share a process.
const writers = new Map<string, SessionStore>()

function writerKey(file: string): string {
  const resolved = canonicalSessionFile(file)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

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
    if (identity.v === 3) throw new Error("owned conversation lifecycle metadata is missing")
    saved = { ...identity, id }
  }
  if (
    (saved.v !== 1 && saved.v !== 2 && saved.v !== 3) ||
    saved.owner !== owner ||
    saved.id !== id ||
    ownedId(owner, saved.spec?.key) !== id
  ) {
    throw new Error("invalid conversation ownership record")
  }
  const fields = ["v", "owner", "id", "spec", "runtimeTools", ...(saved.v === 3 ? ["lifecycle"] : [])]
  if (Object.keys(saved).some((key) => !fields.includes(key)))
    throw new Error("unknown persisted conversation policy")
  if (saved.v === 3 && !isOwnedLifecycleState(saved.lifecycle))
    throw new Error("invalid owned conversation lifecycle")
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
    (identity.v !== saved.v && !(saved.v === 3 && identity.v !== 3)) ||
    JSON.stringify(validateSpec(identity.spec, { historical: true })) !==
      JSON.stringify(validateSpec(saved.spec, { historical: true })) ||
    JSON.stringify(identity.runtimeTools) !== JSON.stringify(saved.runtimeTools)
  )
    throw new Error("conversation store identity does not match its spec")
  return store
}

export function publishOwned(home: string, saved: SavedConversation): void {
  const file = path.join(ownedDirectory(home, saved.owner), `${saved.id}.spec.json`)
  writeOwnedFile(file, JSON.stringify(saved))
}

function currentOwned(home: string, saved: SavedConversation): SavedConversation {
  const current = readOwned(home, saved.owner, saved.id, { historical: true })
  if (
    JSON.stringify(current.spec) !== JSON.stringify(validateSpec(saved.spec, { historical: true })) ||
    JSON.stringify(current.runtimeTools) !== JSON.stringify(saved.runtimeTools)
  )
    throw new Error("conversation lifecycle identity does not match its spec")
  return current
}

/** Read fresh lifecycle authority without claiming, repairing or validating executable roots. */
export function readOwnedLifecycle(home: string, saved: SavedConversation): OwnedLifecycleState {
  const current = currentOwned(home, saved)
  readOwnedStore(home, current)
  return current.v === 3 ? current.lifecycle! : "active"
}

/** Caller retains its owned lease across admission fencing, drain and final publication. */
export function writeOwnedLifecycle(
  home: string,
  saved: SavedConversation,
  state: OwnedLifecycleState,
): void {
  if (!isOwnedLifecycleState(state)) throw new Error("invalid owned conversation lifecycle")
  const file = path.join(ownedDirectory(home, saved.owner), `${saved.id}.jsonl`)
  const store = writers.get(writerKey(file))
  if (!store) throw new Error("owned lifecycle mutation requires its session lease")
  store.withOwnedLifecycleWrite(() => {
    const current = currentOwned(home, saved)
    readOwnedStore(home, current)
    // Publish v3 first: legacy owned readers reject even if header migration is interrupted.
    publishOwned(home, { ...current, v: 3, lifecycle: state })
  })
}

/** The existing session lease is the cross-process authority; no parallel registry lease. */
export async function claimOwned(
  home: string,
  saved: SavedConversation,
  create: boolean,
  options?: { signal?: AbortSignal; historical?: boolean },
): Promise<{ store: SessionStore; release: () => void }> {
  const { owner, id, spec } = saved
  if (create && options?.historical) throw new Error("historical claims cannot create conversations")
  const cwd = spec.cwd
  const dir = ownedDirectory(home, owner)
  if (create) mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()))
    throw new Error("invalid owned conversation session file")
  const identity = { v: saved.v, owner, spec, runtimeTools: saved.runtimeTools }
  const store = create
    ? SessionStore.create({ id, cwd, dir, owned: identity })
    : options?.historical
      ? SessionStore.openOwnedLifecycle(file)
      : SessionStore.open(file)
  const key = writerKey(store.file)
  if (writers.has(key)) throw new Error("owned conversation is in use by another host")
  // Reserve before acquisition yields: even two pending hosts must not construct writers.
  writers.set(key, store)
  try {
    await store.withClaim(() => {
      const stored = store.header.owned
      if (
        store.id !== id ||
        store.header.cwd !== cwd ||
        !stored ||
        stored.owner !== owner ||
        (stored.v !== saved.v && !(saved.v === 3 && stored.v !== 3)) ||
        JSON.stringify(validateSpec(stored.spec, options)) !== JSON.stringify(validateSpec(spec, options)) ||
        JSON.stringify(stored.runtimeTools) !== JSON.stringify(saved.runtimeTools)
      )
        throw new Error("conversation store identity does not match its spec")
      if (!options?.historical) {
        const state = create ? (saved.v === 3 ? saved.lifecycle : "active") : readOwnedLifecycle(home, saved)
        if (state !== "active") throw new Error("owned conversation is archived or archiving")
      }
      // withClaim releases its temporary ref; retain one across the runtime or lifecycle drain.
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

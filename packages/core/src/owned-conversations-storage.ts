import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import type { ConversationSpec } from "@amira/api"
import { SessionInUseError, SessionStore } from "./session-store.ts"

export interface SavedConversation {
  v: 1
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

export function validateSpec(value: ConversationSpec): ConversationSpec {
  if (!value || typeof value !== "object") throw new Error("invalid conversation spec")
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
  return {
    key: value.key,
    name: value.name,
    cwd: path.resolve(value.cwd),
    ...(value.model !== undefined ? { model: value.model } : {}),
    systemPrompt: value.systemPrompt,
    callableTools: [...new Set(value.callableTools)].sort(),
  }
}

export function readOwned(home: string, owner: string, id: string): SavedConversation {
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
    const identity = SessionStore.open(sessionFile).header.owned
    if (!identity) throw new Error("invalid conversation ownership record")
    saved = { ...identity, id }
  }
  if (saved.v !== 1 || saved.owner !== owner || saved.id !== id || ownedId(owner, saved.spec?.key) !== id) {
    throw new Error("invalid conversation ownership record")
  }
  const spec = validateSpec(saved.spec)
  if (
    !spec.model ||
    !Array.isArray(saved.runtimeTools) ||
    saved.runtimeTools.some((name) => typeof name !== "string" || !spec.callableTools.includes(name))
  ) {
    throw new Error("invalid persisted conversation spec")
  }
  return { ...saved, spec: { ...spec, model: spec.model } }
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

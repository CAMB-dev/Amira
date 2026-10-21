import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseServerIdentity, validateRemotePath } from "./install.ts"
import type { RemoteRelease } from "./protocol.ts"
import { hasRemoteControlCharacters, validateSshHost } from "./ssh.ts"

export type RemoteModelMode = "local-proxy" | "remote-key"

export interface RemoteTargetRecord {
  schema: 1
  name: string
  host: string
  workspace: string
  home: string
  user: string
  uid: number
  installRoot: string
  consent: { automaticUpdates: true; modelMode: RemoteModelMode }
  release: RemoteRelease
}

export function validateTargetName(name: string): string {
  if (hasRemoteControlCharacters(name) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))
    throw new Error("Use letters, numbers, dots, underscores or hyphens for a remote target name")
  return name
}

export function decodeRemoteTarget(value: unknown): RemoteTargetRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid remote target record")
  const record = value as RemoteTargetRecord
  if (
    record.schema !== 1 ||
    typeof record.name !== "string" ||
    typeof record.host !== "string" ||
    typeof record.workspace !== "string" ||
    typeof record.home !== "string" ||
    typeof record.user !== "string" ||
    !record.user ||
    hasRemoteControlCharacters(record.user) ||
    !Number.isSafeInteger(record.uid) ||
    record.uid < 0 ||
    record.installRoot !== `${record.home === "/" ? "" : record.home}/.amira/remote` ||
    record.consent?.automaticUpdates !== true ||
    (record.consent.modelMode !== "local-proxy" && record.consent.modelMode !== "remote-key")
  )
    throw new Error("Invalid remote target record")
  validateTargetName(record.name)
  validateSshHost(record.host)
  validateRemotePath(record.workspace)
  validateRemotePath(record.home)
  const release = parseServerIdentity({ ...record.release, product: "amira-server" })
  return {
    schema: 1,
    name: record.name,
    host: record.host,
    workspace: record.workspace,
    home: record.home,
    user: record.user,
    uid: record.uid,
    installRoot: record.installRoot,
    consent: { automaticUpdates: true, modelMode: record.consent.modelMode },
    release,
  }
}

/** The caller supplies the local Amira home. Merely importing this module never discovers a home. */
export class RemoteTargetStore {
  private directory: string
  constructor(localHome: string) {
    this.directory = path.join(localHome, "remote", "targets")
  }

  async read(name: string): Promise<RemoteTargetRecord | undefined> {
    // A prefix also keeps SSH aliases such as CON or LPT1 away from Windows device filenames.
    const file = path.join(this.directory, `target-${validateTargetName(name)}.json`)
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > 64 * 1024) throw new Error("Invalid remote target record file")
      const record = decodeRemoteTarget(JSON.parse(await readFile(file, "utf8")))
      if (record.name !== name) throw new Error("Remote target record name mismatch")
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async find(host: string): Promise<RemoteTargetRecord | undefined> {
    validateSshHost(host)
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    if (names.length > 4096) throw new Error("Remote target record limit exceeded")
    for (const name of names.sort()) {
      if (!/^target-[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.json$/.test(name)) continue
      const record = await this.read(name.slice(7, -5))
      if (record?.host === host) return record
    }
  }

  async save(record: RemoteTargetRecord): Promise<void> {
    const checked = decodeRemoteTarget(record)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const lock = path.join(this.directory, `.${checked.name}.lock`)
    try {
      await mkdir(lock, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("Remote target record is being updated; retry after it finishes")
      throw error
    }
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`)
    try {
      const current = await this.read(checked.name)
      if (current && current.host !== checked.host)
        throw new Error("That remote target name belongs to another host")
      await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      await rename(temporary, path.join(this.directory, `target-${checked.name}.json`))
    } finally {
      await rm(temporary, { force: true })
      await rm(lock, { recursive: true })
    }
  }
}

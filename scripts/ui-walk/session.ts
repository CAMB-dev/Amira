import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extensionDirectory } from "./extensions.ts"
import { launchDaemon } from "./launch.ts"
import { type CleanupRecord, readCleanupRecord, removeOwnedRoot } from "./ownership.ts"

export const checkout = path.resolve(import.meta.dir, "../..")
const identity = createHash("sha256")
  .update(`${os.userInfo().username}:${checkout}`)
  .digest("hex")
  .slice(0, 16)
export const registry = path.join(os.tmpdir(), `amira-ui-walk-${identity}`)

export interface StartOptions {
  cols: number
  rows: number
  theme?: string
  scenario?: string
  extensions?: string[]
  idleTimeout: number
  args: string[]
}
export interface SessionAddress {
  generation: string
  name: string
  pid: number
  childPid: number
  port: number
  token: string
  root: string
}
export interface SessionConfig extends StartOptions {
  generation: string
  name: string
  token: string
  root: string
}
export interface WalkRequest {
  command: string
  keys?: string[]
  cols?: number
  rows?: number
  idle?: number
  text?: string
  timeout?: number
}

export function sessionRoot(name: string, generation?: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    throw new Error("Session name must be 1–64 letters, digits, - or _")
  if (generation !== undefined && !/^[a-f0-9-]{36}$/.test(generation))
    throw new Error("Invalid session generation")
  return path.join(registry, generation ? `${name}.${generation}` : name)
}

async function generationRoots(name: string): Promise<string[]> {
  sessionRoot(name) // Validate before matching names in the registry.
  const entries = await readdir(registry).catch(() => [])
  return entries
    .filter((entry) => entry.startsWith(`${name}.`) && /^[a-f0-9-]{36}$/.test(entry.slice(name.length + 1)))
    .map((entry) => path.join(registry, entry))
}

export function positiveInteger(value: string | number, label: string, max = 3_600_000): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`)
  }
  return number
}

export async function saveJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, file)
}

async function readAddress(root: string): Promise<SessionAddress | undefined> {
  try {
    const state: SessionAddress = JSON.parse(await readFile(path.join(root, "address.json"), "utf8"))
    if (state.root === root && root === sessionRoot(state.name, state.generation)) {
      if ((await readCleanupRecord(root))?.generation !== state.generation) return state
    }
  } catch {}
  return undefined
}

export async function address(name: string): Promise<SessionAddress> {
  const states = (await Promise.all((await generationRoots(name)).map(readAddress))).filter(
    (state) => state !== undefined,
  )
  if (states.length > 1) throw new Error(`Multiple generations of ${name}; inspect ${registry}`)
  if (states[0]) return states[0]
  throw new Error(`Session ${name} is not running (use list or start)`)
}

async function pendingCleanup(name: string): Promise<CleanupRecord[]> {
  sessionRoot(name)
  const entries = await readdir(registry).catch(() => [])
  const records: CleanupRecord[] = []
  for (const entry of entries) {
    if (!entry.startsWith(`${name}.`) || !entry.endsWith(".cleanup.json")) continue
    const root = path.join(registry, entry.slice(0, -".cleanup.json".length))
    const record = await readCleanupRecord(root)
    if (record && /^[a-f0-9-]{36}$/.test(record.generation) && root === sessionRoot(name, record.generation))
      records.push(record)
  }
  return records
}

async function recoverCleanup(name: string): Promise<{ cleaned: string[]; errors: string[] }> {
  const result = { cleaned: [] as string[], errors: [] as string[] }
  for (const owner of await pendingCleanup(name)) {
    try {
      await removeOwnedRoot(owner)
      result.cleaned.push(owner.root)
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return result // No PID from a cleanup record is inspected or killed.
}

export async function request(name: string, body: WalkRequest): Promise<Response> {
  let recovery = body.command === "stop" ? await recoverCleanup(name) : undefined
  const endpoint = await address(name).catch(() => undefined)
  if (!endpoint) {
    recovery ??= await recoverCleanup(name)
    if (recovery.errors.length) throw new Error(recovery.errors.join("\n"))
    const entries = await readdir(registry).catch((): string[] => [])
    if (
      body.command === "stop" &&
      !(await generationRoots(name)).length &&
      !entries.includes(`${name}.starting`)
    ) {
      return new Response("stopped\n") // A released lock or an automatic retry may have already completed cleanup.
    }
    const detail = recovery.cleaned.length ? `; cleaned leftover ${recovery.cleaned.join(", ")}` : ""
    throw new Error(`Session ${name} is not running${detail} (use list or start)`)
  }
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((body.timeout ?? 30_000) + 5000),
  })
  if (!response.ok) throw new Error(await response.text())
  if (recovery?.errors.length) throw new Error(recovery.errors.join("\n"))
  return response
}

export async function start(name: string, options: StartOptions): Promise<SessionAddress> {
  const claim = `${sessionRoot(name)}.starting`
  const generation = randomUUID()
  const root = sessionRoot(name, generation)
  const extensions = await Promise.all((options.extensions ?? []).map(extensionDirectory))
  const config: SessionConfig = { ...options, extensions, name, generation, root, token: randomUUID() }
  await mkdir(registry, { recursive: true, mode: 0o700 })
  try {
    await mkdir(claim, { mode: 0o700 })
  } catch {
    throw new Error(`Session ${name} is already starting; inspect ${claim} if its launcher crashed`)
  }
  // Only this launcher releases the start claim. Daemons never touch shared name state.
  try {
    const existing = await Promise.all((await generationRoots(name)).map(readAddress))
    if (existing.some(Boolean)) throw new Error(`Session ${name} already exists; stop it first`)
    await mkdir(root, { mode: 0o700 })
    await saveJson(path.join(root, "config.json"), config)
    const daemon = await launchDaemon(root)
    try {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (daemon.error) throw daemon.error
        const error = await readFile(path.join(root, "error.txt"), "utf8").catch(() => undefined)
        if (error) throw new Error(error)
        const ready = await readAddress(root)
        if (ready?.generation === generation) return ready
        await Bun.sleep(50)
      }
      // Only the exact process handle we just created; never a PID read from stale state.
      daemon.kill()
      throw new Error(`Session ${name} did not start in 30 seconds`)
    } finally {
      daemon.release()
    }
  } catch (error) {
    await removeOwnedRoot(config)
    throw error
  } finally {
    await rm(claim, { recursive: true, force: true })
  }
}

export async function list(): Promise<string> {
  const entries = await readdir(registry).catch(() => [])
  const names = [
    ...new Set(
      entries.flatMap((entry) => {
        const match = /^([a-zA-Z0-9_-]{1,64})\.[a-f0-9-]{36}(?:\.cleanup\.json)?$/.exec(entry)
        return match ? [match[1]!] : []
      }),
    ),
  ].sort()
  const lines = await Promise.all(
    names.map(async (name) => {
      const recovery = await recoverCleanup(name)
      try {
        const state = await address(name)
        const response = await request(name, { command: "status", timeout: 1000 })
        const detail = [
          ...recovery.cleaned.map((root) => `cleaned leftover ${root}`),
          ...recovery.errors,
        ].join("; ")
        return `${name}\t${JSON.stringify(await response.json())}\t${state.root}${detail ? `\t${detail}` : ""}`
      } catch (error) {
        if (recovery.errors.length) return `${name}\t${recovery.errors.join("; ")}`
        if (recovery.cleaned.length) return `${name}\tcleaned leftover ${recovery.cleaned.join(", ")}`
        const diagnostic = error instanceof Error ? error.message.split("\n")[0] : "unreachable"
        const roots = (await generationRoots(name)).join(", ") || registry
        return `${name}\t${diagnostic} (inspect ${roots}; no stale PID is killed)`
      }
    }),
  )
  return lines.join("\n")
}

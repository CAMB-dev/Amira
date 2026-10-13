import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { cleanupFile, removeOwnedRoot } from "./ownership.ts"
import { list, registry, request, sessionRoot, start } from "./session.ts"

async function pendingGeneration() {
  const name = `cleanup-${randomUUID()}`
  const generation = randomUUID()
  const root = sessionRoot(name, generation)
  await mkdir(root, { recursive: true })
  // Like a partial recursive rm: config/address are already gone, only the locked file remains.
  await writeFile(path.join(root, "locked.txt"), "fixture")
  await writeFile(
    cleanupFile(root),
    JSON.stringify({ root, generation, pid: process.pid, error: "EBUSY: fixture lock" }),
  )
  return { name, root, generation }
}

async function windowsLockRegression(persistent: boolean) {
  const name = `lock-${randomUUID()}`
  const session = await start(name, { cols: 100, rows: 32, idleTimeout: 10_000, args: ["--fullscreen"] })
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const kernel = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.ptr,
    },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
  const daemon = kernel.symbols.OpenProcess(0x00100001, 0, session.pid)
  const child = kernel.symbols.OpenProcess(0x00100001, 0, session.childPid)
  let locked: ReturnType<typeof kernel.symbols.CreateFileW> = null
  const alive = (handle: typeof daemon) => !!handle && kernel.symbols.WaitForSingleObject(handle, 0) === 0x102
  try {
    expect(daemon).not.toBeNull()
    expect(child).not.toBeNull()
    await request(name, { command: "wait", text: "ui-walk/main", timeout: 10_000 })
    const file = path.join(session.root, "locked-review-file.txt")
    await writeFile(file, "held without delete sharing")
    const filename = Buffer.from(`${file}\0`, "utf16le")
    locked = kernel.symbols.CreateFileW(ptr(filename), 0x80000000, 1, null, 3, 0x80, null)
    expect(locked).not.toBeNull()
    if (!locked || Number(locked) < 0 || Number(locked) > Number.MAX_SAFE_INTEGER)
      throw new Error("CreateFileW could not hold the test lock")
    await expect(request(name, { command: "stop" })).rejects.toThrow("EBUSY")
    expect(alive(child)).toBe(false)
    await Bun.sleep(100)
    await expect(
      fetch(`http://127.0.0.1:${session.port}/`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow()
    expect(await stat(cleanupFile(session.root)).catch(() => undefined)).toBeDefined()
    if (persistent) {
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && alive(daemon)) await Bun.sleep(25)
      expect(alive(daemon)).toBe(false)
      expect(await stat(session.root).catch(() => undefined)).toBeDefined()
      const pending = await list()
      expect(pending).toContain(session.root)
      expect(pending).toContain("EBUSY")
    }
    kernel.symbols.CloseHandle(locked)
    locked = null
    if (persistent) {
      expect(await list()).toContain(`cleaned leftover ${session.root}`)
    } else {
      expect((await request(name, { command: "stop" })).status).toBe(200)
    }
    expect(await stat(session.root).catch(() => undefined)).toBeUndefined()
    expect(await stat(cleanupFile(session.root)).catch(() => undefined)).toBeUndefined()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && alive(daemon)) await Bun.sleep(25)
    expect(alive(daemon)).toBe(false)
  } finally {
    if (locked) kernel.symbols.CloseHandle(locked)
    // Handles were opened immediately for our own fresh processes: cleanup cannot kill a reused PID.
    if (alive(daemon)) kernel.symbols.TerminateProcess(daemon, 1)
    if (alive(child)) kernel.symbols.TerminateProcess(child, 1)
    if (daemon) kernel.symbols.CloseHandle(daemon)
    if (child) kernel.symbols.CloseHandle(child)
    kernel.close()
    await rm(session.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await rm(cleanupFile(session.root), { force: true })
  }
}

test("a temporary lock can be released and stop retried even after config was partially deleted", async () => {
  const owner = await pendingGeneration()
  try {
    await removeOwnedRoot(owner)
    expect(await stat(owner.root).catch(() => undefined)).toBeUndefined()
    expect(await stat(cleanupFile(owner.root)).catch(() => undefined)).toBeUndefined()
  } finally {
    await rm(owner.root, { recursive: true, force: true })
    await rm(cleanupFile(owner.root), { force: true })
  }
  // POSIX unlink permits open files; the portable ownership assertions run everywhere.
  // Windows additionally exercises the actual no-delete-sharing OS lock through the real CLI.
  if (process.platform === "win32") await windowsLockRegression(false)
}, 30_000)

test("bounded shutdown leaves recoverable ownership proof, and list cleans it without killing recorded PIDs", async () => {
  const owner = await pendingGeneration()
  try {
    const output = await list()
    expect(output).toContain(`cleaned leftover ${owner.root}`)
    expect(await stat(owner.root).catch(() => undefined)).toBeUndefined()
    expect(await stat(cleanupFile(owner.root)).catch(() => undefined)).toBeUndefined()
    expect((await request(owner.name, { command: "stop" })).status).toBe(200)
    expect(registry).not.toBe(owner.root)
  } finally {
    await rm(owner.root, { recursive: true, force: true })
    await rm(cleanupFile(owner.root), { force: true })
  }
  if (process.platform === "win32") await windowsLockRegression(true)
}, 30_000)

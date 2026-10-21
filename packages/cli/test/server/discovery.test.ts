import "./offline.ts"
import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { DaemonDiscovery, type DaemonMetadata } from "../../src/server/discovery.ts"
import { discoveryFixture, discoveryTempDir, release } from "./daemon-fixture.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})
function fixture() {
  const result = discoveryFixture()
  roots.push(result.root)
  return result
}
function metadata(discovery: DaemonDiscovery): DaemonMetadata {
  return {
    workspace: discovery.workspace,
    socket: discovery.socket,
    protocol: 1,
    release,
    daemonEpoch: "epoch",
    pid: process.pid,
    processIdentity: "boot:123",
    nonce: "nonce",
    lockIdentity: discovery.lockIdentity(),
  }
}

test("macOS discovery fixtures avoid long per-user tmpdirs within the Unix socket budget", () => {
  const longTmpDir = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/"
  const shortTmpDir = discoveryTempDir("darwin", longTmpDir)
  expect(shortTmpDir).toBe("/tmp")
  // Include macOS's canonical /private prefix, the random fixture suffix, and every socket layout.
  const root = path.posix.join("/private", shortTmpDir, "ad-123456")
  const key = "0".repeat(24)
  for (const directory of ["r/amira", "amira-1-workspaces", "selected/amira"]) {
    expect(Buffer.byteLength(path.posix.join(root, directory, key, "daemon.sock"))).toBeLessThanOrEqual(100)
  }
  expect(discoveryTempDir("linux", longTmpDir)).toBe(longTmpDir)
  expect(discoveryTempDir("win32", "C:\\Temp")).toBe("C:\\Temp")
})

test("Windows CI discovery fixtures keep runner temp paths within the fallback socket budget", () => {
  const runnerTemp = "D:\\a\\_temp"
  const key = "0".repeat(24)
  const socketPath = (tmpDir: string, directory: string) =>
    path.win32.join(tmpDir, "ad-123456", directory, key, "daemon.sock")
  for (const user of ["RUNNER~1", "runneradmin"]) {
    const longTmpDir = `C:\\Users\\${user}\\AppData\\Local\\Temp`
    // Even the runner's shortened username exceeds the stable fallback's 100-byte limit.
    expect(Buffer.byteLength(socketPath(longTmpDir, "amira-1-workspaces"))).toBeGreaterThan(100)
    const shortTmpDir = discoveryTempDir("win32", longTmpDir, runnerTemp)
    for (const directory of ["r/amira", "amira-1-workspaces", "selected/amira"]) {
      expect(Buffer.byteLength(socketPath(shortTmpDir, directory))).toBeLessThanOrEqual(100)
    }
    expect(shortTmpDir).toBe(runnerTemp)
    expect(discoveryTempDir("linux", longTmpDir, runnerTemp)).toBe(longTmpDir)
    expect(discoveryTempDir("darwin", longTmpDir, runnerTemp)).toBe("/tmp")
  }
  expect(discoveryTempDir("win32", "C:\\Temp")).toBe("C:\\Temp")
  expect(discoveryTempDir("win32", "C:\\Temp", "")).toBe("C:\\Temp")
})

test("discovery fixtures canonicalize temporary-root aliases before creating socket paths", () => {
  const f = fixture()
  const alias = path.join(f.root, "tmp-alias")
  symlinkSync(f.options.runtimeDir, alias, process.platform === "win32" ? "junction" : "dir")
  const nested = discoveryFixture(alias)
  roots.push(nested.root)
  expect(nested.root).toBe(realpathSync(nested.root))
  expect(nested.cwd).toBe(nested.discovery.workspace)
  expect(nested.discovery.directory).toBe(realpathSync(nested.discovery.directory))
  const owner = nested.discovery.claim("owner")!
  try {
    const meta = metadata(nested.discovery)
    writeFileSync(meta.socket, "fake-private-socket")
    nested.discovery.publish(meta)
    expect(() => nested.discovery.endpoint(nested.discovery.read()!).verify()).not.toThrow()
  } finally {
    nested.discovery.clearOwnedFiles()
    owner.release()
  }
})

test("canonical workspace ownership and socket paths are independent of build identity", () => {
  const { cwd, options, discovery } = fixture()
  const alias = new DaemonDiscovery(path.join(cwd, "."), options)
  expect(alias.directory).toBe(discovery.directory)
  const owner = discovery.claim("owner")!
  try {
    expect(alias.claim("owner")).toBeUndefined()
    discovery.publish(metadata(discovery))
    expect(alias.read()).toMatchObject({ release, nonce: "nonce" })
    expect(Buffer.byteLength(discovery.socket)).toBeLessThanOrEqual(100)
    expect(() => alias.clearOwnedFiles()).toThrow("ownership changed")
  } finally {
    discovery.clearOwnedFiles()
    owner.release()
  }
  const next = alias.claim("owner")!
  expect(next).toBeDefined()
  next.release()
})

test("changing XDG availability cannot create a second workspace owner", () => {
  const { cwd, options, discovery } = fixture()
  const fallback = new DaemonDiscovery(cwd, { ...options, runtimeDir: undefined })
  const owner = discovery.claim("owner")!
  try {
    discovery.publish(metadata(discovery))
    expect(fallback.claim("owner")).toBeUndefined()
    const startup = fallback.claim("startup")!
    expect(startup).toBeDefined()
    startup.release()
    expect(fallback.read()).toEqual(discovery.read())
  } finally {
    discovery.clearOwnedFiles()
    owner.release()
  }
})

test("ownership and startup fences ignore HOME and configuration roots for the same OS user/workspace", () => {
  const { root, cwd, options, discovery } = fixture()
  const otherHome = path.join(root, "other-home")
  mkdirSync(otherHome)
  const alternate = new DaemonDiscovery(cwd, { ...options, home: otherHome })
  const owner = discovery.claim("owner")!
  const startup = discovery.claim("startup")!
  let duplicateOwner: ReturnType<DaemonDiscovery["claim"]>
  let duplicateStartup: ReturnType<DaemonDiscovery["claim"]>
  try {
    duplicateOwner = alternate.claim("owner")
    duplicateStartup = alternate.claim("startup")
    expect(duplicateOwner).toBeUndefined()
    expect(duplicateStartup).toBeUndefined()
    expect(alternate.ownershipDirectory).toBe(discovery.ownershipDirectory)
  } finally {
    duplicateOwner?.release()
    duplicateStartup?.release()
    startup.release()
    owner.release()
  }
})

test("metadata nonce, PID, lock replacement and unknown records fail closed without deleting replacements", () => {
  const { discovery } = fixture()
  const owner = discovery.claim("owner")!
  discovery.publish(metadata(discovery))
  const file = path.join(discovery.ownershipDirectory, "owner.lock")
  const original = readFileSync(file, "utf8")
  // A same-PID replacement has a different nonce; neither metadata nor release can authorize it.
  rmSync(file)
  writeFileSync(file, original.replaceAll(original.split("\n")[1]!, "00000000-0000-4000-8000-000000000000"), {
    mode: 0o600,
  })
  expect(() => discovery.read()).toThrow("owner was replaced")
  expect(() => discovery.clearOwnedFiles()).toThrow("ownership changed")
  owner.release()
  expect(existsSync(file)).toBe(true)
  expect(discovery.claim("owner")).toBeUndefined()
  writeFileSync(discovery.metadataFile, JSON.stringify({ ...metadata(discovery), pid: -1 }))
  expect(() => discovery.read()).toThrow("Invalid daemon metadata")
})

test("foreign ownership and symlink runtime directories fail closed; invalid XDG uses private tmp fallback", () => {
  const { cwd, options, discovery } = fixture()
  const foreign = (file: string, directory: boolean) => {
    options.checkPrivate(file, directory)
    if (file === discovery.directory) throw new Error("Foreign ownership")
  }
  expect(() => new DaemonDiscovery(cwd, { ...options, checkPrivate: foreign })).toThrow("Foreign ownership")
  const fallback = new DaemonDiscovery(cwd, {
    ...options,
    checkPrivate(file, directory) {
      if (file === options.runtimeDir) throw new Error("Foreign XDG ownership")
      options.checkPrivate(file, directory)
    },
  })
  expect(fallback.directory).not.toBe(discovery.directory)
  expect(fallback.directory).toContain("amira-1-")
  const socket = discovery.socket
  symlinkSync(cwd, socket, process.platform === "win32" ? "junction" : "dir")
  const owner = discovery.claim("owner")!
  try {
    expect(() => discovery.clearOwnedFiles()).toThrow("symlink")
    expect(existsSync(socket)).toBe(true)
  } finally {
    owner.release()
  }
})

test("losing the XDG socket directory cannot strand stable metadata after owner shutdown", () => {
  const { discovery } = fixture()
  const owner = discovery.claim("owner")!
  discovery.publish(metadata(discovery))
  rmSync(discovery.directory, { recursive: true, force: true })
  try {
    expect(() => discovery.clearOwnedFiles()).not.toThrow()
    expect(discovery.read()).toBeUndefined()
  } finally {
    owner.release()
  }
})

test("startup and lifetime locks are separate and stale private metadata is bounded", () => {
  const { discovery } = fixture()
  const startup = discovery.claim("startup")!
  const owner = discovery.claim("owner")!
  try {
    expect(discovery.claim("startup")).toBeUndefined()
    expect(discovery.claim("owner")).toBeUndefined()
    writeFileSync(discovery.metadataFile, "x".repeat(9000), { mode: 0o600 })
    expect(() => discovery.read()).toThrow("Oversized")
    discovery.clearOwnedFiles()
  } finally {
    startup.release()
    owner.release()
  }
})

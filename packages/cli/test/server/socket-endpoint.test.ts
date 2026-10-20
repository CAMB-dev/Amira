import "./offline.ts"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DaemonDiscovery, type DaemonMetadata } from "../../src/server/discovery.ts"
import { readLinuxPeer } from "../../src/server/linux-peer.ts"
import { assertDaemonPeer } from "../../src/server/socket-endpoint.ts"
import { discoveryFixture, release } from "./daemon-fixture.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture() {
  const f = discoveryFixture()
  cleanup.push(() => rmSync(f.root, { recursive: true, force: true, maxRetries: 3 }))
  const owner = f.discovery.claim("owner")!
  cleanup.push(() => owner.release())
  const metadata: DaemonMetadata = {
    workspace: f.discovery.workspace,
    socket: f.discovery.socket,
    protocol: 1,
    release,
    daemonEpoch: "epoch",
    pid: process.pid,
    processIdentity: "boot:123",
    nonce: "nonce",
    lockIdentity: f.discovery.lockIdentity(),
  }
  writeFileSync(metadata.socket, "fake-private-socket")
  f.discovery.publish(metadata)
  return { ...f, metadata }
}

test("a regular file is not a production Unix socket even in an otherwise private directory", () => {
  const f = fixture()
  const productionSocketCheck = new DaemonDiscovery(f.cwd, { ...f.options, checkSocket: undefined })
  expect(() => productionSocketCheck.endpoint(f.metadata)).toThrow("not a private socket")
})

test.each(["foreign owner", "public permissions"])(
  "metadata-selected paths reject %s independently of the current socket root",
  (reason) => {
    const f = fixture()
    const selectedRoot = path.join(f.root, "selected")
    const selectedDirectory = path.join(selectedRoot, "amira", path.basename(f.discovery.directory))
    mkdirSync(selectedDirectory, { recursive: true })
    const meta = { ...f.metadata, socket: path.join(selectedDirectory, "daemon.sock") }
    writeFileSync(meta.socket, "fake-private-socket")
    f.discovery.publish(meta)
    for (const rejected of [selectedRoot, selectedDirectory, meta.socket]) {
      const reader = new DaemonDiscovery(f.cwd, {
        ...f.options,
        checkPrivate(file, directory) {
          f.options.checkPrivate(file, directory)
          if (file === rejected) throw new Error(reason)
        },
        checkSocket(file) {
          f.options.checkSocket(file)
          if (file === rejected) throw new Error(reason)
        },
      })
      expect(() => reader.endpoint(reader.read()!)).toThrow(reason)
    }
  },
)

test("symlink ancestors and socket replacement between validation and connect are rejected", () => {
  const f = fixture()
  const pinned = f.discovery.endpoint(f.metadata)
  const replacement = path.join(f.discovery.directory, "replacement.sock")
  writeFileSync(replacement, "fake-private-socket")
  rmSync(f.metadata.socket)
  renameSync(replacement, f.metadata.socket)
  expect(() => pinned.verify()).toThrow("identity changed")
  const moved = `${f.discovery.directory}-moved`
  renameSync(f.discovery.directory, moved)
  symlinkSync(moved, f.discovery.directory, process.platform === "win32" ? "junction" : "dir")
  expect(() => f.discovery.endpoint(f.metadata)).toThrow("ancestor")
})

test("kernel peer UID/PID/process proof rejects an ABA-restored path before any nonce is sent", () => {
  const f = fixture()
  const endpoint = f.discovery.endpoint(f.metadata)
  const aside = `${f.metadata.socket}.original`
  renameSync(f.metadata.socket, aside)
  writeFileSync(f.metadata.socket, "fake-private-socket")
  rmSync(f.metadata.socket)
  renameSync(aside, f.metadata.socket)
  // A pathname can be restored by the same UID. The connected peer must still be the daemon.
  expect(() => assertDaemonPeer(endpoint, { uid: 2, pid: process.pid }, "boot:123")).toThrow(
    "process identity",
  )
  expect(() => assertDaemonPeer(endpoint, { uid: 1, pid: process.pid + 1 }, "boot:123")).toThrow(
    "process identity",
  )
  expect(() => assertDaemonPeer(endpoint, { uid: 1, pid: process.pid }, "boot:reused")).toThrow(
    "process identity",
  )
})

test("Linux peer inspection uses the connected descriptor and fails closed when unavailable", async () => {
  let inspected = -1
  expect(
    await readLinuxPeer({ _handle: { fd: 123 } }, async (fd) => {
      inspected = fd
      return { uid: 1, pid: process.pid }
    }),
  ).toEqual({ uid: 1, pid: process.pid })
  expect(inspected).toBe(123)
  for (const socket of [{}, { _handle: null }, { _handle: { fd: -1 } }, { _handle: { fd: "123" } }])
    await expect(
      readLinuxPeer(socket, async () => {
        throw new Error("must not inspect an invalid descriptor")
      }),
    ).rejects.toThrow("descriptor is unavailable")
})

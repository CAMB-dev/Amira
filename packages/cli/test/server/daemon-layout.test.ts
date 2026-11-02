import "./offline.ts"
import { afterAll, expect, test } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DaemonDiscovery, type DaemonMetadata, listDaemonWorkspaces } from "../../src/server/discovery.ts"
import { selectDaemonHost } from "../../src/server/host.ts"
import { type DaemonLayout, posixDaemonLayout } from "../../src/server/layout.ts"
import { LinuxDaemonPlatform } from "../../src/server/platform.ts"
import { discoveryFixture, release } from "./daemon-fixture.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})
function fixture() {
  const f = discoveryFixture()
  roots.push(f.root)
  return f
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

test("metadata readers ignore unknown keys but still require every known key", () => {
  const { discovery } = fixture()
  const owner = discovery.claim("owner")!
  try {
    const meta = metadata(discovery)
    const future = { ...meta, futureKey: { nested: true }, release: { ...release, channel: "next" } }
    discovery.publish(future as DaemonMetadata)
    // Unknown keys never reach callers such as the public list output.
    expect(discovery.read()).toEqual(meta)
    for (const key of Object.keys(meta) as (keyof DaemonMetadata)[]) {
      const { [key]: _, ...partial } = meta
      writeFileSync(discovery.metadataFile, JSON.stringify(partial))
      expect(() => discovery.read()).toThrow("Invalid daemon metadata")
    }
    const { buildId: _, ...partialRelease } = release
    discovery.publish({ ...meta, release: partialRelease } as DaemonMetadata)
    expect(() => discovery.read()).toThrow("Invalid daemon metadata")
  } finally {
    discovery.clearOwnedFiles()
    owner.release()
  }
})

test("the POSIX layout accepts only a decimal uid principal", () => {
  const { options } = fixture()
  for (const principal of ["", "-1", "1.5", "01", "uid", "99999999999999999"])
    expect(() => posixDaemonLayout({ ...options, principal })).toThrow("Invalid OS user identity")
  const layout = posixDaemonLayout(options)
  expect(layout.principal.key).toBe("1")
  expect(layout.stableRoot).toBe(path.join(options.tmpDir, "amira-1-workspaces"))
  expect(layout.endpointIsFile).toBe(true)
  expect(layout.leasePolicy).toBeUndefined()
})

test("a layout whose endpoint is not a file never removes, chmods or pins it", () => {
  const { root, cwd, options } = fixture()
  const named = path.join(root, "named-endpoint")
  const layout: DaemonLayout = {
    ...posixDaemonLayout(options),
    runtimeRoot: undefined,
    endpointIsFile: false,
    endpointFor: () => named,
    validateEndpoint: (value) => value === named,
  }
  const discovery = new DaemonDiscovery(cwd, layout)
  expect(discovery.socket).toBe(named)
  expect(discovery.directory).toBe(discovery.ownershipDirectory)
  // A file at the endpoint's name proves discovery leaves it alone.
  writeFileSync(named, "not ours")
  const owner = discovery.claim("owner")!
  try {
    expect(() => discovery.clearOwnedFiles()).not.toThrow()
    expect(() => discovery.privateSocket()).not.toThrow()
    const meta = metadata(discovery)
    discovery.publish(meta)
    expect(discovery.read()).toEqual(meta)
    expect(listDaemonWorkspaces(layout)).toEqual([meta])
    const endpoint = discovery.endpoint(meta)
    expect(endpoint).toMatchObject({ socket: named, principal: "1", pid: process.pid })
    expect(() => endpoint.verify()).not.toThrow()
    expect(() => discovery.endpoint({ ...meta, socket: `${named}-other` })).toThrow("Invalid daemon endpoint")
    discovery.publish({ ...meta, socket: `${named}-other` })
    expect(() => discovery.read()).toThrow("Invalid daemon metadata")
  } finally {
    discovery.clearOwnedFiles()
    owner.release()
  }
  expect(existsSync(named)).toBe(true)
  expect(discovery.read()).toBeUndefined()
})

test("host selection names the OS once and resolves the layout only on use", () => {
  const launch = { command: ["fake-server"], modelMode: "local-proxy" as const }
  for (const os of ["darwin", "freebsd"] as const)
    expect(() => selectDaemonHost(os, launch)).toThrow("Daemons require Linux or Windows")
  const platformProperty = Object.getOwnPropertyDescriptor(process, "platform")!
  let host: ReturnType<typeof selectDaemonHost>
  try {
    Object.defineProperty(process, "platform", { value: "linux" })
    host = selectDaemonHost("linux", launch)
  } finally {
    Object.defineProperty(process, "platform", platformProperty)
  }
  expect(host.platform).toBeInstanceOf(LinuxDaemonPlatform)
  // Off Linux there is no uid; reaching this point shows the layout was not resolved eagerly.
  if (process.getuid) {
    const layout = host.layout()
    expect(layout.principal.key).toBe(String(process.getuid()))
    expect(layout.stableRoot).toBe(path.join("/tmp", `amira-${process.getuid()}-workspaces`))
    expect(layout.runtimeRoot).toBe(process.env.XDG_RUNTIME_DIR)
  }
})

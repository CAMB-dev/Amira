import "./offline.ts"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { matches } from "../../src/remote/schema/base.ts"
import { SERVER_LIST_OUTPUT_SCHEMA } from "../../src/remote-schema.ts"
import { stopWorkspace } from "../../src/server/attach.ts"
import { ensureWorkspaceDaemon } from "../../src/server/daemon.ts"
import { listDaemonWorkspaces } from "../../src/server/discovery.ts"
import { listCommandOutput } from "../../src/server/entry.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { discoveryFixture, FakeDaemonPlatform, release } from "./daemon-fixture.ts"

const f = discoveryFixture()
const platform = new FakeDaemonPlatform(f.discovery, (cwd) =>
  createWorkspaceRuntime({
    cwd,
    autoTitle: false,
    model: "mock/m",
    ai: createAi({
      dialects: [createMockDialect()],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [],
  }),
)
afterAll(async () => {
  await platform.daemon?.stop()
  rmSync(f.root, { recursive: true, force: true, maxRetries: 3 })
})

test("published daemons are listed through their own discovery checks; junk entries are skipped", async () => {
  expect(listDaemonWorkspaces(f.options)).toEqual([])
  const meta = await ensureWorkspaceDaemon({ discovery: f.discovery, platform, release })
  const stable = path.dirname(f.discovery.ownershipDirectory)
  const forged = path.join(stable, "0".repeat(24))
  mkdirSync(forged)
  // Metadata naming another workspace is not listed under a key that is not that workspace's own.
  writeFileSync(path.join(forged, "daemon.json"), JSON.stringify({ ...meta }))
  mkdirSync(path.join(stable, "not-a-key"))
  expect(listDaemonWorkspaces(f.options)).toEqual([meta])
  await stopWorkspace(f.discovery, platform)
  await platform.daemon!.closed
  expect(listDaemonWorkspaces(f.options)).toEqual([])
})

test("amira-server list prints one schema-valid line of public facts for live daemons only", async () => {
  expect(listCommandOutput(f.options, platform)).toBe('{"v":1,"workspaces":[]}\n')
  const meta = await ensureWorkspaceDaemon({ discovery: f.discovery, platform, release })
  try {
    const line = listCommandOutput(f.options, platform)
    expect(line.endsWith("\n")).toBe(true)
    expect(line.indexOf("\n")).toBe(line.length - 1)
    const output = JSON.parse(line)
    expect(matches(output, SERVER_LIST_OUTPUT_SCHEMA)).toBe(true)
    expect(output).toEqual({
      v: 1,
      workspaces: [
        { workspace: meta.workspace, protocol: 1, release: meta.release, daemonEpoch: meta.daemonEpoch },
      ],
    })
    for (const secret of [meta.nonce, meta.socket, meta.lockIdentity, meta.processIdentity])
      expect(line).not.toContain(secret)
    // A recycled PID or an unreadable process is not a live daemon.
    expect(listCommandOutput(f.options, { processIdentity: () => "another-process" })).toBe(
      '{"v":1,"workspaces":[]}\n',
    )
    const failing = {
      processIdentity: (): string => {
        throw new Error("gone")
      },
    }
    expect(listCommandOutput(f.options, failing)).toBe('{"v":1,"workspaces":[]}\n')
  } finally {
    await stopWorkspace(f.discovery, platform)
    await platform.daemon!.closed
  }
})

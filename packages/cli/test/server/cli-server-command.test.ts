import "./offline.ts"
import { expect, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import { rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  SPAWN_TEST_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../../../../scripts/spawn-test.ts"
import { matches } from "../../src/remote/schema/base.ts"
import { SERVER_LIST_OUTPUT_SCHEMA } from "../../src/remote-schema.ts"
import * as attach from "../../src/server/attach.ts"
import { runServerCommand } from "../../src/server/entry.ts"
import { DaemonUnavailableError } from "../../src/server/fallback.ts"
import * as host from "../../src/server/host.ts"
import { serverRelease } from "../../src/server/identity.ts"
import { daemonCommand } from "../../src/server/launch.ts"
import { discoveryFixture } from "./daemon-fixture.ts"

const cli = { script: "/repo/packages/cli/src/main.ts", subcommand: ["server"] }

test("a daemon relaunches the executable it was started from", () => {
  // Compiled CLI: the same executable with the hidden subcommand; never a script path.
  expect(daemonCommand("C:\\Program Files\\Amira\\amira.exe", cli)).toEqual([
    "C:\\Program Files\\Amira\\amira.exe",
    "server",
  ])
  expect(daemonCommand("/usr/local/bin/amira", cli)).toEqual(["/usr/local/bin/amira", "server"])
  // Source CLI under Bun.
  expect(daemonCommand("C:\\bun\\bun.exe", cli)).toEqual(["C:\\bun\\bun.exe", cli.script, "server"])
  expect(daemonCommand("/home/u/.bun/bin/bun", cli)).toEqual(["/home/u/.bun/bin/bun", cli.script, "server"])
  // The standalone server, compiled or from source, takes no subcommand.
  const standalone = { script: "/repo/build/entries/amira-server.ts", subcommand: [] }
  expect(daemonCommand("/home/u/.amira/remote/bin/amira-server", standalone)).toEqual([
    "/home/u/.amira/remote/bin/amira-server",
  ])
  expect(daemonCommand("/usr/bin/bun", standalone)).toEqual(["/usr/bin/bun", standalone.script])
})

test("the CLI launch reaches the daemon spawn command", async () => {
  const fixture = discoveryFixture()
  const platformProperty = Object.getOwnPropertyDescriptor(process, "platform")!
  const listeners = process.stdout.listeners("error")
  const attached = spyOn(attach, "attachWorkspace").mockResolvedValue(undefined)
  const launcher = spyOn(childProcess, "spawn").mockImplementation((() => {
    const child = new childProcess.ChildProcess()
    child.unref = () => {}
    queueMicrotask(() => child.emit("spawn"))
    return child
  }) as typeof childProcess.spawn)
  try {
    Object.defineProperty(process, "platform", { value: "linux" })
    expect(await runServerCommand(["attach", "--remote-key"], cli)).toBe(0)
    await attached.mock.calls[0]![0].platform.spawn(fixture.discovery)
    const [command, args] = launcher.mock.calls[0]!
    expect([command, ...(args as string[])]).toEqual([
      ...daemonCommand(process.execPath, cli),
      "daemon",
      "--cwd",
      fixture.discovery.workspace,
      "--remote-key",
    ])
  } finally {
    Object.defineProperty(process, "platform", platformProperty)
    attached.mockRestore()
    launcher.mockRestore()
    for (const listener of process.stdout.listeners("error"))
      if (!listeners.includes(listener)) process.stdout.removeListener("error", listener)
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 })
  }
})

test("server list on an OS without a daemon host is an empty list", async () => {
  const platformProperty = Object.getOwnPropertyDescriptor(process, "platform")!
  const written: string[] = []
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    written.push(chunk)
    return true
  }) as typeof process.stdout.write)
  try {
    Object.defineProperty(process, "platform", { value: "darwin" })
    expect(await runServerCommand(["list"], cli)).toBe(0)
  } finally {
    Object.defineProperty(process, "platform", platformProperty)
    write.mockRestore()
  }
  expect(written).toEqual([`${JSON.stringify({ v: 1, workspaces: [] })}\n`])
})

test(
  "amira server answers version and list probes from source without loading settings",
  async () => {
    const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url))
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, entry, "server", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        return await waitForSpawnWork(
          "amira server output",
          Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            waitForSpawnExit(child, "amira server"),
          ]),
        )
      } finally {
        await stopSpawn(child, "amira server cleanup")
      }
    }
    const [version, versionErr, versionCode] = await run("--version-json")
    expect([versionErr, versionCode]).toEqual(["", 0])
    expect(JSON.parse(version)).toEqual({
      product: "amira-server",
      version: serverRelease.version,
      buildId: serverRelease.buildId,
      target: serverRelease.target,
    })
    const [list, listErr, listCode] = await run("list")
    expect([listErr, listCode]).toEqual(["", 0])
    expect(matches(JSON.parse(list), SERVER_LIST_OUTPUT_SCHEMA)).toBe(true)
    // An unknown server command fails without falling through to the TUI's usage text.
    const [, usageErr, usageCode] = await run("bogus")
    expect([usageErr, usageCode]).toEqual([
      "amira-server: unable to start or attach the remote workspace\n",
      1,
    ])
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("server list in a session that may not run daemons is an empty list", async () => {
  // Only the layout is reached before the refusal, so no real platform is built on any runner.
  const selected = spyOn(host, "selectDaemonHost").mockReturnValue({
    platform: {},
    layout: () => {
      throw new DaemonUnavailableError("integrity")
    },
  } as unknown as ReturnType<typeof host.selectDaemonHost>)
  const platformProperty = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "win32" })
  const written: string[] = []
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    written.push(chunk)
    return true
  }) as typeof process.stdout.write)
  try {
    expect(await runServerCommand(["list"], cli)).toBe(0)
  } finally {
    Object.defineProperty(process, "platform", platformProperty)
    write.mockRestore()
    selected.mockRestore()
  }
  expect(written).toEqual([`${JSON.stringify({ v: 1, workspaces: [] })}\n`])
})

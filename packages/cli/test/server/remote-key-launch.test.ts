import "./offline.ts"
import { expect, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import { rmSync } from "node:fs"
import * as attach from "../../src/server/attach.ts"
import { runServerCommand } from "../../src/server/entry.ts"
import { LinuxDaemonPlatform } from "../../src/server/platform.ts"
import { discoveryFixture } from "./daemon-fixture.ts"

for (const mode of ["local-proxy", "remote-key"] as const) {
  test(`${mode} platform launch forwards only the selected daemon mode`, async () => {
    const fixture = discoveryFixture()
    const platformProperty = Object.getOwnPropertyDescriptor(process, "platform")!
    let detached = false
    // Only the lifecycle methods are consumed by the daemon launcher, never child streams.
    const fakeSpawn = () => {
      const child = new childProcess.ChildProcess()
      child.unref = () => {
        detached = true
      }
      queueMicrotask(() => child.emit("spawn"))
      return child
    }
    const launcher = spyOn(childProcess, "spawn").mockImplementation(fakeSpawn as typeof childProcess.spawn)
    try {
      Object.defineProperty(process, "platform", { value: "linux" })
      const platform =
        mode === "local-proxy"
          ? new LinuxDaemonPlatform(["fake-bun", "fake-server.ts"])
          : new LinuxDaemonPlatform(["fake-bun", "fake-server.ts"], mode)
      Object.defineProperty(process, "platform", platformProperty)
      await platform.spawn(fixture.discovery)
      expect(launcher).toHaveBeenCalledTimes(1)
      expect(launcher.mock.calls[0]!.slice(0, 2)).toEqual([
        "fake-bun",
        [
          "fake-server.ts",
          "daemon",
          "--cwd",
          fixture.discovery.workspace,
          ...(mode === "remote-key" ? ["--remote-key"] : []),
        ],
      ])
      expect(detached).toBe(true)
    } finally {
      Object.defineProperty(process, "platform", platformProperty)
      launcher.mockRestore()
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 })
    }
  })
}

test("server attach accepts remote-key and configures its platform without launching or restarting work", async () => {
  const fixture = discoveryFixture()
  const platformProperty = Object.getOwnPropertyDescriptor(process, "platform")!
  const listenerCount = process.stdout.listenerCount("error")
  const listeners = process.stdout.listeners("error")
  const attached = spyOn(attach, "attachWorkspace").mockResolvedValue(undefined)
  const launcher = spyOn(childProcess, "spawn").mockImplementation(() => {
    throw new Error("Attach must not unconditionally launch a daemon")
  })
  try {
    Object.defineProperty(process, "platform", { value: "linux" })
    expect(await runServerCommand(["attach", "--remote-key"])).toBe(0)
    expect(attached).toHaveBeenCalledTimes(1)
    expect(attached.mock.calls[0]![0].platform).toBeInstanceOf(LinuxDaemonPlatform)
    expect(launcher).not.toHaveBeenCalled()
    launcher.mockImplementation((() => {
      const child = new childProcess.ChildProcess()
      child.unref = () => {}
      queueMicrotask(() => child.emit("spawn"))
      return child
    }) as typeof childProcess.spawn)
    await attached.mock.calls[0]![0].platform.spawn(fixture.discovery)
    expect(launcher.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(["daemon", "--cwd", fixture.discovery.workspace, "--remote-key"]),
    )
    await expect(runServerCommand(["attach", "--remote-key", "--remote-key"])).rejects.toThrow("Usage")
  } finally {
    Object.defineProperty(process, "platform", platformProperty)
    attached.mockRestore()
    launcher.mockRestore()
    for (const listener of process.stdout.listeners("error"))
      if (!listeners.includes(listener)) process.stdout.removeListener("error", listener)
    expect(process.stdout.listenerCount("error")).toBe(listenerCount)
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 })
  }
})

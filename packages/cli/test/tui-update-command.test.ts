import { expect, test } from "bun:test"
import type { CommandContext } from "@amira/api"
import { createTuiUpdateCommand } from "../src/tui-update-command.ts"
import type { UpdateEngine } from "../src/update-command.ts"

function makeCtx(confirmResult = true) {
  const printed: Array<{ text: string; level?: string }> = []
  const confirms: string[] = []
  const controller = new AbortController()
  const ctx = {
    cwd: "/work",
    frontend: "tui",
    signal: controller.signal,
    print(text: string, level?: string) {
      printed.push({ text, level })
    },
    ui: {
      confirm: async (title: string) => {
        confirms.push(title)
        return confirmResult
      },
    },
  } as unknown as CommandContext
  return { ctx, printed, confirms, controller }
}

function makeUpdater(overrides: Partial<UpdateEngine> = {}): { updater: UpdateEngine; calls: string[] } {
  const calls: string[] = []
  const updater: UpdateEngine = {
    disabledReason: async () => undefined,
    check: async (channel = "stable") => {
      calls.push(`check:${channel}`)
      return { version: "0.0.2", channel }
    },
    checkVersion: async (version) => {
      calls.push(`checkVersion:${version}`)
      return { version, channel: "stable" }
    },
    update: async (channel = "stable") => {
      calls.push(`update:${channel}`)
      return "0.0.2"
    },
    updateVersion: async (version) => {
      calls.push(`updateVersion:${version}`)
      return version
    },
    rollback: async () => {
      calls.push("rollback")
      return "0.0.1"
    },
    cleanup: async () => {},
    ...overrides,
  }
  return { updater, calls }
}

test("/update checks, prompts to confirm on bare /update, and installs on self-managed releases", async () => {
  const { updater, calls } = makeUpdater()
  const cmd = createTuiUpdateCommand({
    settings: () => ({}),
    updater: () => updater,
    source: () => "releases",
    env: {},
    version: "0.0.1",
    target: "bun-windows-x64-baseline",
  })

  const checkCtx = makeCtx()
  await cmd.run("check", checkCtx.ctx)
  expect(calls).toEqual(["check:stable"])
  expect(checkCtx.printed[0]?.text).toContain("0.0.2 is available on stable")

  const confirmCtx = makeCtx(true)
  await cmd.run("", confirmCtx.ctx)
  expect(confirmCtx.confirms[0]).toContain("0.0.1 → 0.0.2")
  expect(calls).toEqual(["check:stable", "check:stable", "update:stable"])
  expect(confirmCtx.printed.at(-1)?.text).toContain("Updated to Amira 0.0.2")

  const versionCtx = makeCtx()
  await cmd.run("version v0.0.3", versionCtx.ctx)
  expect(calls.slice(-2)).toEqual(["checkVersion:0.0.3", "updateVersion:0.0.3"])
  expect(versionCtx.printed.at(-1)?.text).toContain("Updated to Amira 0.0.3")

  const rollbackCtx = makeCtx()
  await cmd.run("rollback", rollbackCtx.ctx)
  expect(calls.at(-1)).toBe("rollback")
  expect(rollbackCtx.printed[0]?.text).toContain("Rolled back to Amira 0.0.1")
})

test("/update checks GitHub Releases on npm/bun/dev installs and prints the right upgrade hint", async () => {
  const cmd = createTuiUpdateCommand({
    settings: () => ({}),
    source: () => "bun",
    env: {},
    version: "0.0.1",
    target: "bun-windows-x64-baseline",
    publicKey: "fake-key",
    fetchManifest: async () => ({
      version: "0.0.2",
      channel: "stable",
      artifacts: [],
    }),
  })
  const c = makeCtx()
  await cmd.run("", c.ctx)
  expect(c.printed[0]?.text).toContain("0.0.2")
  expect(c.printed[0]?.text).toContain("bun add -g amira")

  const rb = makeCtx()
  await cmd.run("rollback", rb.ctx)
  expect(rb.printed[0]?.text).toContain("rollback is unavailable")
})

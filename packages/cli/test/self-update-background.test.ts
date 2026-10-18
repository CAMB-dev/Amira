import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  printUpdateNotice,
  startBackgroundUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  updatePolicy,
} from "../src/update-background.ts"
import type { UpdateEngine } from "../src/update-command.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(target = "1.2.4", reason?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amira-update-background-"))
  directories.push(directory)
  const calls: string[] = []
  const updater: UpdateEngine = {
    disabledReason: async () => reason,
    check: async (channel = "stable") => {
      calls.push(`check:${channel}`)
      return { version: target, channel }
    },
    update: async (channel = "stable") => {
      calls.push(`update:${channel}`)
      return target
    },
    rollback: async () => "1.2.2",
    cleanup: async () => {
      calls.push("cleanup")
    },
  }
  const stateFile = path.join(directory, "update.json")
  const options = { updater, env: {}, version: "1.2.3", stateFile, now: () => 100_000_000 }
  return { calls, updater, stateFile, options }
}

test("patch policy preserves semver prerelease ordering and never crosses minor or major", () => {
  expect(updatePolicy("1.2.3", "1.2.4")).toBe("patch")
  expect(updatePolicy("1.2.3", "1.3.0")).toBe("notice")
  expect(updatePolicy("1.2.3", "2.0.0")).toBe("notice")
  expect(updatePolicy("1.2.3", "1.2.2")).toBe("none")
  expect(updatePolicy("1.2.3", "1.2.3")).toBe("none")
  expect(updatePolicy("1.2.3-rc.2", "1.2.3-rc.10")).toBe("patch")
  expect(updatePolicy("1.2.3-rc.10", "1.2.3-rc.2")).toBe("none")
  expect(updatePolicy("1.2.3", "1.2.4", "1.3.0")).toBe("none")
})

test("patches download silently and subsequent starts are throttled for 22 hours", async () => {
  const f = await fixture()
  const first = await startBackgroundUpdate({}, f.options)
  expect(first.notice).toBeUndefined()
  await first.finished
  expect(f.calls).toEqual(["cleanup", "check:stable", "update:stable"])
  const second = await startBackgroundUpdate({}, f.options)
  await second.finished
  expect(f.calls).toEqual(["cleanup", "check:stable", "update:stable", "cleanup"])
  await (await startBackgroundUpdate({}, { ...f.options, now: () => 100_000_000 + UPDATE_CHECK_INTERVAL_MS }))
    .finished
  expect(f.calls.filter((call) => call.startsWith("check:"))).toHaveLength(2)
})

test("minor and major releases only cache notices, shown on the next start", async () => {
  for (const target of ["1.3.0", "2.0.0"]) {
    const f = await fixture(target)
    await (await startBackgroundUpdate({}, f.options)).finished
    expect(f.calls).toEqual(["cleanup", "check:stable"])
    const second = await startBackgroundUpdate({}, f.options)
    expect(second.notice).toBe(`Amira ${target} is available. Run amira update --channel stable.`)
    await second.finished
  }
})

test("failed checks are silent and throttled too", async () => {
  const f = await fixture()
  f.updater.check = async () => {
    f.calls.push("failed")
    throw new Error("offline")
  }
  const first = await startBackgroundUpdate({}, f.options)
  await expect(first.finished).resolves.toBeUndefined()
  expect(first.notice).toBeUndefined()
  await (await startBackgroundUpdate({}, f.options)).finished
  expect(f.calls).toEqual(["cleanup", "failed", "cleanup"])
  expect(JSON.parse(await readFile(f.stateFile, "utf8")).checkedAt).toBe(100_000_000)
})

test("all startup switches and updates.auto=false skip checks and cache access, not local cleanup", async () => {
  for (const variable of ["AMIRA_DISABLE_AUTOUPDATE", "AMIRA_DISABLE_UPDATES", "AMIRA_OFFLINE"]) {
    const f = await fixture()
    const result = await startBackgroundUpdate({}, { ...f.options, env: { [variable]: "1" } })
    expect(result.notice).toBeUndefined()
    await result.finished
    expect(f.calls).toEqual(["cleanup"])
    await expect(readFile(f.stateFile)).rejects.toThrow()
  }
  const f = await fixture()
  await (await startBackgroundUpdate({ updates: { auto: false } }, f.options)).finished
  expect(f.calls).toEqual(["cleanup"])
})

test("session versions are pinned before cleanup even when all update checks are disabled", async () => {
  for (const env of [
    {},
    { AMIRA_DISABLE_UPDATES: "1" },
    { AMIRA_DISABLE_AUTOUPDATE: "1" },
    { AMIRA_OFFLINE: "1" },
  ]) {
    const f = await fixture("1.2.4", "no release public key")
    f.updater.pinVersion = async () => {
      f.calls.push("pin")
    }
    const result = await startBackgroundUpdate({ updates: { auto: false } }, { ...f.options, env })
    await result.finished
    expect(f.calls).toEqual(["pin", "cleanup"])
    await expect(readFile(f.stateFile)).rejects.toThrow()
  }
})

test("RPC startup holds a version lease without checks, cleanup, cached notices or network", async () => {
  const f = await fixture()
  f.updater.pinVersion = async () => {
    f.calls.push("pin")
  }
  f.updater.stop = async () => {
    f.calls.push("release")
  }
  const result = await startBackgroundUpdate({}, { ...f.options, checks: false })
  await result.finished
  expect(result.notice).toBeUndefined()
  expect(f.calls).toEqual(["pin"])
  await expect(readFile(f.stateFile)).rejects.toThrow()
  await result.stop()
  expect(f.calls).toEqual(["pin", "release"])
})

test("lease failures never block startup and skip unsafe cleanup and auto-updates", async () => {
  for (const options of [
    {},
    { checks: false },
    { env: { AMIRA_DISABLE_UPDATES: "1" } },
    { env: { AMIRA_OFFLINE: "1" } },
  ]) {
    const f = await fixture("1.2.4", "no release public key")
    f.updater.pinVersion = async () => {
      throw new Error("lease unavailable")
    }
    f.updater.stop = async () => {
      f.calls.push("stop")
    }
    let stop: (() => Promise<void>) | undefined
    const result = await startBackgroundUpdate(
      {},
      {
        ...f.options,
        ...options,
        onStop: (value) => {
          stop = value
        },
      },
    )
    await result.finished
    expect(stop).toBeFunction()
    expect(result.notice).toBeUndefined()
    expect(f.calls).toEqual([])
    await expect(readFile(f.stateFile)).rejects.toThrow()
    await result.stop()
    expect(f.calls).toEqual(["stop"])
  }
})

test("missing key, development and package installs do not check or write state", async () => {
  for (const reason of ["no release public key", "development version", "package manager"]) {
    const f = await fixture("1.2.4", reason)
    const result = await startBackgroundUpdate({}, f.options)
    expect(result.notice).toBeUndefined()
    await result.finished
    expect(f.calls).toEqual(["cleanup"])
    await expect(readFile(f.stateFile)).rejects.toThrow()
  }
})

test("minimumVersion excludes lower targets and warns when the running version is too old", async () => {
  const f = await fixture()
  const result = await startBackgroundUpdate({ updates: { minimumVersion: "1.3.0" } }, f.options)
  expect(result.notice).toContain("below the required version 1.3.0")
  await result.finished
  expect(f.calls).toEqual(["cleanup", "check:stable"])
})

test("channel changes bypass old-channel cache and never display its notices", async () => {
  const f = await fixture("1.4.0-rc.1")
  await writeFile(
    f.stateFile,
    JSON.stringify({ checkedAt: 100_000_000, channel: "stable", available: "1.3.0" }),
  )
  const result = await startBackgroundUpdate({ updates: { channel: "next" } }, f.options)
  expect(result.notice).toBeUndefined()
  await result.finished
  expect(f.calls).toEqual(["cleanup", "check:next"])
})

test("background checks do not block startup and concurrent starts share a cache claim", async () => {
  const f = await fixture()
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  f.updater.check = async (channel = "stable") => {
    f.calls.push(`check:${channel}`)
    await pending
    return { version: "1.2.4", channel }
  }
  const first = await startBackgroundUpdate({}, f.options)
  const second = await startBackgroundUpdate({}, f.options)
  release()
  await Promise.all([first.finished, second.finished])
  expect(f.calls.filter((call) => call.startsWith("check:"))).toHaveLength(1)
})

test("shutdown fences pending checks without waiting for networking", async () => {
  const f = await fixture()
  let checked = () => {}
  const started = new Promise<void>((resolve) => {
    checked = resolve
  })
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  f.updater.check = async (channel = "stable") => {
    checked()
    await pending
    return { version: "1.2.4", channel }
  }
  f.updater.stop = async () => {
    f.calls.push("stop")
  }
  const background = await startBackgroundUpdate({}, f.options)
  await started
  await background.stop()
  expect(f.calls).toEqual(["cleanup", "stop"])
  release()
  await background.finished
  expect(f.calls).toEqual(["cleanup", "stop"])
})

test("shutdown drains an already-started local activation", async () => {
  const f = await fixture()
  let release = () => {}
  const local = new Promise<void>((resolve) => {
    release = resolve
  })
  f.updater.stop = async () => {
    await local
  }
  const background = await startBackgroundUpdate({}, f.options)
  let stopped = false
  const stopping = background.stop().then(() => {
    stopped = true
  })
  await Bun.sleep(0)
  expect(stopped).toBe(false)
  release()
  await stopping
  await background.finished
  expect(stopped).toBe(true)
})

test("corrupt state and cache write failures remain silent", async () => {
  const f = await fixture()
  for (const state of [
    "not json",
    JSON.stringify({ checkedAt: 100_000_000, channel: "stable", available: "invalid" }),
  ]) {
    await writeFile(f.stateFile, state)
    await (await startBackgroundUpdate({}, f.options)).finished
  }
  expect(f.calls.filter((call) => call === "check:stable")).toHaveLength(2)
  const invalid = await startBackgroundUpdate(
    {},
    { ...f.options, stateFile: path.join(f.stateFile, "child") },
  )
  await expect(invalid.finished).resolves.toBeUndefined()
})

test("print notices are human-only, never JSON, RPC, or redirected stderr", () => {
  expect(printUpdateNotice({ print: true, json: false, rpc: false, stderrTTY: true })).toBe(true)
  for (const override of [{ json: true }, { rpc: true }, { stderrTTY: false }, { print: false }]) {
    expect(printUpdateNotice({ print: true, json: false, rpc: false, stderrTTY: true, ...override })).toBe(
      false,
    )
  }
})

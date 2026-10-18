import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { UsageError } from "../src/args.ts"
import { runUpdateCommand, type UpdateEngine, updateSwitch } from "../src/update-command.ts"

function fixture(reason?: string) {
  const calls: string[] = []
  const updater: UpdateEngine = {
    disabledReason: async () => reason,
    check: async (channel = "stable") => {
      calls.push(`check:${channel}`)
      return { version: "1.2.4", channel }
    },
    update: async (channel = "stable") => {
      calls.push(`update:${channel}`)
      return "1.2.4"
    },
    rollback: async () => {
      calls.push("rollback")
      return "1.2.2"
    },
    cleanup: async () => {},
  }
  const io = {
    out: "",
    err: "",
    stdout(value: string) {
      this.out += value
    },
    stderr(value: string) {
      this.err += value
    },
  }
  const options = { updater, env: {}, settings: {}, source: "releases" as const, version: "1.2.3" }
  return { calls, updater, io, options }
}

test("update --check only checks; update installs and announces next-start activation", async () => {
  const f = fixture()
  expect(await runUpdateCommand(["update", "--check", "--channel", "next"], f.io, f.options)).toBe(0)
  expect(f.calls).toEqual(["check:next"])
  expect(f.io.out).toContain("1.2.4 is available on next")
  expect(await runUpdateCommand(["update"], f.io, f.options)).toBe(0)
  expect(f.calls).toEqual(["check:next", "check:stable", "update:stable"])
  expect(f.io.out).toContain("The change takes effect on the next start.")
})

test("rollback switches locally without checking or downloading, including offline", async () => {
  const f = fixture()
  expect(await runUpdateCommand(["rollback"], f.io, { ...f.options, env: { AMIRA_OFFLINE: "1" } })).toBe(0)
  expect(f.calls).toEqual(["rollback"])
  expect(f.io.out).toContain("Rolled back to Amira 1.2.2")
})

test("explicit update interruption drains local replacement and removes signal handlers", async () => {
  const f = fixture()
  const signals = new EventEmitter()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.updater.update = async () => {
    entered.resolve()
    await release.promise
    return "1.2.4"
  }
  f.updater.stop = async () => {
    f.calls.push("stop")
    await release.promise
  }
  const running = runUpdateCommand(["update"], f.io, { ...f.options, signals })
  await entered.promise
  try {
    expect(signals.listenerCount("SIGINT")).toBe(1)
    signals.emit("SIGINT")
    let finished = false
    void running.then(() => {
      finished = true
    })
    await Bun.sleep(0)
    expect(finished).toBe(false)
    release.resolve()
    expect(await running).toBe(130)
    expect(f.io.out).not.toContain("Updated to")
    expect(signals.listenerCount("SIGINT")).toBe(0)
    expect(signals.listenerCount("SIGTERM")).toBe(0)
  } finally {
    release.resolve()
    await running
  }
})

test("explicit update cancellation aborts networking without reporting a download failure", async () => {
  const f = fixture()
  const signals = new EventEmitter()
  const entered = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<never>()
  f.updater.check = async () => {
    entered.resolve()
    return aborted.promise
  }
  f.updater.stop = async () => {
    aborted.reject(new Error("cancelled download"))
  }
  const running = runUpdateCommand(["update"], f.io, { ...f.options, signals })
  await entered.promise
  signals.emit("SIGTERM")
  expect(await running).toBe(143)
  expect(f.io.err).toBe("")
  expect(signals.listenerCount("SIGTERM")).toBe(0)
})

test("invalid update and rollback arguments are usage errors", async () => {
  const f = fixture()
  for (const argv of [
    ["update", "--channel"],
    ["update", "--channel", "nightly"],
    ["update", "--channel="],
    ["update", "--wat"],
    ["update", "--check", "--check"],
    ["update", "--channel=next", "--channel", "stable"],
    ["rollback", "--check"],
  ]) {
    await expect(runUpdateCommand(argv, f.io, f.options)).rejects.toBeInstanceOf(UsageError)
  }
  expect(f.calls).toEqual([])
  expect(await runUpdateCommand(["provider"], f.io, f.options)).toBeUndefined()
})

test("npm, pnpm and Bun print the matching upgrade command without calling the updater", async () => {
  for (const [source, command] of [
    ["npm", "npm i -g amira"],
    ["pnpm", "pnpm add -g amira"],
    ["bun", "bun add -g amira"],
  ] as const) {
    const f = fixture("no release key")
    expect(await runUpdateCommand(["update"], f.io, { ...f.options, source })).toBe(0)
    expect(f.io.out).toContain(`Run: ${command}\n`)
    expect(await runUpdateCommand(["update", "--channel=next"], f.io, { ...f.options, source })).toBe(0)
    expect(f.io.out).toContain(`Run: ${command}@next\n`)
    expect(f.calls).toEqual([])
  }
})

test("package-manager rollback is unavailable and never suggests upgrading", async () => {
  for (const source of ["npm", "pnpm", "bun"] as const) {
    const f = fixture()
    expect(await runUpdateCommand(["rollback"], f.io, { ...f.options, source })).toBe(1)
    expect(f.io.err).toContain("rollback is unavailable")
    expect(f.io.err).toContain(source)
    expect(f.io.out).toBe("")
    expect(f.calls).toEqual([])
  }
})

test("rollback passes the configured minimum to the locked engine", async () => {
  const f = fixture()
  let minimum: string | undefined
  f.updater.rollback = async (value) => {
    minimum = value
    return "1.2.2"
  }
  expect(
    await runUpdateCommand(["rollback"], f.io, {
      ...f.options,
      settings: { updates: { minimumVersion: "1.2.2" } },
    }),
  ).toBe(0)
  expect(minimum).toBe("1.2.2")
})

test("no-key and unmanaged-install reasons are explained without network calls", async () => {
  for (const reason of [
    "Update checks are disabled: no release public key is configured.",
    "This is not a self-managed installation.",
  ]) {
    const f = fixture(reason)
    expect(await runUpdateCommand(["update"], f.io, f.options)).toBe(1)
    expect(f.io.err).toContain(reason)
    expect(f.calls).toEqual([])
  }
})

test("disable-updates blocks every command, offline blocks network, auto-update switch does not block explicit updates", async () => {
  for (const command of ["update", "rollback"]) {
    const f = fixture()
    expect(
      await runUpdateCommand([command], f.io, { ...f.options, env: { AMIRA_DISABLE_UPDATES: "1" } }),
    ).toBe(1)
    expect(f.io.err).toContain("AMIRA_DISABLE_UPDATES")
    expect(f.calls).toEqual([])
  }
  const offline = fixture()
  expect(
    await runUpdateCommand(["update"], offline.io, { ...offline.options, env: { AMIRA_OFFLINE: "1" } }),
  ).toBe(1)
  expect(offline.calls).toEqual([])
  const explicit = fixture()
  expect(
    await runUpdateCommand(["update"], explicit.io, {
      ...explicit.options,
      env: { AMIRA_DISABLE_AUTOUPDATE: "1" },
    }),
  ).toBe(0)
  expect(explicit.calls).toEqual(["check:stable", "update:stable"])
})

test("up-to-date checks do not downgrade, and minimumVersion rejects insufficient releases", async () => {
  const f = fixture()
  expect(await runUpdateCommand(["update"], f.io, { ...f.options, version: "1.3.0" })).toBe(0)
  expect(f.io.out).toContain("is up to date")
  expect(f.calls).toEqual(["check:stable"])
  expect(
    await runUpdateCommand(["update"], f.io, {
      ...f.options,
      settings: { updates: { minimumVersion: "1.3.0", channel: "next" } },
    }),
  ).toBe(1)
  expect(f.calls).toEqual(["check:stable", "check:next"])
  expect(f.io.err).toContain("below updates.minimumVersion (1.3.0)")
})

test("switches treat empty, zero and false as off", () => {
  for (const value of [undefined, "", "0", "false", "FALSE"]) expect(updateSwitch(value)).toBe(false)
  for (const value of ["1", "true", "yes"]) expect(updateSwitch(value)).toBe(true)
})

test("CLI dispatch reserves update and rollback, and diagnostics have no updater side effects", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "amira-update-cli-"))
  try {
    for (const argv of [["update", "--check"], ["rollback"], ["--version"], ["--help"]]) {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/main.ts"), ...argv], {
        env: { ...process.env, AMIRA_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (argv[0] === "update" || argv[0] === "rollback") {
        expect(code).toBe(1)
        expect(err).toContain("Development, source and 0.0.0 builds do not self-update")
      } else {
        expect(code).toBe(0)
        expect(err).toBe("")
        expect(out).not.toBe("")
      }
      expect(await readdir(home)).toEqual([])
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)

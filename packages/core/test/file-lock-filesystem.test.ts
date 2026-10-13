import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isProcessAlive, tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function finishWorker(worker: Bun.Subprocess<"ignore", "ignore", "pipe">) {
  if (worker.exitCode === null) worker.kill()
  await Promise.race([
    worker.exited,
    Bun.sleep(2000).then(() => {
      throw new Error("filesystem lock worker did not exit")
    }),
  ])
}

// This intentionally checks dependencies as well as behavior: session locks must not
// silently reintroduce an optional native runtime prerequisite.
test("the core lock dependency path contains no native bindings", () => {
  const sources = fs
    .readdirSync(path.join(import.meta.dir, "../src"))
    .filter((name) => /^file-lock.*\.ts$/.test(name))
  expect(sources).not.toContain("file-lock-arbiter.ts")
  const pending = sources.map((name) => path.join(import.meta.dir, "../src", name))
  const checked = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    if (checked.has(file)) continue
    checked.add(file)
    const source = fs.readFileSync(file, "utf8")
    expect(source).not.toMatch(/bun\s*:\s*ffi/)
    for (const [, dependency] of source.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g))
      pending.push(path.resolve(path.dirname(file), dependency!))
  }
})

for (const mode of ["no-native-fresh", "no-native-resume"]) {
  test(`SessionStore ${mode} claims work when the native loader rejects`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-filesystem-lock-"))
    dirs.push(dir)
    const worker = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(import.meta.dir, "file-lock-worker-preload.ts"),
        path.join(import.meta.dir, "file-lock-review-worker.ts"),
        dir,
        mode,
      ],
      {
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
        ),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    try {
      await Promise.race([
        worker.exited,
        Bun.sleep(4000).then(() => {
          throw new Error("no-native worker timed out")
        }),
      ])
      expect(await new Response(worker.stderr).text()).toBe("")
      expect(worker.exitCode).toBe(0)
      expect(fs.readFileSync(path.join(dir, "survived"), "utf8")).toBe("unchanged")
    } finally {
      await finishWorker(worker)
    }
  })
}

test("publication refuses an unknown empty gate that appears during private initialization", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-filesystem-empty-gate-"))
  dirs.push(dir)
  const file = path.join(dir, "session.lock")
  const gate = `${file}.lease-gate`
  const write = fs.writeFileSync
  let initialized = false
  const hook = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    write(...args)
    if (String(args[0]).endsWith(`${path.sep}owner.json`)) {
      initialized = true
      fs.mkdirSync(gate)
    }
  })
  try {
    expect(takeFilesystemGate(file)).toBeUndefined()
    expect(initialized).toBe(true)
    expect(fs.readdirSync(dir)).toEqual(["session.lock.lease-gate"])
    expect(fs.readdirSync(gate)).toEqual([])
    expect(tryFileLock(file, 1, undefined, true)).toBeUndefined()
    expect(fs.readdirSync(gate)).toEqual([])
  } finally {
    hook.mockRestore()
  }
})

test("dead gate recovery retains exactly its nonempty nonce tombstone across 120 later turns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-filesystem-tombstone-"))
  dirs.push(dir)
  const file = path.join(dir, "session.lock")
  const gate = `${file}.lease-gate`
  const worker = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      path.join(import.meta.dir, "file-lock-worker.ts"),
      file,
      dir,
      "crash-gate",
    ],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
      ),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  try {
    await Promise.race([
      worker.exited,
      Bun.sleep(4000).then(() => {
        throw new Error("crash-gate worker timed out")
      }),
    ])
    expect(await new Response(worker.stderr).text()).toBe("")
    expect(worker.exitCode).toBe(0)
    expect(isProcessAlive(worker.pid)).toBe(false)
    const record = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
    const owner = JSON.parse(record)
    expect(owner.pid).toBe(worker.pid)
    const name = `session.lock.lease-gate.dead-${owner.nonce}`
    const tombstone = path.join(dir, name)
    for (let turn = 0; turn < 120; turn++) {
      const held = tryFileLock(file, 1, undefined, true)
      expect(held).toBeDefined()
      held!.release()
      expect(fs.readdirSync(dir)).toEqual([name])
      expect(fs.readdirSync(tombstone)).toEqual(["owner.json"])
      expect(fs.readFileSync(path.join(tombstone, "owner.json"), "utf8")).toBe(record)
    }
  } finally {
    await finishWorker(worker)
  }
})

test("normal gate release validates its own nonce and never removes a replacement gate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-filesystem-release-"))
  dirs.push(dir)
  const file = path.join(dir, "session.lock")
  const gate = `${file}.lease-gate`
  const original = takeFilesystemGate(file)!
  expect(original).toBeDefined()
  fs.renameSync(gate, `${gate}.displaced`)
  const replacement = takeFilesystemGate(file)!
  expect(replacement).toBeDefined()
  const record = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
  try {
    original()
    expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(record)
    expect(takeFilesystemGate(file)).toBeUndefined()
    expect(fs.readdirSync(dir).sort()).toEqual([
      "session.lock.lease-gate",
      "session.lock.lease-gate.displaced",
    ])
  } finally {
    original()
    replacement()
  }
  expect(fs.readdirSync(dir)).toEqual(["session.lock.lease-gate.displaced"])
})

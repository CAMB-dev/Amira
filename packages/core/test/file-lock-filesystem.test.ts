import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnWork } from "../../../scripts/spawn-test.ts"
import { isProcessAlive, tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { aliasedDirectory } from "./file-lock-fixtures.ts"
import { waitForFileLockWorkerExit, waitForFileLockWorkerReady } from "./file-lock-test-waits.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function finishWorker(worker: Bun.Subprocess<"ignore", "ignore", "pipe">) {
  if (worker.exitCode === null) worker.kill()
  await waitForFileLockWorkerExit(worker, "filesystem lock worker cleanup")
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
  test(
    `SessionStore ${mode} claims work when the native loader rejects`,
    async () => {
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
          windowsHide: true,
          env: Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
          ),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      try {
        await waitForFileLockWorkerReady(worker, dir, `SessionStore ${mode} worker`)
        await waitForFileLockWorkerExit(worker, `SessionStore ${mode} operation`)
        expect(
          await waitForSpawnWork(`worker stderr (pid ${worker.pid})`, new Response(worker.stderr).text()),
        ).toBe("")
        expect(worker.exitCode).toBe(0)
        expect(fs.readFileSync(path.join(dir, "survived"), "utf8")).toBe("unchanged")
      } finally {
        await finishWorker(worker)
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
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

test(
  "dead gate recovery retains exactly its nonempty nonce tombstone across 120 later turns",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "amira-filesystem-tombstone-"))
    dirs.push(root)
    const dir = aliasedDirectory(root)
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
        "ready-go",
      ],
      {
        windowsHide: true,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
        ),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    try {
      await waitForFileLockWorkerReady(worker, dir, "crash-gate worker")
      await waitForFileLockWorkerExit(worker, "crash-gate operation")
      expect(
        await waitForSpawnWork(`worker stderr (pid ${worker.pid})`, new Response(worker.stderr).text()),
      ).toBe("")
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
  },
  SPAWN_TEST_TIMEOUT_MS,
)

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

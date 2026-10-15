import { spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { filesystemGatePath } from "./file-lock-fixtures.ts"
import { fileLockWorkerReady, waitForFileLockCondition } from "./file-lock-test-waits.ts"

const [dir, mode] = process.argv.slice(2)
if (!dir || !mode) throw new Error("missing review worker arguments")

if (mode.startsWith("no-native-")) {
  await fileLockWorkerReady(dir)
  // Intercept the module without importing or loading any real native bindings.
  Bun.plugin({
    name: "reject-native-loader",
    setup(build) {
      build.onLoad({ filter: /file-lock.*\.ts$/ }, (args) => {
        const source = fs.readFileSync(args.path, "utf8")
        return {
          contents: source.replace(
            /import[^\n]+["']bun\s*:\s*ffi["'][^\n]*/g,
            `const FFIType = new Proxy({}, { get: () => 0 });
             const ptr = () => 0; const toArrayBuffer = () => new ArrayBuffer(4);
             const dlopen = () => { throw new Error("injected native loader unavailable") };`,
          ),
          loader: "ts",
        }
      })
    },
  })
  const { tryFileLock } = await import("../src/file-lock.ts")
  const ordinaryPath = path.join(dir, "ordinary.lock")
  const ordinary = tryFileLock(ordinaryPath, 60_000)
  if (!ordinary) throw new Error("default lock failed without native support")
  ordinary.release()
  const { SessionStore } = await import("../src/session-store.ts")
  const fresh = SessionStore.create({ cwd: dir, dir })
  // Seed a header directly so the resumed claim is the first operation needing authority.
  if (mode === "no-native-resume") fs.writeFileSync(fresh.file, `${JSON.stringify(fresh.header)}\n`)
  const store = mode === "no-native-resume" ? SessionStore.open(fresh.file) : fresh
  if (!store.claim()) throw new Error("session claim was not granted")
  store.appendMessage({ role: "user", content: [{ type: "text", text: "written" }] })
  store.release()
  if (SessionStore.open(store.file).entries.length !== 1) throw new Error("session write lost")
  const afterClaim = tryFileLock(ordinaryPath, 60_000)
  if (!afterClaim) throw new Error("strict session claim disabled default locks")
  afterClaim.release()
  fs.writeFileSync(path.join(dir, "survived"), "unchanged")
} else {
  const open = fs.openSync
  const close = fs.closeSync
  let retained: number | undefined
  let closed = false
  const openHook = spyOn(fs, "openSync").mockImplementation((...args) => {
    const fd = open(...args)
    if (String(args[0]).includes("session.lock.pending-")) retained = fd
    return fd
  })
  const closeHook = spyOn(fs, "closeSync").mockImplementation((fd) => {
    if (fd === retained) closed = true
    return close(fd)
  })
  const { tryFileLock } = await import("../src/file-lock.ts")
  const { takeFilesystemGate } = await import("../src/file-lock-gate.ts")
  const parent = path.join(dir, "parent")
  fs.mkdirSync(parent)
  const leasePath = path.join(parent, "session.lock")
  const gate = filesystemGatePath(leasePath)
  const canonicalParent = path.dirname(gate)
  const lease = tryFileLock(leasePath, 60_000, undefined, true)!
  const unblock = takeFilesystemGate(leasePath)!
  if (!lease || !unblock) throw new Error("could not set up deferred release")
  // Importing modules and constructing the lease/gate are setup, not deferred release.
  fs.writeFileSync(path.join(dir, `ready-${process.pid}`), "ready")
  await waitForFileLockCondition(`review worker ${mode}: review-go`, () =>
    fs.existsSync(path.join(dir, "review-go")),
  )
  lease.release()
  unblock()
  // A directory move keeps the retained inode/lease intact on Windows as well.
  const moved = path.join(dir, "moved")
  const filesystemFault = mode === "release-fs-error" || mode === "release-cleanup-error"
  if (!filesystemFault) fs.renameSync(parent, moved)
  const movedLease = filesystemFault ? leasePath : path.join(moved, "session.lock")
  const original = fs.readFileSync(movedLease, "utf8")
  let rogueWrites = 0
  const mkdtemp = fs.mkdtempSync
  const directoryHook = spyOn(fs, "mkdtempSync").mockImplementation((...args) => {
    if (String(args[0]).startsWith(`${canonicalParent}${path.sep}`)) {
      rogueWrites++
      if (mode === "release-fs-error") throw new Error("injected gate staging failure")
    }
    return Reflect.apply(mkdtemp, fs, args)
  })
  const warnings: string[] = []
  let cleanupAttempts = 0
  let prematureWarning = false
  const warningHook = spyOn(process, "emitWarning").mockImplementation((message) => {
    // The inline failure and five automatic retries must precede the final warning.
    if (mode === "release-cleanup-error" && cleanupAttempts < 6) prematureWarning = true
    warnings.push(String(message))
  })
  const rename = fs.renameSync
  let gateRecord: string | undefined
  const cleanupHook = spyOn(fs, "renameSync").mockImplementation((...args) => {
    if (mode === "release-cleanup-error" && args[0] === gate) {
      cleanupAttempts++
      if (gateRecord === undefined) gateRecord = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
      throw new Error("injected gate retirement failure")
    }
    return rename(...args)
  })
  if (mode === "release-replaced-parent") fs.writeFileSync(parent, "replacement parent")
  else if (mode === "release-replaced-directory") {
    fs.mkdirSync(parent)
    fs.writeFileSync(leasePath, "unverifiable replacement")
  } else if (mode !== "release-missing-parent" && !filesystemFault) throw new Error(`unknown mode: ${mode}`)
  // Observe the actual close, not an assumed number of scheduled retry turns.
  await waitForFileLockCondition(`review worker ${mode}: retained lease descriptor close`, () => closed)
  if (mode === "release-cleanup-error") {
    if (gateRecord === undefined || JSON.parse(gateRecord).pid !== process.pid)
      throw new Error("lost pending gate owner")
    await waitForFileLockCondition(`review worker ${mode}: final cleanup warning`, () => warnings.length > 0)
    if (prematureWarning) throw new Error("premature cleanup warning")
    if (
      warnings.slice().length !== 1 ||
      !warnings[0]?.includes(gate) ||
      !warnings[0]?.includes("injected gate retirement failure")
    )
      throw new Error("missing informative final cleanup warning")
    if (fs.readFileSync(path.join(gate, "owner.json"), "utf8") !== gateRecord)
      throw new Error("pending cleanup changed owner bytes")
  } else if (warnings.length !== 0) throw new Error("unexpected cleanup warning")
  if (mode === "release-replaced-directory") {
    if (rogueWrites !== 0 || fs.readFileSync(leasePath, "utf8") !== "unverifiable replacement")
      throw new Error("deferred release wrote into replaced parent")
    if (fs.readdirSync(parent).join(",") !== "session.lock") throw new Error("rogue replacement artifacts")
  }
  if (!filesystemFault && rogueWrites !== 0) throw new Error("deferred release attempted rogue writes")
  directoryHook.mockRestore()
  cleanupHook.mockRestore()
  if (!closed || retained === undefined) throw new Error("retained lease descriptor leaked")
  if (mode !== "release-cleanup-error" && fs.readFileSync(movedLease, "utf8") !== original)
    throw new Error("moved lease changed")
  if (mode === "release-cleanup-error") {
    if (fs.existsSync(leasePath)) throw new Error("release did not remove owned lease")
    if (!fs.existsSync(gate)) throw new Error("fault did not preserve initialized gate")
    const recovered = tryFileLock(leasePath, 60_000, undefined, true)
    if (!recovered) throw new Error("next acquire did not retry exact pending gate")
    recovered.release()
    if (fs.readdirSync(parent).length !== 0) throw new Error("retried cleanup leaked gate/lease artifacts")
    if (warnings.slice().length !== 1) throw new Error("cleanup warning repeated")
  }
  warningHook.mockRestore()
  if (mode === "release-missing-parent" && fs.existsSync(parent)) {
    throw new Error("deferred release recreated missing parent")
  }
  if (mode === "release-replaced-parent" && fs.readFileSync(parent, "utf8") !== "replacement parent") {
    throw new Error("deferred release changed replacement parent")
  }
  fs.writeFileSync(path.join(dir, "survived"), "unchanged")
  openHook.mockRestore()
  closeHook.mockRestore()
}

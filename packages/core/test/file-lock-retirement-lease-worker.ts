import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { filesystemGatePath } from "./file-lock-fixtures.ts"

const [dir, mode] = process.argv.slice(2)
if (!dir) throw new Error("missing lease retirement directory")
const file = path.join(dir, "session.lock")
const gate = filesystemGatePath(file)
let fd: number | undefined
let closed = false
const open = fs.openSync
const close = fs.closeSync
spyOn(fs, "openSync").mockImplementation((...args) => {
  const result = open(...args)
  if (String(args[0]).includes("session.lock.pending-")) fd = result
  return result
})
spyOn(fs, "closeSync").mockImplementation((value) => {
  if (value === fd) closed = true
  return close(value)
})
const warnings: string[] = []
spyOn(process, "emitWarning").mockImplementation((message) => {
  warnings.push(String(message))
})
const lease = tryFileLock(file, 1, 10, true)!
expect(lease).toBeDefined()
expect(fd).toBeDefined()
const original = fs.readFileSync(file, "utf8")
const unlock = takeFilesystemGate(file)!
let blocked = true
let attempts = 0
const rename = fs.renameSync
spyOn(fs, "renameSync").mockImplementation((...args) => {
  if (args[0] === gate && blocked) {
    attempts++
    throw Object.assign(new Error("persistent reader"), { code: "EBUSY" })
  }
  return rename(...args)
})
unlock()
lease.release()
if (mode?.startsWith("exit-")) {
  const record = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
  blocked = mode === "exit-failure"
  process.on("exit", () => {
    expect(closed).toBe(true)
    if (blocked) {
      expect(fs.readFileSync(file, "utf8")).toBe(original)
      expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(record)
      expect(
        warnings.filter((message) => message.startsWith("Filesystem gate cleanup failed:")),
      ).toHaveLength(1)
      expect(warnings.some((message) => message.includes(gate) && message.includes("EBUSY"))).toBe(true)
    } else {
      expect(warnings).toEqual([])
      expect(fs.readdirSync(dir)).toEqual([])
    }
  })
  process.exit(0)
}
await Bun.sleep(1700)
expect(closed).toBe(true)
expect(fs.readFileSync(file, "utf8")).toBe(original)
const count = attempts
await Bun.sleep(250)
expect(attempts).toBe(count)
expect(warnings.some((message) => message.includes(gate) && message.includes("EBUSY"))).toBe(true)
// Manual retry while the reader remains held must not resurrect either timer chain.
lease.release()
expect(attempts).toBe(count + 1)
const warningCount = warnings.length
await Bun.sleep(250)
expect(attempts).toBe(count + 1)
expect(warnings).toHaveLength(warningCount)
blocked = false
// Even after exhausting timers and closing the fd, the exact inode/nonce remains
// available for an explicit later release; nothing is unlinked without the gate.
if (mode === "acquire") {
  const next = tryFileLock(file, 1, undefined, true)
  expect(next).toBeDefined()
  const contents = fs.readFileSync(file, "utf8")
  expect(contents).not.toBe(original)
  lease.release()
  expect(fs.readFileSync(file, "utf8")).toBe(contents)
  next!.release()
} else lease.release()
expect(fs.readdirSync(dir)).toEqual([])

import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { startGateReader } from "./file-lock-reader-fixture.ts"

const [dir] = process.argv.slice(2)
if (!dir || process.platform !== "win32") throw new Error("Windows temporary reader required")
const file = path.join(dir, "reader.lock")
const gate = `${file}.lease-gate`
const lease = tryFileLock(file, 1, undefined, true)!
expect(lease).toBeDefined()
const unlock = takeFilesystemGate(file)!
expect(unlock).toBeDefined()
const metadata = path.join(gate, "owner.json")
const contents = fs.readFileSync(metadata, "utf8")
const warnings: string[] = []
spyOn(process, "emitWarning").mockImplementation((message) => {
  warnings.push(String(message))
})
const waits = spyOn(Atomics, "wait")
const { reader, ready, go } = startGateReader(metadata, dir)
try {
  const deadline = Date.now() + 3000
  while (!fs.existsSync(ready)) {
    if (reader.exitCode !== null || Date.now() > deadline) throw new Error("reader readiness failed")
    await Bun.sleep(2)
  }
  lease.release()
  expect(fs.readFileSync(file, "utf8")).toContain(String(process.pid))
  const before = performance.now()
  const callback = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - before), 0))
  fs.writeFileSync(go, "go")
  unlock()
  const elapsed = await callback
  console.log(`Windows reader: zero-delay callback ${elapsed.toFixed(2)}ms`)
  expect(elapsed).toBeLessThan(20)
  expect(fs.readFileSync(metadata, "utf8")).toBe(contents)
  expect(warnings).toEqual([])
  await Promise.race([
    reader.exited,
    Bun.sleep(2000).then(() => {
      throw new Error("reader exit timed out")
    }),
  ])
  expect(reader.exitCode).toBe(0)
  expect(await new Response(reader.stderr).text()).toBe("")
  await Bun.sleep(300)
  expect(waits).not.toHaveBeenCalled()
  expect(warnings).toEqual([])
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.existsSync(gate)).toBe(false)
  const next = tryFileLock(file, 1, undefined, true)!
  expect(next).toBeDefined()
  next.release()
  expect(fs.readdirSync(dir).sort()).toEqual(["reader-go", "reader-ready"])
} finally {
  if (reader.exitCode === null) reader.kill()
  await Promise.race([
    reader.exited,
    Bun.sleep(2000).then(() => {
      throw new Error("owned reader failed to stop")
    }),
  ])
  lease.release()
}

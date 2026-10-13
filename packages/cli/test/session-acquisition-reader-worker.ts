import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { type Agent, SessionStore, sessionLockFile } from "@amira/core"
import { takeFilesystemGate } from "../../core/src/file-lock-gate.ts"
import { boundedExit, startGateReader } from "../../core/test/file-lock-reader-fixture.ts"
import { createSession } from "../src/session.ts"

const [dir, boundary] = process.argv.slice(2)
if (!dir || process.platform !== "win32") throw new Error("isolated Windows acquisition fixture required")
if (boundary !== "resume" && boundary !== "startup") throw new Error("acquisition boundary required")
const mock = createMockDialect([])
const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
const store = SessionStore.create({ cwd: dir, dir })
const options = { ai, model: "mock/m", cwd: dir, extensions: [], noBuiltins: true, catalog: false as const }
const session = await createSession({ ...options, store })
store.appendMessage(userMessage("saved"))
const stale = SessionStore.open(store.file)
store.appendMessage(userMessage("current disk history"))
const file = sessionLockFile(store.file)
const gate = `${file}.lease-gate`
const unlock = takeFilesystemGate(file)
expect(unlock).toBeDefined()
const metadata = path.join(gate, "owner.json")
const contents = fs.readFileSync(metadata, "utf8")
expect(JSON.parse(contents).pid).toBe(process.pid)
const { reader, ready, go } = startGateReader(metadata, dir)
const waits = spyOn(Atomics, "wait")
let resumed: Agent | undefined
let pending: Agent | Promise<Agent> | undefined
const acquire = SessionStore.prototype.withClaim
let entered!: (measurement: { start: number; callback: Promise<number> }) => void
const acquisitionStarted = new Promise<{ start: number; callback: Promise<number> }>((resolve) => {
  entered = resolve
})
const acquisition = spyOn(SessionStore.prototype, "withClaim").mockImplementation(function <T>(
  this: SessionStore,
  construct: () => T,
  opts?: Parameters<SessionStore["withClaim"]>[1],
) {
  const start = performance.now()
  const callback = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - start), 0))
  entered({ start, callback })
  return (acquire<T>).call(this, construct, opts)
})
try {
  // PowerShell startup is OUTSIDE the measured warm acquisition interval.
  const deadline = performance.now() + 3000
  while (!fs.existsSync(ready)) {
    if (reader.exitCode !== null || performance.now() > deadline) throw new Error("reader readiness failed")
    await Bun.sleep(2)
  }
  await session.agent.dispose()
  expect(fs.readFileSync(file, "utf8").split("\n")[0]).toBe(String(process.pid))
  fs.writeFileSync(go, "go")
  unlock!()
  expect(fs.readFileSync(metadata, "utf8")).toBe(contents)
  pending =
    boundary === "resume"
      ? session.resume(stale)
      : createSession({ ...options, store: stale }).then((next) => next.agent)
  const { start, callback } = await acquisitionStarted
  const zero = await callback
  expect(zero).toBeLessThan(20)
  expect(reader.exitCode).toBeNull()
  resumed = await pending
  const elapsed = performance.now() - start
  expect(elapsed).toBeGreaterThanOrEqual(75)
  expect(elapsed).toBeLessThan(2000)
  console.log(`Windows ${boundary}: acquisition ${elapsed.toFixed(2)}ms, zero-delay ${zero.toFixed(2)}ms`)
  expect(await boundedExit(reader, "reader")).toBe(0)
  expect(await new Response(reader.stderr).text()).toBe("")
  expect(resumed.messages).toEqual([userMessage("saved"), userMessage("current disk history")])
  expect(mock.requests).toHaveLength(0)
  expect(waits).not.toHaveBeenCalled()
  await resumed.dispose()
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.existsSync(gate)).toBe(false)
} finally {
  fs.writeFileSync(go, "go")
  if (reader.exitCode === null) reader.kill()
  await boundedExit(reader, "owned reader stop")
  unlock!()
  acquisition.mockRestore()
  if (!resumed && pending) resumed = await pending
  await resumed?.dispose()
  await session.agent.dispose()
}

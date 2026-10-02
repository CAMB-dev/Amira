import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { SessionStore } from "@amira/core"
import { createCommandHost } from "../src/control.ts"
import { runRpc } from "../src/rpc.ts"
import { closeTrace } from "../src/session/trace-shutdown.ts"
import { createSession } from "../src/session.ts"

function ai() {
  return createAi({
    dialects: [createMockDialect([{ text: "first" }, { text: "second" }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
}

test("one host recorder follows stored agents across resume and backs control snapshots by default", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-host-"))
  const store = SessionStore.create({ cwd: dir, dir })
  const session = await createSession({
    model: "mock/main",
    cwd: dir,
    extensions: [],
    noBuiltins: true,
    ai: ai(),
    store,
  })
  const commands = createCommandHost({ session, cwd: dir })
  const recorder = session.traceRecorder
  expect(recorder).toBeDefined()
  let active = session.agent
  try {
    // No sessionFile in the announcement: createSession registers the store's authoritative path.
    active.start("startup")
    await active.prompt("first")
    await active.bus.flush()
    const first = await commands.control.trace()
    expect(first[0]).toMatchObject({ type: "trace", sessionId: store.id })
    expect(first.some((record) => record.type === "turn")).toBe(true)
    await active.dispose("switch")
    active = session.resume(SessionStore.open(store.file))
    commands.switchTo(active)
    active.start("resume")
    await active.prompt("second")
    await active.bus.flush()
    expect(session.traceRecorder).toBe(recorder)
    const resumed = await commands.control.trace()
    expect(resumed.filter((record) => record.type === "trace")).toHaveLength(2)
    expect(resumed.filter((record) => record.type === "turn")).toHaveLength(2)
  } finally {
    await active.dispose("exit")
    await closeTrace(active.bus, recorder)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("RPC second interrupt delegates exit to the host hook without exiting the test process", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-rpc-exit-"))
  const session = await createSession({
    model: "mock/main",
    cwd: dir,
    extensions: [],
    noBuiltins: true,
    ai: ai(),
  })
  let finish!: () => void
  const stopped = new Promise<void>((resolve) => {
    finish = resolve
  })
  const exitCodes: number[] = []
  const done = runRpc(session, {
    io: {
      lines: (async function* () {
        await stopped
        yield ""
      })(),
      write: () => {},
    },
    forceExit: (code) => exitCodes.push(code),
  })
  try {
    process.emit("SIGINT")
    expect(exitCodes).toEqual([])
    process.emit("SIGINT")
    expect(exitCodes).toEqual([130])
  } finally {
    finish()
    await done
    await closeTrace(session.agent.bus, session.traceRecorder)
    rmSync(dir, { recursive: true, force: true })
  }
})

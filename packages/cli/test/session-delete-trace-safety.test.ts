import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { SessionStore } from "@amira/core"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

for (const component of ["root", "subagents"]) {
  test(`delayed trace cleanup cannot follow a replaced ${component} directory`, async () => {
    const parent = realpathSync.native(mkdtempSync(path.join(tmpdir(), "amira-trace-delete-safety-")))
    const dir = path.join(parent, "sessions")
    const outside = path.join(parent, "outside")
    const saved = path.join(parent, "saved")
    mkdirSync(outside)
    const current = SessionStore.create({ cwd: parent, dir })
    current.appendMessage(userMessage("current"))
    const other = SessionStore.create({ cwd: parent, dir })
    other.appendMessage(userMessage("other"))
    const child = SessionStore.create({ cwd: parent, dir: path.join(dir, "subagents") })
    child.appendMessage(userMessage("child"))
    other.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
    const victim = component === "root" ? other : child
    const outsideTrace = path.join(outside, `${path.basename(victim.file)}.trace.jsonl`)
    writeFileSync(outsideTrace, "outside trace")
    const session = await createSession({
      cwd: parent,
      ai: createAi({
        dialects: [createMockDialect([])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      }),
      model: "mock/m",
      store: current,
      extensions: [],
      noBuiltins: true,
    })
    let attempted = false
    let swapped = false
    const host = createCommandHost({
      cwd: parent,
      session,
      trace: {
        read: async () => [],
        forget: async () => {
          attempted = true
          const target = component === "root" ? dir : path.join(dir, "subagents")
          renameSync(target, saved)
          symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir")
          swapped = true
        },
      },
    })
    try {
      await expect(host.control.deleteSession!(other.id)).rejects.toThrow("unsafe")
      expect(attempted).toBe(true)
      expect(swapped).toBe(true)
      expect(readFileSync(outsideTrace, "utf8")).toBe("outside trace")
    } finally {
      if (swapped) {
        const target = component === "root" ? dir : path.join(dir, "subagents")
        rmSync(target, { force: true, recursive: true })
        renameSync(saved, target)
      }
      await session.agent.dispose("exit")
      await session.agent.bus.flush()
      await session.traceRecorder?.close()
      rmSync(parent, { force: true, recursive: true })
    }
  })
}

test("trace cleanup rejects a subagents junction replaced after the private root rename", async () => {
  const parent = realpathSync.native(mkdtempSync(path.join(tmpdir(), "amira-trace-delete-safety-")))
  const dir = path.join(parent, "sessions")
  const outside = path.join(parent, "outside")
  const saved = path.join(parent, "saved")
  mkdirSync(outside)
  const current = SessionStore.create({ cwd: parent, dir })
  current.appendMessage(userMessage("current"))
  const other = SessionStore.create({ cwd: parent, dir })
  other.appendMessage(userMessage("other"))
  const child = SessionStore.create({ cwd: parent, dir: path.join(dir, "subagents") })
  child.appendMessage(userMessage("child"))
  other.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
  const outsideTrace = path.join(outside, `${path.basename(child.file)}.trace.jsonl`)
  writeFileSync(outsideTrace, "outside trace")
  const session = await createSession({
    cwd: parent,
    ai: createAi({
      dialects: [createMockDialect([])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    model: "mock/m",
    store: current,
    extensions: [],
    noBuiltins: true,
  })
  let forgotten = false
  let swapped = false
  const rename = fs.renameSync
  const relocation = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    rename(from, to)
    if (!forgotten || swapped || String(from) !== dir) return
    const target = path.join(String(to), "subagents")
    rename(target, saved)
    symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir")
    swapped = true
  })
  const host = createCommandHost({
    cwd: parent,
    session,
    trace: {
      read: async () => [],
      forget: async () => {
        writeFileSync(`${other.file}.trace.jsonl`, "late root trace")
        writeFileSync(`${child.file}.trace.jsonl`, "late child trace")
        forgotten = true
      },
    },
  })
  try {
    await expect(host.control.deleteSession!(other.id)).rejects.toThrow("unsafe")
    expect(forgotten).toBe(true)
    expect(swapped).toBe(true)
    expect(readFileSync(outsideTrace, "utf8")).toBe("outside trace")
    expect(readFileSync(path.join(saved, `${path.basename(child.file)}.trace.jsonl`), "utf8")).toBe(
      "late child trace",
    )
    expect(readFileSync(`${other.file}.trace.jsonl`, "utf8")).toBe("late root trace")
  } finally {
    relocation.mockRestore()
    await session.agent.dispose("exit")
    await session.agent.bus.flush()
    await session.traceRecorder?.close()
    rmSync(parent, { force: true, recursive: true })
  }
})

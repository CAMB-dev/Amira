import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { Settings } from "@amira/api"
import { writeTool } from "@amira/builtin-tools"
import { SessionStore, validateSettings } from "@amira/core"
import commandsExtension from "@amira/ext-commands"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

const dirs: string[] = []
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "amira-rewind-control-"))
  dirs.push(dir)
  return dir
}
let savedHome: string | undefined
beforeAll(() => {
  savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = temporary()
})
afterAll(() => {
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const writing: MockStep = { toolCalls: [{ name: "write", args: { path: "a", content: "tool" } }] }

async function setup(steps: MockStep[] = [writing, { text: "done" }], settings: Settings = {}) {
  const cwd = temporary()
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const store = SessionStore.create({ cwd, dir: join(cwd, "sessions") })
  const session = await createSession({
    cwd,
    ai,
    store,
    model: "mock/m",
    extensions: [],
    noBuiltins: false,
    settings,
    builtins: async () => [
      {
        source: "tools",
        extension: (api) => {
          api.registerTool(writeTool)
        },
      },
      { source: "commands", extension: commandsExtension },
    ],
  })
  const host = createCommandHost({ cwd, session, home: temporary() })
  return { cwd, store, session, host }
}

test("session.rewind restores file-tool writes by default and resumes the same recording", async () => {
  const { cwd, store, host } = await setup()
  writeFileSync(join(cwd, "a"), "original")
  await host.control.send("change a")
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("tool")
  expect(host.control.planRewind!(0)).toMatchObject({
    owner: "core",
    enabled: true,
    restored: 1,
    removed: 0,
    conflicts: [],
  })
  await host.control.rewind!(0)
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("original")
  expect(host.control.messages()).toHaveLength(0)
  expect(host.agent.session!.id).toBe(store.id)
  expect(SessionStore.open(store.file).restore().messages).toHaveLength(0)
})

test("conflicts leave both the conversation and every file in place", async () => {
  const { cwd, store, host } = await setup()
  await host.control.send("create a")
  writeFileSync(join(cwd, "a"), "shell")
  const messages = [...host.control.messages()]
  const leaf = store.leafId
  await expect(host.control.rewind!(0)).rejects.toThrow("Conflicts")
  expect(host.control.messages()).toEqual(messages)
  expect(store.leafId).toBe(leaf)
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("shell")
  await host.control.rewind!(0, { restoreFiles: false })
  expect(host.control.messages()).toHaveLength(0)
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("shell")
})

test("an interrupted core restore cannot become conversation-only or an extension restore", async () => {
  const { cwd, store, session, host } = await setup()
  writeFileSync(join(cwd, "a"), "original")
  await host.control.send("change a")
  const append = store.appendDurable.bind(store)
  const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
    if (entry.type === "file_restore_progress") throw new Error("interrupted")
    return append(entry)
  })
  try {
    await expect(host.control.rewind!(0)).rejects.toThrow("interrupted")
  } finally {
    crash.mockRestore()
  }
  await expect(host.control.rewind!(0, { restoreFiles: false })).rejects.toThrow(
    "interrupted core file restore",
  )
  expect(host.control.planRewind!(0)).toMatchObject({ conflicts: [], restored: 1 })
  let extensionCalls = 0
  await session.host.load((api) => {
    api.registerFileRestoration({
      label: "Checkpoint",
      restore: async () => {
        extensionCalls++
      },
    })
  }, "checkpoints")
  await expect(host.control.rewind!(0)).rejects.toThrow("interrupted core file restore")
  expect(extensionCalls).toBe(0)
  session.host.unload("checkpoints")
  await host.control.rewind!(0)
  expect(host.control.messages()).toHaveLength(0)
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("original")
})

test("capture settings are validated and disable restoration in the control preview", async () => {
  expect(
    validateSettings({ fileRewind: { enabled: false, maxFileBytes: 1, quotaBytes: 2 } }, "test").settings
      .fileRewind,
  ).toEqual({ enabled: false, maxFileBytes: 1, quotaBytes: 2 })
  expect(() => validateSettings({ fileRewind: { maxFileBytes: 0 } }, "test")).toThrow("at least 1")
  const { cwd, store, host } = await setup(undefined, { fileRewind: { enabled: false, maxFileBytes: 1 } })
  await host.control.send("create a")
  expect(store.entries.some((e) => e.type === "file_mutation")).toBe(false)
  expect(host.control.planRewind!(0).note).toContain("disabled")
  await host.control.rewind!(0)
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("tool")
})

for (const enabled of [true, false]) {
  test(`a failing session journal refuses writes only with capture enabled (${enabled})`, async () => {
    const { cwd, store, host } = await setup(undefined, { fileRewind: { enabled } })
    const fail = spyOn(store, "append").mockImplementation(() => {
      throw new Error("session disk unavailable")
    })
    try {
      await host.control.send("create a")
      expect(existsSync(join(cwd, "a"))).toBe(!enabled)
      if (!enabled) expect(readFileSync(join(cwd, "a"), "utf8")).toBe("tool")
    } finally {
      fail.mockRestore()
    }
  })
}

test("an extension owns restoration exclusively; failure preserves conversation; unload releases ownership", async () => {
  const { cwd, store, session, host } = await setup()
  await host.control.send("create a")
  let calls = 0
  let fail = true
  expect(
    await session.host.load((api) => {
      api.registerFileRestoration({
        label: "Restore checkpoint files",
        restore: async (index) => {
          expect(index).toBe(0)
          calls++
          if (fail) throw new Error("extension conflict")
          writeFileSync(join(cwd, "a"), "checkpoint")
        },
      })
    }, "checkpoints"),
  ).toBe(true)
  expect(host.control.planRewind!(0).owner).toBe("Restore checkpoint files")
  expect(
    await session.host.load((api) => {
      api.registerFileRestoration({ label: "Second owner", restore: async () => {} })
    }, "second"),
  ).toBe(false)
  await expect(host.control.rewind!(0)).rejects.toThrow("extension conflict")
  expect(host.control.messages().length).toBeGreaterThan(0)
  fail = false
  await host.control.rewind!(0)
  expect(calls).toBe(2)
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("checkpoint")
  expect(store.entries.some((e) => e.type === "file_restore")).toBe(false)
  expect(session.host.unload("checkpoints")).toBe(true)
  expect(session.host.fileRestoration).toBeUndefined()
})

test("conversation-only rewind never invokes an extension's restore", async () => {
  const { session, host } = await setup()
  await host.control.send("create a")
  let calls = 0
  await session.host.load((api) => {
    api.registerFileRestoration({
      label: "Checkpoint",
      restore: async () => {
        calls++
      },
    })
  }, "checkpoints")
  await host.control.rewind!(0, { restoreFiles: false })
  expect(calls).toBe(0)
})

test("finishing an extension rewind does not start a queued prompt in the discarded agent", async () => {
  const { session, store, host } = await setup()
  await host.control.send("create a")
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  await session.host.load((api) => {
    api.registerFileRestoration({
      label: "Checkpoint",
      restore: async () => {
        started()
        await waiting
      },
    })
  }, "checkpoints")
  const rewind = host.control.rewind!(0)
  await ready
  const queued = host.agent.prompt("discarded prompt").then(
    () => "resolved",
    (error: Error) => error.message,
  )
  release()
  await rewind
  expect(await queued).toContain("aborted")
  expect(host.control.messages()).toHaveLength(0)
  expect(store.entries.filter((e) => e.type === "message" && e.message.role === "user")).toHaveLength(1)
})

test("session resume finishes an interrupted restore and reports its coverage", async () => {
  const { cwd, session, store, host } = await setup()
  await host.control.send("create a")
  const append = store.appendDurable.bind(store)
  const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
    if (entry.type === "file_restore_progress") throw new Error("interrupted")
    return append(entry)
  })
  try {
    await expect(host.control.rewind!(0)).rejects.toThrow("interrupted")
  } finally {
    crash.mockRestore()
  }
  const notices: string[] = []
  session.agent.bus.subscribe((event) => {
    if (event.type === "extension.notice") notices.push(event.data.text)
  })
  const resumed = session.resume(SessionStore.open(store.file))
  await session.agent.bus.flush()
  expect(resumed.messages).toHaveLength(0)
  expect(existsSync(join(cwd, "a"))).toBe(false)
  expect(notices.join("\n")).toContain("0 restored, 1 removed")
  expect(notices.join("\n")).toContain("Shell commands")
})

test("same-directory sub-agents capture into the parent's journal at its prompt boundary", async () => {
  const { cwd, session, store, host } = await setup([{ text: "ready" }, writing, { text: "child done" }])
  await host.control.send("delegate")
  const child = session.tree.spawn(host.agent, { prompt: "create a", systemPrompt: "child" })
  expect((await child.result()).status).toBe("done")
  const mutation = store.entries.find((e) => e.type === "file_mutation")
  expect(mutation).toMatchObject({
    sessionId: child.id,
    messageId: host.agent.entryId(host.agent.messages[0]!),
  })
  expect(existsSync(join(cwd, "a"))).toBe(true)
  await host.control.rewind!(0)
  expect(existsSync(join(cwd, "a"))).toBe(false)
})

test("a separate-directory sub-agent's changes stay outside the parent's file journal", async () => {
  const { cwd, session, store, host } = await setup([{ text: "ready" }, writing, { text: "child done" }])
  await host.control.send("delegate")
  // Agent worktrees live outside the workspace, under the Amira home.
  const other = temporary()
  const child = session.tree.spawn(host.agent, { prompt: "create a", cwd: other, systemPrompt: "child" })
  expect((await child.result()).status).toBe("done")
  expect(store.entries.some((e) => e.type === "file_mutation")).toBe(false)
  await host.control.rewind!(0)
  expect(existsSync(join(other, "a"))).toBe(true)
})

test("active sub-agents block rewind; explicit prune is available as a command", async () => {
  const { session, host } = await setup([{ text: "ready" }, { text: "child", delayMs: 80 }])
  await host.control.send("delegate")
  const child = session.tree.spawn(host.agent, { prompt: "wait", systemPrompt: "child" })
  await expect(host.control.rewind!(0)).rejects.toThrow("active sub-agents")
  await child.result()
  const result = await host.run("/rewind-prune", { frontend: "print" })
  expect(result.output.join("\n")).toContain("Pruned 0 file images")
})

test("a sub-agent in a subdirectory writes the parent's files, so it shares the parent's journal", async () => {
  const { cwd, session, store, host } = await setup([{ text: "ready" }, writing, { text: "child done" }])
  await host.control.send("delegate")
  const sub = join(cwd, "pkg")
  mkdirSync(sub)
  const child = session.tree.spawn(host.agent, { prompt: "create a", cwd: sub, systemPrompt: "child" })
  expect((await child.result()).status).toBe("done")
  expect(store.entries.some((e) => e.type === "file_mutation")).toBe(true)
  await host.control.rewind!(0)
  expect(existsSync(join(sub, "a"))).toBe(false)
})

test("a session with an unfinishable restore still opens, warns, and conversation-only rewind abandons it", async () => {
  const { cwd, session, store, host } = await setup([writing, { text: "done" }, writing, { text: "again" }])
  writeFileSync(join(cwd, "a"), "original")
  await host.control.send("change a")
  const append = store.appendDurable.bind(store)
  const crash = spyOn(store, "appendDurable").mockImplementation((entry) => {
    if (entry.type === "file_restore_progress") throw new Error("interrupted")
    return append(entry)
  })
  try {
    await expect(host.control.rewind!(0)).rejects.toThrow("interrupted")
  } finally {
    crash.mockRestore()
  }
  writeFileSync(join(cwd, "a"), "user edit after the crash")
  const notices: string[] = []
  session.agent.bus.subscribe((event) => {
    if (event.type === "extension.notice") notices.push(event.data.text)
  })
  const resumed = session.resume(SessionStore.open(store.file))
  host.switchTo(resumed)
  await session.agent.bus.flush()
  expect(notices.join(" ")).toContain("could not finish")
  expect(host.control.planRewind!(0).conflicts).toEqual([join(cwd, "a")])
  await expect(host.control.rewind!(0)).rejects.toThrow("nothing changed")
  await host.control.rewind!(0, { restoreFiles: false })
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("user edit after the crash")
  expect(host.control.messages()).toHaveLength(0)
  await host.control.send("change a again")
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("tool")
})

test("a fork keeps the captured bytes, also after the original session is deleted", async () => {
  const { cwd, store, host } = await setup()
  writeFileSync(join(cwd, "a"), "original")
  await host.control.send("change a")
  await host.control.fork!()
  expect(host.agent.session!.id).not.toBe(store.id)
  await host.control.deleteSession!(store.id)
  expect(existsSync(store.file)).toBe(false)
  await host.control.rewind!(0)
  expect(readFileSync(join(cwd, "a"), "utf8")).toBe("original")
})

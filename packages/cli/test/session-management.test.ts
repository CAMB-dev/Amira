import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import type { Settings } from "@amira/api"
import { Agent, projectKey, SessionStore, sessionLockFile, validateSettings } from "@amira/core"
import commandsExtension, { costReport } from "../../../extensions/commands/src/index.ts"
import { createCommandHost } from "../src/control.ts"
import { formatSessionList } from "../src/resume.ts"
import { createSession } from "../src/session.ts"

async function setup(
  steps: MockStep[],
  options: { autoTitle?: boolean; settings?: Settings; thinking?: boolean } = {},
) {
  const { thinking, ...rest } = options
  const mock = createMockDialect(steps)
  const models = thinking ? [{ id: "main", caps: { thinking: true } }] : undefined
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", ...(models ? { models } : {}) }],
  })
  const dir = mkdtempSync(path.join(tmpdir(), "amira-management-cli-"))
  const store = SessionStore.create({ cwd: dir, dir })
  const session = await createSession({
    model: "mock/main",
    cwd: dir,
    extensions: [],
    noBuiltins: false,
    ai,
    store,
    ...rest,
    builtins: async () => [{ source: "builtin:commands", extension: commandsExtension }],
  })
  const reasons: string[] = []
  const host = createCommandHost({ session, cwd: dir, announce: (_a, reason) => reasons.push(reason) })
  return { ai, mock, store, session, host, reasons }
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for title")
    await Bun.sleep(5)
  }
}

test("auto title is one non-blocking request on compact.model; a manual name wins the race and usage persists", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { mock, store, session, host } = await setup(
    [
      { text: "answer", usage: { cost: 0.01 } },
      {
        text: "one two three four five six seven",
        hold: { chunks: 0, until: gate },
        usage: { input: 100, output: 8, cost: 0.002 },
      },
      { text: "next answer" },
    ],
    { autoTitle: true, settings: { compact: { model: "mock/small" } } },
  )
  await session.agent.prompt(userMessage("请修复数据库连接"))
  await waitFor(() => mock.requests.length === 2)
  expect(session.agent.busy).toBe(false)
  expect(mock.requests[1]?.model.id).toBe("small")
  expect(mock.requests[1]?.messages[0]?.content).toEqual([
    { type: "text", text: "user: 请修复数据库连接\nassistant: answer" },
  ])
  expect(mock.requests[1]?.tools).toEqual([])
  expect(mock.requests[1]?.maxTokens).toBe(64)
  host.control.rename!("My session")
  release()
  await waitFor(() => store.entries.some((e) => e.type === "side_usage"))
  expect(store.title).toBe("My session")
  expect(SessionStore.open(store.file).title).toBe("My session")
  expect(host.control.sideRequests!()[0]?.usage.cost).toBe(0.002)
  expect(costReport(host.control.replies(), [], host.control.sideRequests!())).toContain("session title")
  await host.control.send("another turn")
  expect(mock.requests).toHaveLength(3)
})

test("automatic names are short and use the current model without compact.model", async () => {
  const { mock, store, host } = await setup(
    [{ text: "answer" }, { text: '"one two three four five six seven"' }],
    { autoTitle: true },
  )
  await host.control.send("question")
  await waitFor(() => !!store.title)
  expect(store.title).toBe("one two three four five six")
  expect(mock.requests[1]?.model.id).toBe("main")
  expect(mock.requests[1]?.systemPrompt).toContain("user's language")
})

test("an image-only first message names the image in the title request without sending it", async () => {
  const { mock, store, session } = await setup([{ text: "answer" }, { text: "Login screen" }], {
    autoTitle: true,
  })
  await session.agent.prompt({
    role: "user",
    content: [{ type: "image", name: "login.png", mimeType: "image/png", data: "iVBORw0KGgo=" }],
  })
  await waitFor(() => !!store.title)
  const sent = JSON.stringify(mock.requests[1]?.messages)
  expect(sent).toContain("[image: login.png]")
  expect(sent).not.toContain("iVBORw0KGgo=")
  expect(store.title).toBe("Login screen")
})

test("a reasoning model gets room to think, and a title without spaces is cut to a short one", async () => {
  const { mock, store, host } = await setup([{ text: "answer" }, { text: "数".repeat(200) }], {
    autoTitle: true,
    thinking: true,
  })
  await host.control.send("question")
  await waitFor(() => !!store.title)
  expect(mock.requests[1]?.maxTokens).toBeGreaterThan(64)
  expect(store.title).toBe("数".repeat(60))
})

for (const scenario of ["print", "disabled", "manual", "subagent", "resumed"] as const) {
  test(`auto title is skipped for ${scenario}`, async () => {
    const { mock, store, session, host, ai } = await setup([{ text: "answer" }], {
      autoTitle: scenario !== "print",
      ...(scenario === "disabled" ? { settings: { sessions: { autoTitle: false } } } : {}),
    })
    if (scenario === "manual") host.control.rename!("Manual")
    if (scenario === "resumed") {
      store.appendMessage(userMessage("old question"))
      store.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        model: { provider: "mock", model: "main" },
      })
    }
    const agent =
      scenario === "subagent"
        ? new Agent({
            ai,
            model: ai.model("mock/main"),
            cwd: store.header.cwd,
            session: store,
            parentSessionId: "parent",
            autoTitle: {},
          })
        : scenario === "resumed"
          ? session.resume(store)
          : session.agent
    await agent.prompt(userMessage("new question"))
    await Bun.sleep(20)
    expect(mock.requests).toHaveLength(1)
  })
}

test("failed auto-title requests are harmless and their reported usage is counted", async () => {
  const { store, host } = await setup(
    [{ text: "answer" }, { error: { message: "no title" }, usage: { input: 10, cost: 0.001 } }],
    { autoTitle: true },
  )
  await host.control.send("question")
  await waitFor(() => !!host.control.sideRequests!().length)
  expect(store.title).toBeUndefined()
  expect(host.control.info().busy).toBe(false)
  expect(host.control.sideRequests!()[0]?.usage.cost).toBe(0.001)
})

test("rename and fork commands update session info and preserve the source; fork-before uses message indexes", async () => {
  const { host, store, reasons } = await setup([{ text: "answer one" }, { text: "answer two" }])
  await host.control.send("first")
  await host.control.send("second")
  expect((await host.run("/rename Database fix", { frontend: "tui" })).ok).toBe(true)
  expect(host.control.info().title).toBe("Database fix")
  const status = await host.run("/status", { frontend: "tui" })
  expect(status.output.join("\n")).toContain("Database fix")
  const summary = host.control.sessions()[0]!
  expect(
    formatSessionList([
      {
        ...summary,
        file: store.file,
        cwd: store.header.cwd,
        createdAt: store.header.createdAt,
        searchText: summary.searchText!,
      },
    ]),
  ).toContain("Database fix")
  const before = readFileSync(store.file, "utf8")
  await expect(host.control.fork!(1)).rejects.toThrow("not a user message")
  await host.control.fork!(2)
  expect(host.agent.session?.header.parent).toBe(store.id)
  expect(host.control.info().title).toBe("Database fix (fork)")
  expect(host.control.messages()).toHaveLength(2)
  expect(readFileSync(store.file, "utf8")).toBe(before)
  expect(reasons).toEqual(["fork"])
  await expect(host.control.deleteSession!(host.agent.sessionId)).rejects.toThrow("current")
  await host.control.deleteSession!(store.id)
  expect(existsSync(store.file)).toBe(false)
  expect((await host.run("/fork", { frontend: "tui" })).ok).toBe(true)
})

test("clear, resume and fork hand over top-level background jobs", async () => {
  const { host, session, store } = await setup([])
  const old = session.agent
  const ended: string[] = []
  old.bus.subscribe((event) => {
    if (event.type === "session.end") ended.push(event.data.reason)
  })
  store.appendMessage(userMessage("original session"))
  const job = session.agent.backgroundJobs!.start({
    command: "long-running test job",
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    cwd: store.header.cwd,
  })
  try {
    await host.control.newSession()
    await old.bus.flush()
    expect(ended).toEqual(["switch"])
    expect(old.backgroundJobs!.get(job.id)).toBeUndefined()
    expect(host.agent.backgroundJobs!.get(job.id)).toMatchObject({ status: expect.any(String) })

    await host.control.resume(store.id)
    expect(host.agent.backgroundJobs!.get(job.id)).toMatchObject({ status: expect.any(String) })

    await host.control.fork!()
    expect(host.agent.backgroundJobs!.get(job.id)).toMatchObject({ status: expect.any(String) })
  } finally {
    await session.host.backgroundJobs.stop(job.id, 0)
  }
})

test("resuming a session another process holds leaves the current session and its jobs intact", async () => {
  const { host, session, store } = await setup([])
  const busy = SessionStore.create({ cwd: store.header.cwd, dir: path.dirname(store.file) })
  busy.appendMessage(userMessage("held elsewhere"))
  writeFileSync(
    sessionLockFile(busy.file),
    `${process.ppid}
`,
  )
  const current = host.agent
  const job = current.backgroundJobs!.start({
    command: "long-running test job",
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    cwd: store.header.cwd,
  })
  try {
    await expect(host.control.resume(busy.id)).rejects.toThrow()
    expect(host.agent).toBe(current)
    expect(current.backgroundJobs!.get(job.id)).toMatchObject({ status: expect.any(String) })
  } finally {
    rmSync(sessionLockFile(busy.file), { force: true })
    await session.host.backgroundJobs.stop(job.id, 0)
  }
})

test("switch disposes the old agent tree before the replacement is active", async () => {
  const { host, session, store } = await setup([{ text: "child answer" }])
  const old = session.agent
  const child = old.tree!.spawn(old, { prompt: "stay alive", persistent: true })
  await waitFor(() => session.tree.children.length === 1)

  await host.control.newSession()

  expect((await child.result()).status).toBe("aborted")
  expect(session.tree.children).toHaveLength(0)
  expect(existsSync(sessionLockFile(store.file))).toBe(false)
  await session.agent.dispose("exit")
})

test("/rename without an argument clears the manual name and restores the automatic title", async () => {
  const { host, store } = await setup([{ text: "answer" }])
  await host.control.send("question")
  store.rename("Automatic", "auto")
  host.control.rename!("Manual")
  expect(host.control.info().title).toBe("Manual")

  const result = await host.run("/rename", { frontend: "tui" })
  expect(result.output).toEqual(["Cleared the manual session name."])
  expect(host.control.info().title).toBe("Automatic")
  expect(SessionStore.open(store.file).title).toBe("Automatic")
})

test("sessions.autoTitle is accepted at project scope and rejects non-booleans", () => {
  expect(validateSettings({ sessions: { autoTitle: false } }, "project").settings.sessions).toEqual({
    autoTitle: false,
  })
  expect(() => validateSettings({ sessions: { autoTitle: "false" } }, "project")).toThrow()
})

test("amira sessions rm deletes stored sessions without loading models or keys", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-sessions-rm-"))
  const cwd = path.join(home, "project")
  const store = SessionStore.create({ cwd, dir: path.join(home, "sessions", projectKey(cwd)) })
  store.appendMessage(userMessage("delete me"))
  const child = Bun.spawn(
    ["bun", path.join(import.meta.dir, "../src/main.ts"), "sessions", "rm", store.id, "-C", cwd],
    {
      env: { ...process.env, AMIRA_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code).toBe(0)
  expect(error).toBe("")
  expect(output).toContain(`Deleted session ${store.id}`)
  expect(existsSync(store.file)).toBe(false)
})

test("switching sessions gives up the lease on the one left behind", async () => {
  const { store, host } = await setup([])
  store.appendMessage(userMessage("first"))
  expect(existsSync(sessionLockFile(store.file))).toBe(true)
  await host.control.newSession()
  expect(existsSync(sessionLockFile(store.file))).toBe(false)
})

test("amira sessions rm refuses a session leased by another process", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-sessions-rm-live-"))
  const cwd = path.join(home, "project")
  const store = SessionStore.create({ cwd, dir: path.join(home, "sessions", projectKey(cwd)) })
  store.appendMessage(userMessage("keep me"))
  const lock = sessionLockFile(store.file)
  writeFileSync(lock, `${process.pid}\n`)
  try {
    const child = Bun.spawn(
      ["bun", path.join(import.meta.dir, "../src/main.ts"), "sessions", "rm", store.id, "-C", cwd],
      {
        env: { ...process.env, AMIRA_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).not.toBe(0)
    expect(output).toBe("")
    expect(error).toContain("open in another Amira process")
    expect(existsSync(store.file)).toBe(true)
  } finally {
    rmSync(lock, { force: true })
  }
})

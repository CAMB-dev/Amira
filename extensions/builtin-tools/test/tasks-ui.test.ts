import { expect, test } from "bun:test"
import {
  type CommandContext,
  type Message,
  type SessionControl,
  type SubagentInfo,
  subagentTranscriptText,
} from "@amira/api"
import { JobRegistry } from "../../../packages/proc/src/index.ts"
import { setup, waitFor } from "../../../packages/tui/test/app-harness.ts"
import { subagentView } from "../../agent/src/subagent-view.ts"
import { registerJobs } from "../src/jobs-ui.ts"
import { tasksCommand, tasksPanel } from "../src/tasks-ui.ts"

function agent(id: string, status: SubagentInfo["status"] = "running"): SubagentInfo {
  return {
    id,
    status,
    parentSessionId: "root",
    depth: 1,
    role: "coder",
    title: "Build the feature",
    task: "Implement it",
    startedAt: Date.now() - 2000,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

function fixture() {
  const registry = new JobRegistry({
    start(_spec, emit) {
      emit({ type: "spawned", pid: 7, contained: true })
      emit({ type: "output", data: "first\nready\n" })
      return { stop: () => emit({ type: "exit", code: null, signal: null }) }
    },
  })
  const job = registry.start({ command: "npm run dev", argv: [], cwd: "/work" })
  const monitor = registry.start({
    command: "tail -f build.log",
    kind: "monitor",
    meta: { description: "Watch build" },
    argv: [],
    cwd: "/work",
  })
  let agents = [agent("child"), agent("finished", "done"), agent("idle", "idle"), agent("paused", "paused")]
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Implement it" }] },
    {
      role: "assistant",
      model: { provider: "mock", model: "m1" },
      content: [{ type: "text", text: "Working\nTests pass" }],
    },
  ]
  const stopped: string[] = []
  const session = {
    subagents: () => agents,
    subagentMessages: () => messages,
    stopSubagent(id: string) {
      stopped.push(id)
      agents = agents.filter((s) => s.id !== id)
      return true
    },
  } as unknown as SessionControl
  const output: string[] = []
  const opened: unknown[] = []
  const ctx = {
    session,
    frontend: "print",
    signal: new AbortController().signal,
    print: (text: string) => output.push(text),
  } as unknown as CommandContext
  return { registry, job, monitor, session, messages, stopped, output, opened, ctx }
}

test("tasks panel combines jobs, monitors and active agents, folds and clips rows", () => {
  const { registry, session } = fixture()
  const panel = tasksPanel(registry, () => session)
  const options = { width: 100, now: Date.now(), sessionId: "root", collapsed: false }
  const rows = panel.render(options).map((l) => l.text)
  expect(rows).toHaveLength(6)
  expect(rows[0]).toBe("5 background tasks | 3 running | 1 idle | 1 paused | /tasks to see or stop")
  expect(rows[1]).toMatch(/^job job1 0s \| npm run dev \| ready$/)
  expect(rows[2]).toMatch(/^monitor job2 0s \| Watch build \| ready$/)
  expect(rows[3]).toMatch(/^agent child running 2s \| Build the feature \| Tests pass$/)
  expect(panel.render({ ...options, collapsed: true })).toHaveLength(1)
  for (const row of panel.render({ ...options, width: 32 }).slice(1))
    expect(row.text.length).toBeLessThanOrEqual(32)
})

test("/tasks lists, opens existing views, and prints output when a view is unavailable", async () => {
  const f = fixture()
  const command = tasksCommand(f.registry)
  await command.run("list", f.ctx)
  expect(f.output[0]).toContain("monitor job2")
  expect(f.output[0]).not.toContain("finished")
  const ctx = {
    ...f.ctx,
    openView: (view: unknown) => {
      f.opened.push(view)
      return true
    },
  }
  await command.run("view job2", ctx)
  await command.run("child", ctx)
  expect(f.opened).toEqual([
    { kind: "background-job", data: { id: "job2" } },
    { kind: "subagent", data: { sessionId: "child" } },
  ])
  await command.run("view job1", { ...ctx, openView: () => false })
  expect(f.output.at(-1)).toContain("first\nready")
  await command.run("view child", f.ctx)
  expect(f.output.at(-1)).toContain("  Working\n  Tests pass")
})

test("/tasks uses the public subagentTranscriptText renderer when no view opens", async () => {
  const f = fixture()
  const agents = f.session.subagents()
  const child = agents[0]!
  child.durationMs = 2000
  const expected = subagentTranscriptText(child, f.messages, agents)
  for (const openView of [undefined, () => false]) {
    await tasksCommand(f.registry).run("view child", { ...f.ctx, openView })
    expect(f.output.at(-1)).toBe(expected)
  }
})

test("/tasks fallback keeps tool-only transcripts, results and fork boundaries", async () => {
  const f = fixture()
  f.messages.splice(
    0,
    f.messages.length,
    { role: "user", content: [{ type: "text", text: "Parent history" }] },
    {
      role: "assistant",
      model: { provider: "mock", model: "m1" },
      content: [{ type: "toolCall", id: "old", name: "parent_tool", args: {} }],
    },
    { role: "user", content: [{ type: "text", text: "Implement it" }] },
    {
      role: "assistant",
      model: { provider: "mock", model: "m1" },
      content: [
        { type: "toolCall", id: "read", name: "read", args: { path: "feature.ts" } },
        {
          type: "serverTool",
          id: "search",
          name: "web_search",
          input: { query: "API docs" },
          status: "done",
        },
        { type: "toolCall", id: "pending", name: "bash", args: { command: "bun test" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "File missing" }],
    },
  )
  for (const openView of [undefined, () => false]) {
    await tasksCommand(f.registry).run("view child", { ...f.ctx, openView })
    const output = f.output.at(-1)!
    expect(output).toContain("read feature.ts  ✗ File missing")
    expect(output).toContain("web_search API docs  ✓ done")
    expect(output).toContain("⠋ bash bun test")
    expect(output).toContain("Implement it")
    expect(output).not.toContain("parent_tool")
    expect(output).not.toContain("assistant:")
  }
})

test("/tasks shows idle and paused states without counting them as running, and targets both", async () => {
  const f = fixture()
  const command = tasksCommand(f.registry)
  const rows = tasksPanel(f.registry, () => f.session)
    .render({
      width: 160,
      now: Date.now(),
      sessionId: "root",
      collapsed: false,
    })
    .map((row) => row.text)
  expect(rows[0]).toBe("5 background tasks | 3 running | 1 idle | 1 paused | /tasks to see or stop")
  expect(rows.join("\n")).toContain("agent idle idle 2s")
  expect(rows.join("\n")).toContain("agent paused paused 2s")
  expect(command.args!.complete!("view ", f.ctx)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "view idle" }),
      expect.objectContaining({ value: "view paused" }),
    ]),
  )
  expect(command.args!.complete!("stop ", f.ctx)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "stop idle" }),
      expect.objectContaining({ value: "stop paused" }),
    ]),
  )
  await command.run("view idle", f.ctx)
  expect(f.output.at(-1)).toContain("idle Build the feature")
  await command.run("view paused", f.ctx)
  expect(f.output.at(-1)).toContain("paused Build the feature")
  await command.run("stop paused", f.ctx)
  expect(f.stopped).toEqual(["paused"])
  await command.run("stop all", f.ctx)
  expect(f.stopped).toEqual(["paused", "child", "idle"])
  expect(f.output.at(-1)).toBe("Stopped 4 background tasks.")
})

test("/tasks stop all includes every nonterminal agent but not completed outcomes", async () => {
  const f = fixture()
  const states = ["running", "queued", "idle", "paused", "done", "error", "aborted"] as const
  f.session.subagents = () =>
    states.filter((state) => !f.stopped.includes(state)).map((state) => agent(state, state))
  await tasksCommand(f.registry).run("stop all", f.ctx)
  expect(f.stopped).toEqual(["running", "queued", "idle", "paused"])
  expect(f.output.at(-1)).toBe("Stopped 6 background tasks.")
  expect(
    tasksPanel(f.registry, () => f.session).render({
      width: 100,
      now: Date.now(),
      sessionId: "root",
      collapsed: false,
    }),
  ).toEqual([])
})

test("/tasks keeps idle and paused agents visible with no running work", async () => {
  const f = fixture()
  await tasksCommand(f.registry).run("stop job1", f.ctx)
  await tasksCommand(f.registry).run("stop job2", f.ctx)
  await tasksCommand(f.registry).run("stop child", f.ctx)
  const rows = tasksPanel(f.registry, () => f.session)
    .render({
      width: 160,
      now: Date.now(),
      sessionId: "root",
      collapsed: false,
    })
    .map((row) => row.text)
  expect(rows[0]).toBe("2 background tasks | 1 idle | 1 paused | /tasks to see or stop")
  expect(rows.join("\n")).not.toContain("running")
  await tasksCommand(f.registry).run("stop idle", f.ctx)
  expect(f.output.at(-1)).toBe("Stopped idle.")
  await tasksCommand(f.registry).run("stop paused", f.ctx)
  expect(f.output.at(-1)).toBe("Stopped paused.")
})

test("/tasks stops each kind, stops all, handles missing refs and hides at zero", async () => {
  const f = fixture()
  const command = tasksCommand(f.registry)
  await expect(command.run("stop", f.ctx)).rejects.toThrow("/tasks stop <id|all>")
  await expect(command.run("view", f.ctx)).rejects.toThrow("/tasks view <id>")
  await expect(command.run("stop unknown", f.ctx)).rejects.toThrow("no live task")
  expect(command.args!.complete!("stop ", f.ctx)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "stop job1" }),
      expect.objectContaining({ value: "stop job2" }),
      expect.objectContaining({ value: "stop child" }),
      expect.objectContaining({ value: "stop all" }),
    ]),
  )
  await command.run("stop job2", f.ctx)
  expect(f.registry.get("job2")?.status).toBe("stopped")
  await command.run("stop all", f.ctx)
  expect(f.registry.running()).toEqual([])
  expect(f.stopped).toEqual(["child", "idle", "paused"])
  expect(f.output.at(-1)).toBe("Stopped 4 background tasks.")
  expect(
    tasksPanel(f.registry, () => f.session).render({
      width: 80,
      now: Date.now(),
      sessionId: "root",
      collapsed: false,
    }),
  ).toEqual([])
  await command.run("", f.ctx)
  expect(f.output.at(-1)).toContain("No live background tasks.")
})

for (const mode of ["inline", "fullscreen"] as const) {
  test(`unified tasks panel, folding, job/agent views and stop-all (${mode})`, async () => {
    const f = fixture()
    const app = await setup([], {
      cols: 110,
      rows: 35,
      settings: { mode },
      control: f.session,
      extensions: [
        (api) => {
          registerJobs(api, f.registry)
          api.registerView(subagentView(api))
        },
      ],
    })
    try {
      app.host.setSessionControl(f.session, () => app.agent)
      app.bus.emit("ui.render", {}, { sessionId: app.agent.sessionId })
      await waitFor(() => app.live().includes("5 background tasks | 3 running"), "combined panel")
      expect(app.live()).toContain("monitor job2")
      expect(app.live()).toContain("agent child running")
      expect(app.live()).toContain("agent idle idle")
      expect(app.live()).toContain("agent paused paused")
      app.bus.emit(
        "message.delta",
        { kind: "text", text: "Streaming progress" },
        { sessionId: "child", parentSessionId: app.agent.sessionId },
      )
      await waitFor(() => app.live().includes("Streaming progress"), "streaming agent preview")
      app.terminal.send("\x14")
      await waitFor(() => !app.live().includes("monitor job2"), "folded panel")
      expect(app.live()).toContain("5 background tasks | 3 running")
      app.terminal.send("/tasks\r")
      await waitFor(
        () => app.live().includes("Background tasks") && app.live().includes("monitor job2"),
        "combined picker",
      )
      app.terminal.send("\x1b[B\r")
      await waitFor(() => app.live().includes("job2 · tail -f build.log"), "job view")
      expect(app.live()).toContain("ready")
      app.terminal.send("q")
      await waitFor(() => !app.live().includes("job2 · tail -f build.log"), "closed job view")
      app.terminal.send("/tasks view child\r")
      await waitFor(
        () => app.live().includes("Implement it") && app.live().includes("Tests pass"),
        "agent transcript view",
      )
      app.terminal.send("q")
      await waitFor(() => !app.live().includes("Implement it"), "closed agent view")
      app.terminal.send("/tasks view paused\r")
      await waitFor(
        () => app.live().includes("Implement it") && app.live().includes("paused"),
        "paused agent transcript view",
      )
      app.terminal.send("q")
      await waitFor(() => !app.live().includes("Implement it"), "closed paused agent view")
      app.terminal.send("/tasks stop all\r")
      await app.shows("Stopped 5 background tasks.")
      await waitFor(() => !app.live().includes("5 background tasks | 3 running"), "hidden tasks panel")
      expect(f.registry.running()).toHaveLength(0)
      expect(f.stopped).toEqual(["child", "idle", "paused"])
    } finally {
      app.terminal.send("\x03")
      await app.exited
    }
  })
}

test.each([false, true])(
  "automatic monitor notices and follow-ups do not replace the child's task boundary (%s)",
  async (followUp) => {
    const f = fixture()
    f.messages.push(
      {
        role: "assistant",
        model: { provider: "mock", model: "m1" },
        content: [
          { type: "toolCall", id: "monitor-start", name: "monitor", args: { command: "watch build" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "monitor-start",
        toolName: "monitor",
        content: [{ type: "text", text: "Started monitor job3" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Monitor job3 output: build ready" }],
        display: { text: "Monitor job3 output", origin: "job" },
      },
    )
    if (followUp) f.messages.push({ role: "user", content: [{ type: "text", text: "Continue with tests" }] })
    await tasksCommand(f.registry).run("view child", f.ctx)
    const text = f.output.at(-1)!
    expect(text).toContain("Implement it")
    expect(text).toContain("monitor watch build")
    expect(text).toContain("Started monitor job3")
  },
)

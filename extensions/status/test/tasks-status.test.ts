import { expect, spyOn, test } from "bun:test"
import { hostBackgroundJobs, type SessionControl, type SubagentInfo } from "@amira/api"
import {
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "../../../packages/core/src/index.ts"
import { JobRegistry } from "../../../packages/proc/src/index.ts"
import statusExtension from "../src/index.ts"

function child(id: string, status: SubagentInfo["status"]): SubagentInfo {
  return {
    id,
    status,
    parentSessionId: "root",
    depth: 1,
    title: "Task",
    task: "Do it",
    role: "coder",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

test("running task counts are live, ASCII-safe, semantic, overridable and hidden at zero", async () => {
  const registry = new JobRegistry({
    start(_spec, emit) {
      emit({ type: "spawned", pid: 7, contained: true })
      return { stop: () => emit({ type: "exit", code: null, signal: null }) }
    },
  })
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  let agents = [child("done", "done"), child("idle", "idle")]
  host.setSessionControl({ subagents: () => agents } as unknown as SessionControl, () => {
    throw new Error("Status counts do not need an agent")
  })
  const jobs = hostBackgroundJobs()
  const running = spyOn(jobs, "running").mockImplementation(() => registry.running())
  let unsubscribed = false
  const subscribe = spyOn(jobs, "subscribe").mockImplementation((listener) => {
    const off = registry.subscribe(listener)
    return () => {
      unsubscribed = true
      off()
    }
  })
  const item = () => host.status.snapshot().find((i) => i.id === "tasks")
  const rendered = () =>
    new Promise<void>((resolve) => {
      const off = bus.subscribe(
        () => {
          off()
          resolve()
        },
        { types: ["ui.render"] },
      )
    })
  try {
    expect(await host.load(statusExtension, "builtin:status")).toBe(true)
    expect(item()?.text).toBe("1 idle agent")
    agents = [...agents, child("paused", "paused")]
    expect(item()?.text).toBe("1 idle agent | 1 paused agent")
    expect(item()?.text).toMatch(/^[\x20-\x7e]+$/)
    const jobsRendered = rendered()
    registry.start({ command: "ordinary", argv: [], cwd: "/work" })
    registry.start({ command: "explicit", kind: "job", argv: [], cwd: "/work" })
    registry.start({ command: "watch", kind: "monitor", argv: [], cwd: "/work" })
    await jobsRendered
    await bus.flush()
    expect(item()).toMatchObject({
      text: "* 2 jobs | 1 idle agent | 1 paused agent | 1 monitor",
      tone: "accent",
      priority: 5,
    })
    agents = [...agents, child("running", "running"), child("queued", "queued")]
    const agentsRendered = rendered()
    bus.emit(
      "subagent.state",
      { childSessionId: "running", state: "working", turns: 1 },
      { sessionId: "root" },
    )
    await agentsRendered
    await bus.flush()
    expect(item()?.text).toBe(
      "* 2 jobs | 1 agent | 1 queued agent | 1 idle agent | 1 paused agent | 1 monitor",
    )
    expect(item()?.text).toMatch(/^[\x20-\x7e]+$/)
    await host.load((api) => {
      api.registerStatusItem({ id: "tasks", override: true, tone: "warning", text: () => "custom tasks" })
    }, "user")
    expect(item()).toMatchObject({ text: "custom tasks", tone: "warning" })
    host.unload("user")
    expect(item()?.text).toBe(
      "* 2 jobs | 1 agent | 1 queued agent | 1 idle agent | 1 paused agent | 1 monitor",
    )
    await registry.stopAll()
    agents = [child("paused", "paused")]
    const pausedRendered = rendered()
    bus.emit("subagent.state", { childSessionId: "paused", state: "paused", turns: 1 }, { sessionId: "root" })
    await pausedRendered
    await bus.flush()
    expect(item()?.text).toBe("1 paused agent")
    agents = [child("queued", "queued")]
    expect(item()?.text).toBe("1 queued agent")
    agents = []
    expect(item()).toBeUndefined()
    host.unload("builtin:status")
    expect(unsubscribed).toBe(true)
  } finally {
    host.unload("builtin:status")
    running.mockRestore()
    subscribe.mockRestore()
  }
})

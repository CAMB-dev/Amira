import { expect, test } from "bun:test"
import type { ShellKind, ShellMode } from "@amira/api"
import { createAi, createMockDialect } from "../../../packages/ai/src/index.ts"
import type { Approver } from "../../../packages/core/src/agent.ts"
import { Agent, SessionBackgroundJobHost } from "../../../packages/core/src/index.ts"
import { Permissions } from "../../../packages/core/src/permissions/policy.ts"
import { JobRegistry } from "../../../packages/proc/src/index.ts"
import { createMonitorTool } from "../src/monitor.ts"
import type { Shell } from "../src/shell.ts"

function shell(kind: ShellKind): Shell {
  return {
    kind,
    path: `fake-${kind}`,
    command: (command, cwd) => ({ argv: [command], cwd, env: {}, gated: false }),
  }
}

function setup(
  resolve: () => Promise<Shell>,
  permissions?: Permissions,
  options: { approve?: Approver; mode?: () => ShellMode | undefined } = {},
) {
  const registry = new JobRegistry({
    start(_spec, emit) {
      emit({ type: "spawned", pid: 1, contained: true })
      return { stop: () => emit({ type: "exit", code: null, signal: null }) }
    },
  })
  const host = new SessionBackgroundJobHost(registry)
  const mock = createMockDialect([
    { toolCalls: [{ name: "monitor", args: { command: "rm victim", description: "Watch" } }] },
    { text: "done" },
  ])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "",
    backgroundJobs: host,
    permissions,
    approve: options.approve,
  })
  agent.tools.register(createMonitorTool(resolve, {}, options.mode), "test")
  return { agent, host }
}

for (const authorized of ["bash", "powershell"] as const) {
  test(`the real monitor rejects a ${authorized} entry-shell change during approval before starting a job`, async () => {
    let mode: ShellMode = authorized
    let approvals = 0
    let resolutions = 0
    const changed = authorized === "bash" ? "powershell" : "bash"
    const s = setup(
      async () => {
        resolutions++
        return shell(authorized)
      },
      new Permissions({ mode: "edits", rules: [] }),
      {
        mode: () => mode,
        approve: async () => {
          approvals++
          mode = changed
          s.agent.tools.setPolicy({ shell: changed })
          return { approved: true, by: "user" }
        },
      },
    )
    s.agent.tools.setPolicy({ shell: authorized })
    try {
      await s.agent.prompt("watch")
      expect(approvals).toBe(1)
      expect(s.host.list()).toEqual([])
      expect(resolutions).toBe(1)
      expect(s.agent.messages.find((m) => m.role === "toolResult")).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining("shell changed after authorization; retry the command."),
          },
        ],
      })
    } finally {
      await s.agent.dispose()
    }
  })
}

for (const kind of ["bash", "powershell"] as const) {
  for (const action of ["block", "ask"] as const) {
    test(`the real monitor cannot bypass a ${kind}-named ${action} guard`, async () => {
      const s = setup(async () => shell(kind))
      s.agent.interceptors.add("tool.call.before", (call) =>
        call.name === kind ? { action, reason: "existing shell guard" } : { action: "pass" },
      )
      try {
        await s.agent.prompt("watch")
        expect(s.host.list()).toEqual([])
        expect(s.agent.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true })
      } finally {
        await s.agent.dispose()
      }
    })
  }
}

test("a failed real monitor classification cannot recover into an unchecked PowerShell rm alias", async () => {
  let resolutions = 0
  const s = setup(
    async () => {
      if (++resolutions === 1) throw new Error("classification unavailable")
      return shell("powershell")
    },
    new Permissions({
      rules: [{ command: ["Remove-Item"], decision: "deny", source: { scope: "user", file: "test.json" } }],
    }),
  )
  try {
    await s.agent.prompt("watch")
    expect(resolutions).toBe(1)
    expect(s.host.list()).toEqual([])
    expect(s.agent.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true })
  } finally {
    await s.agent.dispose()
  }
})

test("shell guard command rewrites flow into the real monitor without corrupting its own parameters", async () => {
  const s = setup(async () => shell("bash"))
  s.agent.interceptors.add("tool.call.before", (call) => {
    if (call.name !== "bash") return { action: "pass" }
    expect(call.args).toEqual({ command: "rm victim", background: true })
    return { action: "modify", value: { ...call, args: { ...call.args, command: "echo approved" } } }
  })
  try {
    await s.agent.prompt("watch")
    expect(s.host.list()[0]).toMatchObject({
      command: "echo approved",
      kind: "monitor",
      meta: { description: "Watch" },
    })
  } finally {
    await s.agent.dispose()
  }
})

test("the bash entry point's guards still apply when its shell falls back to PowerShell", async () => {
  const s = setup(async () => shell("powershell"))
  s.agent.interceptors.add("tool.call.before", (call) =>
    call.name === "bash" ? { action: "block", reason: "bash entry point denied" } : { action: "pass" },
  )
  try {
    await s.agent.prompt("watch")
    expect(s.host.list()).toEqual([])
  } finally {
    await s.agent.dispose()
  }
})

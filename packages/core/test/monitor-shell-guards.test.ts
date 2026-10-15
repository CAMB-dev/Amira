import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { type ShellKind, type ToolContext, type ToolDefinition, textResult } from "@amira/api"
import { Agent, type Approver } from "../src/agent.ts"
import { Permissions } from "../src/permissions/policy.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function setup(
  kind?: ShellKind | "unavailable" | (() => ShellKind),
  traits?: ToolDefinition["traits"],
  approve?: Approver,
) {
  let executions = 0
  const contexts: ToolContext[] = []
  let resolutions = 0
  const mock = createMockDialect([
    { toolCalls: [{ name: "monitor", args: { command: "rm target" }, id: "monitor-call" }] },
    { text: "done" },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  tools.register(
    {
      name: "monitor",
      description: "",
      parameters: { type: "object" },
      traits,
      ...(kind
        ? {
            shellKind: () => {
              resolutions++
              if (kind === "unavailable") throw new Error("shell unavailable")
              return typeof kind === "function" ? kind() : kind
            },
          }
        : {}),
      execute: async (_params, ctx) => {
        contexts.push(ctx)
        executions++
        return textResult("started")
      },
    },
    "test",
  )
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    systemPrompt: "sys",
    tools,
    approve,
  })
  return { agent, contexts, executions: () => executions, resolutions: () => resolutions }
}

for (const kind of ["bash", "powershell"] as const) {
  for (const action of ["block", "ask"] as const) {
    test(`monitor inherits the ${kind} before interceptor's ${action}`, async () => {
      const s = setup(kind)
      const seen: string[] = []
      s.agent.interceptors.add("tool.call.before", (call) => {
        seen.push(call.name)
        return call.name === kind ? { action, reason: "shell guard" } : { action: "pass" }
      })
      try {
        await s.agent.prompt("run")
        expect(s.executions()).toBe(0)
        expect(seen).toContain("monitor")
        expect(seen).toContain(kind)
        expect(seen).not.toContain(kind === "bash" ? "powershell" : "bash")
        expect(s.resolutions()).toBe(1)
      } finally {
        await s.agent.dispose()
      }
    })
  }

  test(`monitor cannot bypass disabled ${kind}`, async () => {
    const s = setup(kind)
    s.agent.tools.setDisabled([kind])
    try {
      await s.agent.prompt("run")
      expect(s.executions()).toBe(0)
    } finally {
      await s.agent.dispose()
    }
  })
}

for (const kind of [undefined, "unavailable"] as const) {
  test(`monitor checks both shell guards when classification is ${kind ?? "omitted"}`, async () => {
    const s = setup(kind, { shell: "bash", readOnly: true })
    const seen: string[] = []
    s.agent.interceptors.add("tool.call.before", (call) => {
      seen.push(call.name)
      return call.name === "powershell" ? { action: "block", reason: "PowerShell guard" } : { action: "pass" }
    })
    try {
      await s.agent.prompt("run")
      expect(s.executions()).toBe(0)
      expect(seen).toContain("bash")
      expect(seen).toContain("powershell")
      expect(s.resolutions()).toBe(kind ? 1 : 0)
    } finally {
      await s.agent.dispose()
    }
  })
}

for (const traits of [undefined, { readOnly: true }, { shell: "bash" as const, readOnly: true }]) {
  test(`monitor name keeps shell permissions with traits ${JSON.stringify(traits)}`, async () => {
    const permissions = new Permissions({ mode: "plan", rules: [] })
    expect(
      await permissions.check({ name: "monitor", traits }, { command: "echo hi" }, process.cwd()),
    ).toMatchObject({ decision: "deny", cause: "mode" })
  })
}

test("unavailable monitor classification uses both permission parsers, not its static bash trait", async () => {
  const verdict = await new Permissions({
    rules: [{ command: ["Remove-Item"], decision: "deny", source: { scope: "user", file: "settings.json" } }],
  }).check(
    {
      name: "monitor",
      traits: { shell: "bash" },
      shellKind: () => {
        throw new Error("unavailable")
      },
    },
    { command: "rm target" },
    process.cwd(),
  )
  expect(verdict.decision).toBe("deny")
})

for (const action of ["block", "ask"] as const) {
  test(`monitor retains its own ${action} guard`, async () => {
    const s = setup("bash")
    s.agent.interceptors.add("tool.call.before", (call) =>
      call.name === "monitor" ? { action, reason: "monitor guard" } : { action: "pass" },
    )
    try {
      await s.agent.prompt("run")
      expect(s.executions()).toBe(0)
    } finally {
      await s.agent.dispose()
    }
  })
}

test("classification is captured before a monitor interceptor changes shell selection", async () => {
  let selected: ShellKind = "bash"
  const s = setup(() => selected)
  const seen: string[] = []
  s.agent.interceptors.add("tool.call.before", (call) => {
    seen.push(call.name)
    selected = "powershell"
    return call.name === "bash" ? { action: "block", reason: "authorized shell guard" } : { action: "pass" }
  })
  try {
    await s.agent.prompt("run")
    expect(s.executions()).toBe(0)
    expect(s.resolutions()).toBe(1)
    expect(seen).toEqual(["monitor", "bash"])
  } finally {
    await s.agent.dispose()
  }
})

for (const kind of ["bash", "powershell"] as const) {
  test(`monitor rechecks disabled ${kind} after interceptors`, async () => {
    const s = setup(kind)
    s.agent.interceptors.add("tool.call.before", () => {
      s.agent.tools.setDisabled([kind])
      return { action: "pass" }
    })
    try {
      await s.agent.prompt("run")
      expect(s.executions()).toBe(0)
    } finally {
      await s.agent.dispose()
    }
  })

  test(`unclassified monitor cannot bypass disabled ${kind}`, async () => {
    const s = setup("unavailable")
    s.agent.tools.setDisabled([kind])
    try {
      await s.agent.prompt("run")
      expect(s.executions()).toBe(0)
    } finally {
      await s.agent.dispose()
    }
  })
}

for (const kind of ["bash", "powershell"] as const) {
  test(`approved ${kind} shell asks keep monitor identity and the captured dialect`, async () => {
    let selected: ShellKind = kind
    const reasons: string[] = []
    const s = setup(
      () => selected,
      undefined,
      async (request) => {
        expect(request.name).toBe("monitor")
        reasons.push(request.reason)
        selected = kind === "bash" ? "powershell" : "bash"
        return { approved: true, by: "user" }
      },
    )
    s.agent.interceptors.add("tool.call.before", (call) =>
      call.name === kind || call.name === "monitor"
        ? { action: "ask", reason: `${call.name} guard` }
        : { action: "pass" },
    )
    try {
      await s.agent.prompt("run")
      expect(s.executions()).toBe(1)
      expect(s.resolutions()).toBe(1)
      expect(s.contexts[0]?.shellKind).toBe(kind)
      expect(reasons).toEqual([`monitor guard; ${kind} guard`])
    } finally {
      await s.agent.dispose()
    }
  })
}

test("monitor shell guards see the same background:true argument as a bash background call", async () => {
  const s = setup("bash")
  s.agent.interceptors.add("tool.call.before", (call) =>
    call.name === "bash" && call.args.background === true
      ? { action: "block", reason: "background commands forbidden" }
      : { action: "pass" },
  )
  try {
    await s.agent.prompt("run")
    expect(s.executions()).toBe(0)
  } finally {
    await s.agent.dispose()
  }
})

test("monitor cannot ignore a shell guard that changes a background call to foreground", async () => {
  const s = setup("bash")
  s.agent.interceptors.add("tool.call.before", (call) =>
    call.name === "bash"
      ? { action: "modify", value: { ...call, args: { ...call.args, background: false } } }
      : { action: "pass" },
  )
  try {
    await s.agent.prompt("run")
    expect(s.executions()).toBe(0)
  } finally {
    await s.agent.dispose()
  }
})

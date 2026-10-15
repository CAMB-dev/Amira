import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { type ShellKind, type ToolContext, type ToolDefinition, textResult } from "@amira/api"
import { Agent, type Approver } from "../src/agent.ts"
import { Permissions } from "../src/permissions/policy.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function setup(tool: ToolDefinition, permissions: Permissions, approve?: Approver) {
  const mock = createMockDialect([
    { toolCalls: [{ name: tool.name, args: { command: "rm target" }, id: "shell-call" }] },
    { text: "done" },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  tools.register(tool, "test")
  return new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    systemPrompt: "sys",
    tools,
    permissions,
    approve,
  })
}

for (const authorized of ["bash", "powershell"] as const) {
  test(`the executor keeps the authorized ${authorized} shell when selection changes during approval`, async () => {
    let selected: ShellKind = authorized
    let resolutions = 0
    let approvals = 0
    const contexts: ToolContext[] = []
    const tool: ToolDefinition = Object.freeze({
      name: "dynamic_shell",
      description: "",
      parameters: { type: "object" },
      shellKind: async (): Promise<ShellKind> => {
        resolutions++
        return selected
      },
      execute: async (_params: unknown, ctx: ToolContext) => {
        contexts.push(ctx)
        return textResult("done")
      },
    })
    const originalResolver = tool.shellKind
    const agent = setup(tool, new Permissions({ mode: "edits", rules: [] }), async () => {
      approvals++
      selected = authorized === "bash" ? "powershell" : "bash"
      return { approved: true, by: "user" }
    })
    try {
      await agent.prompt("run")
      expect(approvals).toBe(1)
      expect(resolutions).toBe(1)
      expect(contexts).toHaveLength(1)
      expect(contexts[0]?.shellKind).toBe(authorized)
      expect(tool.shellKind).toBe(originalResolver)
      expect(await tool.shellKind!()).toBe(selected)
    } finally {
      await agent.dispose()
    }
  })
}

for (const authorized of ["bash", "powershell"] as const) {
  test(`current host policy checks captured ${authorized} capabilities rather than a live trait getter`, async () => {
    let selected: ShellKind = authorized
    let resolutions = 0
    let approvals = 0
    let executions = 0
    const changed = authorized === "bash" ? "powershell" : "bash"
    const tool: ToolDefinition = Object.freeze({
      name: "dynamic_shell",
      description: "",
      parameters: { type: "object" },
      get traits() {
        return { shell: selected }
      },
      shellKind: () => {
        resolutions++
        return authorized
      },
      execute: async () => {
        executions++
        return textResult("done")
      },
    })
    const agent = setup(tool, new Permissions({ mode: "edits", rules: [] }), async () => {
      approvals++
      selected = changed
      agent.tools.setPolicy({ shell: changed })
      return { approved: true, by: "user" }
    })
    agent.tools.setPolicy({ shell: authorized })
    try {
      await agent.prompt("run")
      expect(approvals).toBe(1)
      expect(resolutions).toBe(1)
      expect(executions).toBe(0)
      expect(agent.messages.find((message) => message.role === "toolResult")).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("disabled by host policy") }],
      })
    } finally {
      await agent.dispose()
    }
  })
}

for (const asynchronous of [false, true]) {
  test(`a ${asynchronous ? "rejected" : "throwing"} shell resolver retains both-shell checks without retrying`, async () => {
    let resolutions = 0
    let executed = false
    const resolve = (): ShellKind => {
      resolutions++
      if (resolutions === 1) throw new Error("shell unavailable")
      return "bash"
    }
    const agent = setup(
      {
        name: "dynamic_shell",
        description: "",
        parameters: { type: "object" },
        shellKind: asynchronous ? async () => resolve() : resolve,
        execute: async () => {
          executed = true
          return textResult("done")
        },
      },
      new Permissions({
        rules: [
          {
            command: ["Remove-Item"],
            decision: "deny",
            source: { scope: "user", file: "settings.json" },
          },
        ],
      }),
    )
    try {
      await agent.prompt("run")
      expect(resolutions).toBe(1)
      expect(executed).toBe(false)
      expect(agent.messages.find((message) => message.role === "toolResult")).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Remove-Item") }],
      })
    } finally {
      await agent.dispose()
    }
  })
}

test("a permitted call with unavailable shell classification leaves context.shellKind absent", async () => {
  let resolutions = 0
  const contexts: ToolContext[] = []
  const agent = setup(
    {
      name: "dynamic_shell",
      description: "",
      parameters: { type: "object" },
      shellKind: async () => {
        resolutions++
        throw new Error("shell unavailable")
      },
      execute: async (_params, ctx) => {
        contexts.push(ctx)
        return textResult("done")
      },
    },
    new Permissions({ rules: [] }),
  )
  try {
    await agent.prompt("run")
    expect(resolutions).toBe(1)
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).not.toHaveProperty("shellKind")
  } finally {
    await agent.dispose()
  }
})

test("the permission facade preserves getters and method receivers on a frozen class tool", async () => {
  const contexts: ToolContext[] = []
  let reports = 0
  let resolutions = 0
  class ShellWriter implements ToolDefinition {
    #traits = { writesFiles: "paths" as const }
    #paths: string[] = []
    #kind: ShellKind = "bash"
    name = "shell_writer"
    description = ""
    parameters = { type: "object" }

    get traits() {
      return this.#traits
    }

    getWrittenPaths() {
      reports++
      return this.#paths
    }

    shellKind() {
      resolutions++
      return this.#kind
    }

    async execute(_params: unknown, ctx: ToolContext) {
      contexts.push(ctx)
      return textResult(this.#kind)
    }
  }
  const tool = Object.freeze(new ShellWriter())
  const agent = setup(tool, new Permissions({ rules: [] }))
  try {
    await agent.prompt("run")
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.shellKind).toBe("bash")
    expect(reports).toBe(2)
    expect(resolutions).toBe(1)
    expect(agent.messages.find((message) => message.role === "toolResult")?.isError).toBeFalsy()
  } finally {
    await agent.dispose()
  }
})

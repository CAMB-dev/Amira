import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { defineTool, type ProviderSettings, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { AgentTree } from "../src/subagents.ts"

function setup(providerSettings: Record<string, ProviderSettings> = {}, steps: MockStep[] = []) {
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({ ai, tree, model: ai.model("mock/plain"), cwd: process.cwd(), providerSettings })
  const ran: string[] = []
  for (const name of ["read", "write", "edit", "apply_patch"]) {
    const traits =
      name === "read"
        ? { readOnly: true, writesFiles: false as const }
        : name === "write"
          ? { writesFiles: "paths" as const, usesMutationHook: true }
          : { writesFiles: "paths" as const, usesMutationHook: true, editor: name as "edit" | "apply_patch" }
    agent.tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        traits,
        execute: async () => {
          ran.push(name)
          return textResult("ok")
        },
      }),
      "test",
    )
  }
  return { agent, ai, mock, tree, ran }
}

const names = async (agent: Agent) => (await agent.preview()).tools.map((t) => t.name)

test("editing tools default to edit and write; providers and exact models can override", async () => {
  const { agent, ai } = setup({
    mock: {
      tools: { edit: "both" },
      models: [
        { id: "patch", tools: { edit: "apply_patch" } },
        { id: "plain", tools: { edit: "edit" } },
      ],
    },
  })
  expect(await names(setup().agent)).toEqual(["read", "write", "edit"])
  expect(await names(agent)).toEqual(["read", "write", "edit"])
  agent.setModel(ai.model("mock/patch"))
  expect(await names(agent)).toEqual(["read", "write", "apply_patch"])
  agent.setModel(ai.model("mock/other"))
  expect(await names(agent)).toEqual(["read", "write", "edit", "apply_patch"])
  agent.tools.setDisabled(["apply_patch"])
  expect(await names(agent)).toEqual(["read", "write", "edit"])
})

test("a third-party editor trait participates in provider editing-tool selection", async () => {
  const { agent } = setup({ mock: { tools: { edit: "edit" } } })
  agent.tools.register(
    defineTool({
      name: "replacement",
      description: "replacement",
      parameters: { type: "object" },
      traits: { writesFiles: "paths", editor: "apply_patch" },
      execute: async () => textResult("ok"),
    }),
    "test",
  )
  expect(await names(agent)).not.toContain("replacement")
})

test("a hidden editing tool cannot run even when the model calls it", async () => {
  for (const mode of ["edit", "apply_patch"] as const) {
    const hidden = mode === "edit" ? "apply_patch" : "edit"
    const { agent, mock, ran } = setup({ mock: { tools: { edit: mode } } }, [
      { toolCalls: [{ name: hidden, args: {} }] },
      { text: "done" },
    ])
    await agent.prompt("change a file")
    expect(ran).toEqual([])
    expect(mock.requests[0]!.tools.map((t) => t.name)).not.toContain(hidden)
    const result = agent.messages.find((m) => m.role === "toolResult")
    expect(result?.role === "toolResult" && result.isError).toBe(true)
  }
})

test("editing tools change on subsequent model calls without changing the registry", async () => {
  const { agent, ai, mock } = setup(
    {
      mock: {
        models: [{ id: "patch", tools: { edit: "apply_patch" } }],
      },
    },
    [{ text: "first" }, { text: "second" }, { text: "third" }],
  )
  await agent.prompt("first")
  agent.setModel(ai.model("mock/patch"))
  await agent.prompt("second")
  agent.setModel(ai.model("mock/plain"))
  await agent.prompt("third")
  expect(mock.requests.map((r) => r.tools.map((t) => t.name))).toEqual([
    ["read", "write", "edit"],
    ["read", "write", "apply_patch"],
    ["read", "write", "edit"],
  ])
  expect(agent.tools.has("edit")).toBe(true)
  expect(agent.tools.has("apply_patch")).toBe(true)
})

test("sub-agents resolve editing tools for their own model and preserve tool restrictions", async () => {
  const { agent, tree, mock } = setup(
    {
      mock: {
        models: [{ id: "patch", tools: { edit: "apply_patch" } }],
      },
    },
    [{ text: "child" }, { text: "restricted" }],
  )
  await tree.spawn(agent, { prompt: "change", model: "mock/patch" }).result()
  await tree.spawn(agent, { prompt: "inspect", model: "mock/patch", tools: ["read"] }).result()
  expect(mock.requests[0]!.tools.map((t) => t.name)).toEqual(["read", "write", "apply_patch"])
  expect(mock.requests[1]!.tools.map((t) => t.name)).toEqual(["read"])
  expect(await names(agent)).toEqual(["read", "write", "edit"])
})

test("hidden deferred editing tools are absent from the system prompt and tool search", async () => {
  const { agent } = setup({ mock: { tools: { edit: "apply_patch" } } }, [
    { toolCalls: [{ name: "inspect", args: {} }] },
    { text: "done" },
  ])
  const edit = agent.tools.get("edit")!
  agent.tools.register({ ...edit, exposure: "deferred", override: true }, "test")
  expect((await agent.preview()).systemPrompt).not.toContain("edit")
  agent.tools.register(
    defineTool({
      name: "inspect",
      description: "inspect",
      parameters: { type: "object" },
      execute: async (_p, ctx) => {
        expect(ctx.session!.deferredTools()).toEqual([])
        expect(ctx.session!.loadTools(["edit"])).toEqual([])
        return textResult("ok")
      },
    }),
    "test",
  )
  expect((await agent.prompt("inspect")).reason).toBe("done")
  const result = agent.messages.find((m) => m.role === "toolResult")
  expect(result?.role === "toolResult" && result.isError).toBe(false)
})

import { afterEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { AnyEvent, ConversationSpec, PermissionMode, ToolDefinition } from "@amira/api"
import { defineTool, textResult } from "@amira/api"
import { writeTool } from "../../../extensions/builtin-tools/src/index.ts"
import { Agent, type AgentOptions, type ApprovalDecision } from "../src/agent.ts"
import { ArtifactStore } from "../src/artifacts.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { ownedDirectory } from "../src/owned-conversations-storage.ts"
import { type PermissionRule, Permissions } from "../src/permissions/policy.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup(
  options: Pick<AgentOptions, "permissions" | "approve" | "fileRewindSettings"> = {},
  maxConcurrent = 3,
  steps: MockStep[] = [{ text: "continued" }],
) {
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-owned-tools-"))
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [], maxConcurrent })
  let main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [], ...options })
  let ready = true
  const manager = new OwnedConversationManager({
    ai,
    tools,
    tree,
    home,
    agent: () => main,
    canExecute: () => ready,
  })
  const owner = manager.forOwner("checks")
  const spec: ConversationSpec = {
    key: "checks",
    name: "Checks",
    cwd: home,
    systemPrompt: "Run checks.",
    callableTools: ["bash"],
  }
  const runtime = { askUser: async () => undefined }
  const calls: string[] = []
  const shell: ToolDefinition = defineTool({
    name: "bash",
    description: "Mock command executor",
    traits: { shell: "bash" },
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async (args, context) => {
      calls.push(`${context.cwd}:${args.command}`)
      context.update(textResult("running"))
      return { ...textResult("checked"), details: { exitCode: 0, cwd: context.cwd } }
    },
  })
  tools.register(shell, "test")
  cleanups.push(async () => {
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  return {
    home,
    mock,
    tools,
    main: () => main,
    owner,
    manager,
    spec,
    runtime,
    calls,
    shell,
    setReady: (value: boolean) => {
      ready = value
    },
    switchMain: (value: Agent) => {
      main = value
    },
    ai,
  }
}

const rule = (decision: PermissionRule["decision"]): PermissionRule => ({
  command: ["echo"],
  decision,
  source: { scope: "user", file: "mock-settings.json" },
})

for (const [mode, decision, allowed, prompts] of [
  ["auto", undefined, true, 0],
  ["edits", undefined, true, 1],
  ["plan", undefined, false, 0],
  ["edits", "allow", true, 0],
  ["auto", "ask", true, 1],
  ["auto", "deny", false, 0],
  ["plan", "allow", false, 0],
] satisfies [PermissionMode, PermissionRule["decision"] | undefined, boolean, number][]) {
  test(`owned runTool respects ${mode}/${decision ?? "default"} without a provider request`, async () => {
    let approvals = 0
    const f = setup({
      permissions: new Permissions({ mode, rules: decision ? [rule(decision)] : [] }),
      approve: async (request) => {
        approvals++
        expect(request.name).toBe("bash")
        return { approved: true, by: "user" }
      },
    })
    const handle = await f.owner.openOrCreate(f.spec, f.runtime)
    const result = await handle.runTool("bash", { command: "echo check", cwd: path.dirname(f.home) })
    expect(!!result.isError).toBe(!allowed)
    expect(f.calls).toHaveLength(allowed ? 1 : 0)
    if (allowed) expect(result.details).toEqual({ exitCode: 0, cwd: f.home })
    expect(approvals).toBe(prompts)
    expect(f.mock.requests).toHaveLength(0)
    expect(handle.history()).toEqual([])
  })
}

test("owned tool events and operation records are attributable without model messages", async () => {
  const f = setup()
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  const events: AnyEvent[] = []
  const collect = (async () => {
    for await (const event of handle.events) events.push(event)
  })()
  await handle.runTool("bash", { command: "echo check" })
  expect(handle.history()).toEqual([])
  const records = handle.data.read("amira.tool-operations")
  expect(records).toHaveLength(3)
  expect(records[0]).toMatchObject({
    v: 1,
    phase: "start",
    call: { name: "bash", args: { command: "echo check" } },
  })
  expect(records[1]).toMatchObject({
    v: 1,
    phase: "execute",
    call: { name: "bash", args: { command: "echo check" } },
  })
  expect(records[2]).toMatchObject({ v: 1, phase: "end", result: { toolName: "bash", isError: false } })
  await handle.release()
  await collect
  expect(events.filter((event) => event.type.startsWith("tool.execute.")).map((event) => event.type)).toEqual(
    ["tool.execute.start", "tool.execute.update", "tool.execute.end"],
  )
  expect(events.every((event) => event.sessionId === handle.id)).toBe(true)
  expect(
    events
      .filter((event) => event.type.startsWith("tool.execute."))
      .every((event) => event.turnId?.startsWith("o_")),
  ).toBe(true)
  expect(events.some((event) => event.type === "turn.start" || event.type === "message.start")).toBe(false)
  const reopened = await f.owner.open(handle.id, f.runtime)
  expect(reopened.data.read("amira.tool-operations")).toEqual(records)
  expect(reopened.history()).toEqual([])
  const sending = reopened.send("Continue")
  await expect(reopened.runTool("bash", { command: "echo concurrent" })).rejects.toThrow("busy")
  await sending
  expect(f.mock.requests).toHaveLength(1)
  expect(reopened.history().map((message) => message.role)).toEqual(["user", "assistant"])
})

test("reopen preserves tool failure and unfinished operation state without replay", async () => {
  const f = setup()
  const handle = await f.owner.openOrCreate({ ...f.spec, callableTools: [] }, f.runtime)
  expect((await handle.runTool("bash", { command: "echo check" })).isError).toBe(true)
  await handle.release()
  const reopened = await f.owner.open(handle.id, f.runtime)
  expect(reopened.status()).toEqual({ state: "error", busy: false })
  reopened.data.append("amira.tool-operations", { v: 1, phase: "start", operationId: "o_unfinished" })
  await reopened.release()
  const unfinished = await f.owner.open(handle.id, f.runtime)
  expect(unfinished.status()).toEqual({ state: "stopped", busy: false })
  expect(unfinished.history()).toEqual([])
  expect(f.calls).toEqual([])
  expect(f.mock.requests).toHaveLength(0)
})

test("runTool cannot widen callable tools, bypass the live host mask, or execute during initialization", async () => {
  const f = setup()
  const handle = await f.owner.openOrCreate({ ...f.spec, callableTools: [] }, f.runtime)
  expect((await handle.runTool("bash", { command: "echo check" })).isError).toBe(true)
  await handle.release()
  const next = await f.owner.openOrCreate({ ...f.spec, key: "enabled" }, f.runtime)
  f.tools.setDisabled(["bash"])
  expect((await next.runTool("bash", { command: "echo check" })).isError).toBe(true)
  f.tools.setDisabled([])
  f.setReady(false)
  await expect(next.runTool("bash", { command: "echo check" })).rejects.toThrow("initialization")
  f.setReady(true)
  expect((await next.runTool("bash", {})).isError).toBe(true)
  expect(f.calls).toEqual([])
  expect(f.mock.requests).toHaveLength(0)
})

test("runTool uses final interceptor arguments and cannot report a denial or timeout as success", async () => {
  const rules = [rule("deny")]
  const f = setup({ permissions: new Permissions({ mode: "auto", rules }) })
  f.main().interceptors.add("tool.call.before", (value) => ({
    action: "modify",
    value: { ...value, args: { command: "echo forbidden" } },
  }))
  f.main().interceptors.add("tool.call.after", (value) => ({
    action: "modify",
    value: { ...value, result: textResult("pretend success") },
  }))
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  expect((await handle.runTool("bash", { command: "git status" })).isError).toBe(true)
  expect(f.calls).toEqual([])
  f.tools.register(
    {
      ...f.shell,
      override: true,
      execute: async () => {
        throw new Error("command timed out")
      },
    },
    "test",
  )
  rules.splice(0)
  expect((await handle.runTool("bash", { command: "echo check" })).isError).toBe(true)
  expect(handle.history()).toEqual([])
})

test("runTool keeps write ceilings after interceptor rewrites and approval cannot override them", async () => {
  let approvals = 0
  const f = setup({
    approve: async (request) => {
      approvals++
      request.args.path = path.join(path.dirname(f.home), "outside.txt")
      return { approved: true }
    },
  })
  const destinations: string[] = []
  f.tools.register(
    defineTool({
      name: "writer",
      description: "Mock writer",
      traits: { writesFiles: "paths" },
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      getWrittenPaths: (args) => [args.path],
      execute: async (args) => {
        destinations.push(args.path)
        return textResult("written")
      },
    }),
    "test",
  )
  const handle = await f.owner.openOrCreate(
    { ...f.spec, callableTools: ["writer"], writeRoots: [f.home] },
    f.runtime,
  )
  f.main().interceptors.add("tool.call.before", () => ({ action: "ask", reason: "review write" }))
  const inside = path.join(f.home, "inside.txt")
  const allowed = await handle.runTool("writer", { path: inside })
  expect(allowed.content).toEqual([{ type: "text", text: "written" }])
  expect(allowed.isError).not.toBe(true)
  // Approval receives a copy, not mutable authority over the approved execution arguments.
  expect(destinations).toEqual([inside])
  expect(approvals).toBe(1)
  f.main().interceptors.add("tool.call.before", (value) => ({
    action: "modify",
    value: { ...value, args: { path: path.join(path.dirname(f.home), "outside.txt") } },
  }))
  expect((await handle.runTool("writer", { path: inside })).isError).toBe(true)
  expect(approvals).toBe(1)
  expect(destinations).toEqual([inside])
  expect(f.mock.requests).toHaveLength(0)
})

for (const delegated of [false, true]) {
  test(`owned ${delegated ? "delegated" : "direct"} file writes journal against the operation without a user message`, async () => {
    const f = setup(
      {},
      1,
      delegated
        ? [
            {
              toolCalls: [
                { id: "child-write", name: "write", args: { path: "written.txt", content: "owned write" } },
              ],
            },
            { text: "child completed" },
          ]
        : [],
    )
    f.tools.register(writeTool, "test")
    f.tools.register(
      defineTool({
        name: "delegate",
        description: "Delegate a write",
        traits: { readOnly: true },
        parameters: { type: "object" },
        execute: async (_args, context) => {
          const child = context.session!.spawn!({ prompt: "Write the file" })
          const result = await child.result()
          return textResult(result.text)
        },
      }),
      "test",
    )
    const handle = await f.owner.openOrCreate(
      { ...f.spec, callableTools: ["write", "delegate"], writeRoots: [f.home], descendants: "inherit" },
      f.runtime,
    )
    const result = await handle.runTool(
      delegated ? "delegate" : "write",
      delegated ? {} : { path: "written.txt", content: "owned write" },
    )
    expect(result.isError).not.toBe(true)
    expect(readFileSync(path.join(f.home, "written.txt"), "utf8")).toBe("owned write")
    const store = SessionStore.open(path.join(ownedDirectory(f.home, "checks"), `${handle.id}.jsonl`))
    const operation = store
      .branch()
      .find((entry) => entry.type === "custom" && entry.ext === "amira.tool-operations")
    const mutation = store.branch().find((entry) => entry.type === "file_mutation")
    expect(operation).toBeDefined()
    expect(mutation?.messageId).toBe(operation?.id)
    expect(handle.history()).toEqual([])
    expect(f.mock.requests).toHaveLength(delegated ? 2 : 0)
  })
}

test("runTool yields admission to a delegated child with one shared slot", async () => {
  const f = setup({}, 1)
  f.tools.register(
    defineTool({
      name: "delegate",
      description: "Wait for a child",
      parameters: { type: "object" },
      traits: { readOnly: true },
      execute: async (_args, context) => {
        const child = context.session!.spawn!({ prompt: "Child check" })
        const result = await child.result()
        return textResult(result.text)
      },
    }),
    "test",
  )
  const handle = await f.owner.openOrCreate({ ...f.spec, callableTools: ["delegate"] }, f.runtime)
  const result = await handle.runTool("delegate", {}, { signal: AbortSignal.timeout(2000) })
  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([{ type: "text", text: "continued" }])
  expect(f.mock.requests).toHaveLength(1)
  expect(handle.history()).toEqual([])
})

test("in-place after-interceptor mutation cannot make a timed-out command successful", async () => {
  const f = setup()
  f.tools.register(
    {
      ...f.shell,
      override: true,
      execute: async () => ({ ...textResult("timed out", true), details: { timedOut: true } }),
    },
    "test",
  )
  f.main().interceptors.add("tool.call.after", (value) => {
    value.result.isError = false
    return { action: "modify", value }
  })
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  const events: AnyEvent[] = []
  const collect = (async () => {
    for await (const event of handle.events) events.push(event)
  })()
  const result = await handle.runTool("bash", { command: "echo check" })
  expect(result.isError).toBe(true)
  expect(handle.data.read("amira.tool-operations").at(-1)).toMatchObject({
    phase: "end",
    result: { isError: true },
  })
  await handle.release()
  await collect
  expect(events.find((event) => event.type === "tool.execute.end")?.data).toMatchObject({
    result: { isError: true },
  })
})

test("concurrent send/tool operations reject, signal/stop cancel, and release drains", async () => {
  const f = setup()
  let entered = Promise.withResolvers<void>()
  let drained = 0
  f.tools.register(
    {
      ...f.shell,
      override: true,
      execute: async (_args, context) => {
        entered.resolve()
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        )
        await Bun.sleep(5)
        drained++
        return textResult("executor returned after cancellation")
      },
    },
    "test",
  )
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  const controller = new AbortController()
  const first = handle.runTool("bash", { command: "echo wait" }, { signal: controller.signal })
  await entered.promise
  await expect(handle.send("concurrent")).rejects.toThrow("busy")
  await expect(handle.runTool("bash", { command: "echo concurrent" })).rejects.toThrow("busy")
  controller.abort()
  expect((await first).isError).toBe(true)
  expect(drained).toBe(1)
  entered = Promise.withResolvers<void>()
  const second = handle.runTool("bash", { command: "echo wait" })
  await entered.promise
  await handle.stop()
  expect((await second).isError).toBe(true)
  expect(handle.status()).toEqual({ state: "stopped", busy: false })
  entered = Promise.withResolvers<void>()
  const third = handle.runTool("bash", { command: "echo wait" })
  await entered.promise
  await handle.release()
  expect((await third).isError).toBe(true)
  expect(drained).toBe(3)
  expect(f.mock.requests).toHaveLength(0)
  await expect(handle.runTool("bash", { command: "echo stale" })).rejects.toThrow("released")
})

for (const action of ["release", "stop", "signal"] as const) {
  test(`owned ${action} waits beyond abort grace for physical cleanup and revokes mutations`, async () => {
    let approvals = 0
    const f = setup({
      fileRewindSettings: { enabled: false },
      approve: async () => {
        approvals++
        return { approved: true }
      },
    })
    const entered = Promise.withResolvers<void>()
    const unblock = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let mutationCalls = 0
    let mutationError = ""
    const destination = path.join(f.home, "late.txt")
    f.tools.register(
      defineTool({
        name: "held_writer",
        description: "Hold past abort grace",
        parameters: { type: "object" },
        traits: { writesFiles: "paths", usesMutationHook: true },
        getWrittenPaths: () => [destination],
        execute: async (_args, context) => {
          entered.resolve()
          try {
            await unblock.promise
            await context.mutateFiles!([{ path: destination, after: Buffer.from("late") }], async () => {
              mutationCalls++
              writeFileSync(destination, "late")
            })
            return textResult("late write")
          } catch (error) {
            mutationError = String(error)
            return textResult(mutationError, true)
          } finally {
            finished.resolve()
          }
        },
      }),
      "test",
    )
    const handle = await f.owner.openOrCreate(
      { ...f.spec, callableTools: ["held_writer"], writeRoots: [f.home] },
      f.runtime,
    )
    const controller = new AbortController()
    const operation = handle.runTool("held_writer", {}, { signal: controller.signal })
    await entered.promise
    let settled = false
    if (action === "signal") controller.abort()
    const completion = action === "release" ? handle.release() : action === "stop" ? handle.stop() : operation
    void completion.then(() => {
      settled = true
    })
    let reopened: Awaited<ReturnType<typeof f.owner.open>> | undefined
    try {
      // Hold beyond both existing serial/batch abort waits (2 x the 2000 ms grace).
      await Bun.sleep(4300)
      expect(settled).toBe(false)
      if (action === "release") {
        const outcome = await f.owner.open(handle.id, f.runtime).then(
          (value) => {
            reopened = value
            return "opened"
          },
          (error) => String(error),
        )
        expect(outcome).toMatch(/in use|unloading/)
      } else {
        await expect(handle.runTool("held_writer", {})).rejects.toThrow("busy")
        await expect(handle.send("overlap")).rejects.toThrow("busy")
      }
    } finally {
      unblock.resolve()
      await finished.promise
      await completion
      await reopened?.release()
    }
    expect((await operation).isError).toBe(true)
    expect(mutationError).toMatch(/abort|cancel|finished|revok/i)
    expect(mutationCalls).toBe(0)
    expect(existsSync(destination)).toBe(false)
    expect(approvals).toBe(0)
    const next = await f.owner.open(handle.id, f.runtime)
    if (action === "release") expect(next).not.toBe(handle)
  }, 15_000)
}

test("a stopped owned model send remains busy until its executor physically drains", async () => {
  const f = setup({ fileRewindSettings: { enabled: false } }, 1, [
    { toolCalls: [{ id: "held-model", name: "held", args: {} }] },
  ])
  const entered = Promise.withResolvers<void>()
  const unblock = Promise.withResolvers<void>()
  f.tools.register(
    defineTool({
      name: "held",
      description: "Held model executor",
      parameters: { type: "object" },
      traits: { readOnly: true },
      execute: async () => {
        entered.resolve()
        await unblock.promise
        return textResult("done")
      },
    }),
    "test",
  )
  const handle = await f.owner.openOrCreate({ ...f.spec, callableTools: ["held"] }, f.runtime)
  const send = handle.send("Start")
  await entered.promise
  let stopped = false
  const stop = handle.stop().then(() => {
    stopped = true
  })
  try {
    await Bun.sleep(4300)
    expect(stopped).toBe(false)
    await expect(handle.runTool("held", {})).rejects.toThrow("busy")
  } finally {
    unblock.resolve()
    await send
    await stop
  }
}, 15_000)

for (const writer of [false, true]) {
  test(`start-event cancellation prevents ${writer ? "journaled writer" : "shell"} executor dispatch`, async () => {
    let executions = 0
    let approvals = 0
    const f = setup({
      approve: async () => {
        approvals++
        return { approved: true }
      },
    })
    if (writer)
      f.tools.register(
        defineTool({
          name: "writer",
          description: "Journaled writer",
          parameters: { type: "object" },
          traits: { writesFiles: "paths" },
          getWrittenPaths: () => [path.join(f.home, "cancelled.txt")],
          execute: async () => {
            executions++
            return textResult("executed")
          },
        }),
        "test",
      )
    else
      f.tools.register(
        {
          ...f.shell,
          override: true,
          execute: async () => {
            executions++
            return textResult("executed")
          },
        },
        "test",
      )
    const name = writer ? "writer" : "bash"
    const handle = await f.owner.openOrCreate(
      { ...f.spec, callableTools: [name], writeRoots: [f.home] },
      f.runtime,
    )
    const controller = new AbortController()
    const collect = (async () => {
      for await (const event of handle.events) if (event.type === "tool.execute.start") controller.abort()
    })()
    const result = await handle.runTool(name, { command: "echo cancelled" }, { signal: controller.signal })
    await handle.release()
    await collect
    expect(result.isError).toBe(true)
    expect(executions).toBe(0)
    expect(approvals).toBe(0)
  })
}

test("successful rewritten commands persist requested and executed arguments before dispatch and across reopen", async () => {
  const f = setup()
  f.main().interceptors.add("tool.call.before", (value) => ({
    action: "modify",
    value: { ...value, args: { command: "echo executed B" } },
  }))
  let evidenceAtDispatch: unknown[] = []
  let sessionId = ""
  f.tools.register(
    {
      ...f.shell,
      override: true,
      execute: async (args) => {
        expect(args.command).toBe("echo executed B")
        const store = SessionStore.open(path.join(ownedDirectory(f.home, "checks"), `${sessionId}.jsonl`))
        evidenceAtDispatch = store
          .branch()
          .flatMap((entry) =>
            entry.type === "custom" && entry.ext === "amira.tool-operations" ? [entry.data] : [],
          )
        return textResult("B result")
      },
    },
    "test",
  )
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  sessionId = handle.id
  expect((await handle.runTool("bash", { command: "echo requested A" })).isError).not.toBe(true)
  expect(evidenceAtDispatch).toHaveLength(2)
  expect(evidenceAtDispatch[0]).toMatchObject({
    phase: "start",
    call: { args: { command: "echo requested A" } },
  })
  expect(evidenceAtDispatch[1]).toMatchObject({
    phase: "execute",
    call: { name: "bash", args: { command: "echo executed B" } },
  })
  await handle.release()
  const reopened = await f.owner.open(handle.id, f.runtime)
  const records = reopened.data.read("amira.tool-operations")
  expect(records).toHaveLength(3)
  expect(records[0]).toMatchObject({ operationId: (records[1] as { operationId: string }).operationId })
  expect(records[2]).toMatchObject({
    phase: "end",
    operationId: (records[1] as { operationId: string }).operationId,
    result: { toolCallId: (records[1] as { call: { id: string } }).call.id, isError: false },
  })
  expect(reopened.history()).toEqual([])
  expect(f.mock.requests).toHaveLength(0)
})

test("approval dismissal consistently stops the live and reopened operation without dispatch", async () => {
  let approvals = 0
  const f = setup({
    permissions: new Permissions({ mode: "edits" }),
    approve: async () => {
      approvals++
      return { approved: false, interrupt: true }
    },
  })
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  const result = await handle.runTool("bash", { command: "echo dismissed" })
  expect(result.isError).toBe(true)
  expect(f.calls).toHaveLength(0)
  expect(approvals).toBe(1)
  expect(handle.status()).toEqual({ state: "stopped", busy: false })
  await handle.release()
  const reopened = await f.owner.open(handle.id, f.runtime)
  expect(reopened.status()).toEqual({ state: "stopped", busy: false })
})

for (const action of ["release", "stop"] as const) {
  test(`owned ${action} retains ownership until output persistence finishes`, async () => {
    const f = setup()
    const entered = Promise.withResolvers<void>()
    const unblock = Promise.withResolvers<void>()
    const original = ArtifactStore.prototype.save
    let saved = false
    const spy = spyOn(ArtifactStore.prototype, "save").mockImplementation(async function (
      this: ArtifactStore,
      options,
    ) {
      entered.resolve()
      await unblock.promise
      const artifact = await original.call(this, options)
      saved = true
      return artifact
    })
    f.tools.register(
      { ...f.shell, override: true, execute: async () => textResult("x".repeat(20_000)) },
      "test",
    )
    const handle = await f.owner.openOrCreate(f.spec, f.runtime)
    const operation = handle.runTool("bash", { command: "echo large" })
    await entered.promise
    let settled = false
    const completion = (action === "release" ? handle.release() : handle.stop()).then(() => {
      settled = true
    })
    try {
      await Bun.sleep(4300)
      expect(settled).toBe(false)
      expect(saved).toBe(false)
      if (action === "release")
        await expect(f.owner.open(handle.id, f.runtime)).rejects.toThrow(/in use|unloading/)
      else await expect(handle.runTool("bash", { command: "echo overlap" })).rejects.toThrow("busy")
    } finally {
      unblock.resolve()
      await operation
      await completion
      spy.mockRestore()
    }
    expect(saved).toBe(true)
    expect((await operation).isError).toBe(true)
  }, 15_000)
}

for (const action of ["stop", "release", "signal"] as const) {
  for (const source of ["permission", "interceptor"] as const) {
    test(`owned ${action} abandons an unresponsive ${source} approver without dispatching a late approval`, async () => {
      const entered = Promise.withResolvers<AbortSignal>()
      const answer = Promise.withResolvers<ApprovalDecision>()
      const f = setup({
        permissions: new Permissions({ mode: source === "permission" ? "edits" : "auto" }),
        approve: (_request, signal) => {
          entered.resolve(signal)
          return answer.promise
        },
      })
      if (source === "interceptor")
        f.main().interceptors.add("tool.call.before", () => ({ action: "ask", reason: "review check" }))
      const handle = await f.owner.openOrCreate(f.spec, f.runtime)
      const controller = new AbortController()
      const operation = handle.runTool("bash", { command: "echo never" }, { signal: controller.signal })
      const approvalSignal = await entered.promise
      if (action === "signal") controller.abort()
      const completion = action === "signal" ? operation : handle[action]()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const settled = await Promise.race([
          completion.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 1000)
          }),
        ])
        expect(approvalSignal.aborted).toBe(true)
        expect(settled).toBe(true)
        expect((await operation).isError).toBe(true)
        const live = action === "release" ? await f.owner.open(handle.id, f.runtime) : handle
        expect(live.status()).toEqual({ state: "stopped", busy: false })
        // Completion and lease release do not depend on the callback ever settling.
        // Even an affirmative answer arriving afterwards cannot start an executor.
        answer.resolve({ approved: true, by: "user" })
        await Bun.sleep(0)
        expect(live.status()).toEqual({ state: "stopped", busy: false })
        expect(f.calls).toHaveLength(0)
        expect(f.mock.requests).toHaveLength(0)
        expect(
          live.data
            .read("amira.tool-operations")
            .some((record) => (record as { phase?: string }).phase === "execute"),
        ).toBe(false)
      } finally {
        clearTimeout(timer)
        answer.resolve({ approved: true, by: "user" })
        await operation
        await completion
      }
    })
  }
}

test("an owned approval remains human-bound across main replacement and release cancels only its request", async () => {
  const requested = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  let source = ""
  const f = setup({
    permissions: new Permissions({ mode: "edits" }),
    approve: async (request, aborted) => {
      signal = aborted
      source = request.sessionId
      requested.resolve()
      return new Promise((resolve) =>
        aborted.addEventListener("abort", () => resolve({ approved: false }), { once: true }),
      )
    },
  })
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  const operation = handle.runTool("bash", { command: "echo check" })
  await requested.promise
  const original = f.main()
  const next = new Agent({ ai: f.ai, model: f.ai.model("mock/test"), cwd: f.home, sections: [] })
  f.switchMain(next)
  expect(source).toBe(handle.id)
  expect(handle.status()).toEqual({ state: "blocked", busy: true })
  await f.manager.releaseOwner("checks")
  expect((await operation).isError).toBe(true)
  expect(signal?.aborted).toBe(true)
  expect(next.busy).toBe(false)
  expect(f.calls).toEqual([])
  expect(f.mock.requests).toHaveLength(0)
  await original.dispose()
})

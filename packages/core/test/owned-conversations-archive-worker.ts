import path from "node:path"
import type { Agent as AgentType } from "../src/agent.ts"

const [home, mode, id] = process.argv.slice(2)
if (!home || !mode || (mode === "archive" && !id))
  throw new Error("worker requires an isolated home, mode and archive conversation id")
// Install before application modules capture named filesystem exports.
const fs: typeof import("node:fs") = require("node:fs")
const rename = fs.renameSync
let crashingId: string | undefined
fs.renameSync = (source, destination) => {
  const target = String(destination)
  const crash =
    crashingId &&
    ((mode === "crash-upgrade" && target.endsWith(`${crashingId}.jsonl`)) ||
      (mode === "crash-publication" &&
        target.endsWith(`${crashingId}.spec.json`) &&
        JSON.parse(fs.readFileSync(source, "utf8")).lifecycle === "archived"))
  if (crash) {
    fs.writeFileSync(path.join(home, "archive-ready.json"), JSON.stringify({ id: crashingId }))
    process.exit(77)
  }
  return rename(source, destination)
}
const { createAi, createMockDialect } = await import("@amira/ai")
const { defineTool, textResult } = await import("@amira/api")
const { ToolRegistry } = await import("../src/tool-registry.ts")
const { Agent } = await import("../src/agent.ts")
const { OwnedConversationManager } = await import("../src/owned-conversations.ts")
const { AgentTree } = await import("../src/subagents.ts")
const mock = createMockDialect(
  mode === "crash-drain" || mode === "crash-cancel" ? [{ toolCalls: [{ name: "ask_user", args: {} }] }] : [],
)
const ai = createAi({
  dialects: [mock],
  providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
  retry: { retries: 0 },
})
const tools = new ToolRegistry()
tools.register(
  defineTool({
    name: "ask_user",
    description: "Ask the owner",
    parameters: { type: "object" },
    execute: async (_args, context) => {
      await context.session!.askUser!([{ question: "Choose?", options: [{ label: "A" }] }], context.signal)
      return textResult("answered")
    },
  }),
  "test",
)
const tree = new AgentTree({ ai, sections: () => [] })
const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [] })
const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
const owner = manager.forOwner("project")
let keepAlive: ReturnType<typeof setInterval> | undefined
const dispose = Agent.prototype.dispose
try {
  if (mode === "archive") {
    try {
      await owner.archive({ id: id! })
      console.log(
        JSON.stringify({
          archived: (await owner.read({ id: id! }))?.archived,
          requests: mock.requests.length,
        }),
      )
    } catch (error) {
      console.log(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          requests: mock.requests.length,
        }),
      )
    }
  } else if (mode === "crash-drain") {
    keepAlive = setInterval(() => {}, 1000)
    const asked = Promise.withResolvers<void>()
    const conversation = await owner.openOrCreate(
      {
        key: "project/design",
        name: "Design",
        cwd: path.join(home, "worktree"),
        model: "mock/test",
        systemPrompt: "Research only.",
        callableTools: ["ask_user"],
      },
      {
        askUser: async () => {
          asked.resolve()
          return new Promise<undefined>(() => {})
        },
      },
    )
    const running = conversation.send("leave a pending question").catch(() => {})
    await asked.promise
    // Freeze the actual drain boundary, not an estimated sleep or a private lifecycle write.
    // The public archive call must already have persisted its fence before getting here.
    Agent.prototype.dispose = function (...args: Parameters<AgentType["dispose"]>) {
      if (this.sessionId === conversation.id) {
        fs.writeFileSync(path.join(home, "archive-ready.json"), JSON.stringify({ id: conversation.id }))
        return new Promise<void>(() => {})
      }
      return dispose.apply(this, args)
    }
    await owner.archive({ id: conversation.id })
    await running
    throw new Error("crash drain unexpectedly settled")
  } else if (mode === "crash-cancel" || mode === "crash-release-wait") {
    keepAlive = setInterval(() => {}, 1000)
    const asked = Promise.withResolvers<void>()
    const conversation = await owner.openOrCreate(
      {
        key: "project/design",
        name: "Design",
        cwd: path.join(home, "worktree"),
        model: "mock/test",
        systemPrompt: "Research only.",
        callableTools: ["ask_user"],
      },
      {
        askUser: async (_questions, context) => {
          context.signal.addEventListener("abort", () => {
            fs.writeFileSync(path.join(home, "archive-ready.json"), JSON.stringify({ id: conversation.id }))
            process.exit(77)
          })
          asked.resolve()
          return new Promise<undefined>(() => {})
        },
      },
    )
    if (mode === "crash-cancel") {
      void conversation.send("wait for owner").catch(() => {})
      await asked.promise
      await owner.archive({ id: conversation.id })
    } else {
      Agent.prototype.dispose = function (...args: Parameters<AgentType["dispose"]>) {
        if (this.sessionId === conversation.id) return new Promise<void>(() => {})
        return dispose.apply(this, args)
      }
      void conversation.release()
      // The next event-loop turn observes archive waiting on the already-started drain.
      setImmediate(() => {
        fs.writeFileSync(path.join(home, "archive-ready.json"), JSON.stringify({ id: conversation.id }))
        process.exit(77)
      })
      await owner.archive({ id: conversation.id })
    }
    throw new Error("archive crash boundary unexpectedly settled")
  } else if (mode === "crash-upgrade" || mode === "crash-publication") {
    const conversation = await owner.openOrCreate(
      {
        key: "project/design",
        name: "Design",
        cwd: path.join(home, "worktree"),
        model: "mock/test",
        systemPrompt: "Research only.",
        callableTools: [],
      },
      { askUser: async () => undefined },
    )
    crashingId = conversation.id
    await owner.archive({ id: conversation.id })
    throw new Error("crash publication unexpectedly settled")
  } else {
    throw new Error(`unknown archive worker mode: ${mode}`)
  }
} finally {
  clearInterval(keepAlive)
  Agent.prototype.dispose = dispose
  await manager.drain()
  await main.dispose()
}

import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent, createLocalAgentPort, FrontendOperationError } from "@amira/core"
import { Editor, type EditorPart } from "@amira/tui-kit"
import { createTurnActivity } from "../src/app/activity.ts"
import { createOutbox, toPrompt } from "../src/app/outbox.ts"

function fixture(admit: boolean) {
  const gate = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<never>()
  const ai = createAi({
    dialects: [createMockDialect([{ text: "held reply", hold: { chunks: 0, until: gate.promise } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { caps: { images: true } } }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
  const port = createLocalAgentPort({ agent })
  const execute = port.execute.bind(port)
  port.execute = async (operation, params, options) => {
    if (operation !== "turn.prompt") return execute(operation, params, options)
    if (!admit) return reply.promise
    const accepted = await execute(operation, params, options)
    await reply.promise
    return accepted
  }
  const editor = new Editor()
  const activity = createTurnActivity()
  const notices: string[] = []
  const outbox = createOutbox({
    agent: () => agent,
    frontend: port,
    editor,
    activity,
    spinner: { stop: () => {} },
    view: { notice: (_, text) => notices.push(text), requestRender: () => {}, user: () => {} },
    takeEcho: () => false,
    echoedNote: () => {},
    noModelYet: () => false,
    canRewind: () => false,
    openRewind: () => false,
    onInterrupt: () => {},
  })
  const off = agent.bus.subscribe((event) => {
    if (event.type === "turn.start") {
      outbox.turnStarted(event.data.prompt, event.turnId)
      activity.turnStarted(() => {})
    } else if (event.type === "turn.end") activity.turnEnded()
  })
  return {
    agent,
    port,
    editor,
    activity,
    outbox,
    notices,
    reply,
    async close() {
      outbox.dispose()
      off()
      gate.resolve()
      reply.reject(new Error("closed"))
      await port.detach()
      await agent.dispose()
    },
  }
}

for (const images of [false, true]) {
  test(`authoritative turn.start reconciles a delayed ${images ? "image" : "text"} prompt acknowledgement`, async () => {
    const s = fixture(true)
    const parts: EditorPart[] = images
      ? ["before", { image: { name: "prompt.png", data: "aW1hZ2U=", mimeType: "image/png" } }, "after"]
      : ["beforeafter"]
    try {
      const message = s.outbox.prepare("beforeafter", parts, "folded prompt")
      s.outbox.dispatch(message, parts, "queue")
      await s.agent.bus.flush()
      expect(s.agent.busy).toBe(true)
      expect(s.activity.working).toBe(true)
      s.reply.reject(new Error("lost acceptance"))
      await Bun.sleep(0)
      expect(s.editor.getParts()).toEqual([])
      expect(s.activity.working).toBe(true)
      expect(s.agent.busy).toBe(true)
      expect(s.notices).toEqual([])
    } finally {
      await s.close()
    }
  })
}

test("an unrelated turn.start with identical content cannot reconcile a rejected prompt", async () => {
  const s = fixture(false)
  try {
    const message = s.outbox.prepare("same text", ["same text"])
    s.outbox.dispatch(message, ["same text"], "queue")
    void s.agent.prompt(toPrompt(message))
    await s.agent.bus.flush()
    s.reply.reject(new FrontendOperationError("agent_busy", "busy"))
    await Bun.sleep(0)
    expect(s.outbox.queued).toEqual([message])
    expect(s.editor.getParts()).toEqual([])
    expect(s.activity.working).toBe(true)
  } finally {
    await s.close()
  }
})

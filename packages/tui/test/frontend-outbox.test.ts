import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent, type AgentPort, createLocalAgentPort } from "@amira/core"
import { Editor, type EditorPart } from "@amira/tui-kit"
import { createTurnActivity } from "../src/app/activity.ts"
import { createOutbox, type Outgoing, toPrompt } from "../src/app/outbox.ts"

function fixture(forward = true) {
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
  const local = createLocalAgentPort({ agent })
  const pending = Promise.withResolvers<never>()
  const calls: unknown[] = []
  const frontend: AgentPort = {
    snapshot: local.snapshot,
    subscribe: () => () => {},
    execute: (operation, params, options) => {
      calls.push({ operation, params, generation: options?.sessionGeneration })
      return forward && calls.length > 1 ? local.execute(operation, params, options) : pending.promise
    },
    detach: async () => {},
  }
  const editor = new Editor()
  const activity = createTurnActivity()
  const notices: string[] = []
  const outbox = createOutbox({
    agent: () => agent,
    frontend,
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
  return {
    agent,
    local,
    pending,
    calls,
    editor,
    activity,
    notices,
    outbox,
    async dispose() {
      outbox.dispose()
      await local.detach()
      await agent.dispose()
    },
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

test("outbox recognizes a JSON busy code and queues rather than losing the draft", async () => {
  const s = fixture()
  try {
    const message = s.outbox.prepare("question", ["question"])
    s.outbox.dispatch(message, ["question"], "queue")
    s.pending.reject(JSON.parse('{"code":"agent_busy","message":"busy"}'))
    await settle()
    expect(s.outbox.queued).toEqual([message])
    expect(s.notices).toEqual([])
    expect(s.calls).toMatchObject([{ operation: "turn.prompt", generation: 1 }])
  } finally {
    await s.dispose()
  }
})

for (const state of ["current", "switched", "disposed"] as const) {
  test(`delayed ${state} prompt rejection cannot send or erase a newer draft`, async () => {
    const s = fixture()
    try {
      const message = s.outbox.prepare("question", ["question"])
      s.outbox.dispatch(message, ["question"], "queue")
      s.editor.setParts(["new draft"])
      if (state === "switched") s.outbox.reset()
      if (state === "disposed") s.outbox.dispose()
      s.pending.reject(new Error("Disconnected"))
      await settle()
      expect(s.editor.getText()).toBe(state === "disposed" ? "new draft" : "question\n\nnew draft")
      expect(s.notices).toEqual(state === "current" ? ["Disconnected"] : [])
      expect(s.calls).toHaveLength(1)
    } finally {
      await s.dispose()
    }
  })
}

test("image steering retains its interleaved text, name and folded display on rejection", async () => {
  const s = fixture()
  const parts: EditorPart[] = [
    "before",
    { image: { name: "paste.png", data: "aW1hZ2U=", mimeType: "image/png" } },
    "after",
  ]
  try {
    s.activity.beginSend()
    const message = s.outbox.prepare("beforeafter", parts, "folded image")
    s.outbox.dispatch(message, parts, "steer")
    expect(s.calls).toEqual([
      {
        operation: "turn.steer",
        generation: 1,
        params: {
          turnId: expect.any(String),
          expectedIdle: true,
          message: {
            role: "user",
            content: [
              { type: "text", text: "before" },
              { type: "image", name: "paste.png", data: "aW1hZ2U=", mimeType: "image/png" },
              { type: "text", text: "after" },
            ],
            display: { text: "folded image" },
          },
        },
      },
    ])
    s.pending.reject(new Error("Disconnected"))
    await settle()
    expect(s.editor.getParts()).toEqual(parts)
    expect(s.notices).toEqual(["Disconnected"])
  } finally {
    await s.dispose()
  }
})

test("a busy rejection arriving after turn.end releases the queued prompt", async () => {
  const s = fixture()
  try {
    const message = s.outbox.prepare("question", ["question"])
    s.outbox.dispatch(message, ["question"], "queue")
    s.activity.turnStarted(() => {})
    s.outbox.turnStarted({ role: "user", content: [{ type: "text", text: "other" }] })
    s.activity.turnEnded()
    s.outbox.turnEnded()
    s.pending.reject({ code: "agent_busy", message: "busy" })
    await settle()
    await settle()
    expect(s.calls).toHaveLength(2)
    expect(s.outbox.queued).toEqual([])
    expect(s.agent.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "question" }] })
  } finally {
    await s.dispose()
  }
})

test("fragmented held drops restore original folded/image parts and repeated text only once", async () => {
  const s = fixture(false)
  const firstParts: EditorPart[] = [{ paste: "FIRST-HELD\nsecond line" }]
  const queuedParts: EditorPart[] = ["MIDDLE-QUEUED"]
  const imageParts: EditorPart[] = [
    "SECOND-HELD",
    { image: { name: "held.png", data: "aW1hZ2U=", mimeType: "image/png" } },
  ]
  const repeatedParts: EditorPart[] = [{ paste: "SECOND-HELD" }]
  const drop = (message: Outgoing) => {
    const prompt = toPrompt(message)
    return s.outbox.steer(
      typeof prompt === "string" ? { role: "user", content: [{ type: "text", text: prompt }] } : prompt,
      "dropped",
      false,
    )
  }
  try {
    s.activity.startCompaction(false)
    const first = s.outbox.prepare("FIRST-HELD\nsecond line", firstParts, "folded first")
    s.outbox.dispatch(first, firstParts, "queue")
    const queued = s.outbox.prepare("MIDDLE-QUEUED", queuedParts)
    s.outbox.dispatch(queued, queuedParts, "queue")
    const second = s.outbox.prepare("SECOND-HELD", imageParts, "image second")
    s.outbox.dispatch(second, imageParts, "steer")
    const repeated = s.outbox.prepare("SECOND-HELD", repeatedParts, "folded repeated")
    s.outbox.dispatch(repeated, repeatedParts, "steer")
    s.editor.setParts(["NEWER-DRAFT"])
    expect(drop(first)).toBe(false)
    await settle()
    expect(s.editor.getParts()).toEqual(["NEWER-DRAFT"])
    expect(drop(second)).toBe(false)
    await settle()
    expect(s.editor.getParts()).toEqual(["NEWER-DRAFT"])
    expect(drop(repeated)).toBe(true)
    const expected = new Editor()
    expected.setParts([
      ...firstParts,
      "\n\n",
      ...queuedParts,
      "\n\n",
      ...imageParts,
      "\n\n",
      ...repeatedParts,
      "\n\n",
      "NEWER-DRAFT",
    ])
    expect(s.editor.getParts()).toEqual(expected.getParts())
    s.pending.reject(new Error("late disconnect after drop"))
    await settle()
    expect(s.editor.getParts()).toEqual(expected.getParts())
  } finally {
    await s.dispose()
  }
})

test("reset restores a partially received held batch once before late admission failures", async () => {
  const s = fixture(false)
  try {
    s.activity.startCompaction(false)
    for (const text of ["FIRST", "SECOND"]) {
      const message = s.outbox.prepare(text, [text])
      s.outbox.dispatch(message, [text], "steer")
    }
    s.editor.setParts(["draft"])
    expect(
      s.outbox.steer({ role: "user", content: [{ type: "text", text: "FIRST" }] }, "dropped", false),
    ).toBe(false)
    s.outbox.reset()
    expect(s.editor.getText()).toBe("FIRST\n\nSECOND\n\ndraft")
    s.pending.reject(new Error("old admission failed"))
    await settle()
    expect(s.editor.getText()).toBe("FIRST\n\nSECOND\n\ndraft")
  } finally {
    await s.dispose()
  }
})

for (const state of ["dropped", "injected", "promoted"] as const) {
  for (const images of [false, true]) {
    test(`ordinary ${state} steering ${images ? "with images" : "with text"} ignores a later admission rejection`, async () => {
      const s = fixture(false)
      const parts: EditorPart[] = images
        ? ["before", { image: { name: "steer.png", data: "aW1hZ2U=", mimeType: "image/png" } }, "after"]
        : ["beforeafter"]
      try {
        s.activity.beginSend()
        const outgoing = s.outbox.prepare("beforeafter", parts, "folded steer")
        s.outbox.dispatch(outgoing, parts, "steer")
        const input = toPrompt(outgoing)
        const message =
          typeof input === "string"
            ? { role: "user" as const, content: [{ type: "text" as const, text: input }] }
            : input
        s.outbox.steer(message, "queued", true)
        s.outbox.steer(message, state, true)
        expect(s.editor.getParts()).toEqual(state === "dropped" ? parts : [])
        s.pending.reject(new Error("Disconnected after authoritative steering event"))
        await settle()
        expect(s.editor.getParts()).toEqual(state === "dropped" ? parts : [])
        expect(s.notices).toEqual([])
      } finally {
        await s.dispose()
      }
    })
  }
}

test("queued steering waits for its authoritative drop instead of restoring on a lost acknowledgement", async () => {
  const s = fixture(false)
  const parts: EditorPart[] = [
    "before",
    { image: { name: "queued.png", data: "aW1hZ2U=", mimeType: "image/png" } },
    "after",
  ]
  try {
    s.activity.beginSend()
    const outgoing = s.outbox.prepare("beforeafter", parts, "folded steer")
    s.outbox.dispatch(outgoing, parts, "steer")
    const input = toPrompt(outgoing)
    if (typeof input === "string") throw new Error("expected rich message")
    s.outbox.steer(input, "queued", true)
    s.pending.reject(new Error("lost acknowledgement"))
    await settle()
    expect(s.editor.getParts()).toEqual([])
    s.outbox.steer(input, "dropped", true)
    expect(s.editor.getParts()).toEqual(parts)
    expect(s.notices).toEqual([])
  } finally {
    await s.dispose()
  }
})

test("an ordinary drop without a queued announcement still reconciles the image admission", async () => {
  const s = fixture(false)
  const parts: EditorPart[] = [
    "before",
    { image: { name: "drop.png", data: "aW1hZ2U=", mimeType: "image/png" } },
    "after",
  ]
  try {
    s.activity.beginSend()
    const outgoing = s.outbox.prepare("beforeafter", parts, "folded steer")
    s.outbox.dispatch(outgoing, parts, "steer")
    const input = toPrompt(outgoing)
    if (typeof input === "string") throw new Error("expected rich message")
    s.outbox.steer(input, "dropped", true)
    s.pending.reject(new Error("late rejection"))
    await settle()
    expect(s.editor.getParts()).toEqual(parts)
    expect(s.notices).toEqual([])
  } finally {
    await s.dispose()
  }
})

for (const matches of [false, true]) {
  test(`approval-owned interrupt ${matches ? "scopes its host operation" : "does not touch another turn"}`, async () => {
    const s = fixture(false)
    const turn = s.agent.prompt("active turn")
    const turnId = s.agent.turnId!
    s.activity.beginSend()
    try {
      s.outbox.interrupt(matches ? turnId : "old-turn")
      expect(s.calls).toEqual(matches ? [{ operation: "turn.abort", params: { turnId }, generation: 1 }] : [])
    } finally {
      await turn
      await s.dispose()
    }
  })
}

for (const terminal of [undefined, "injected", "dropped"] as const) {
  test(`steering correlation includes image bytes and names when text matches (${terminal ?? "queued"})`, async () => {
    const s = fixture(false)
    const a: EditorPart[] = ["same", { image: { name: "a.png", data: "YQ==", mimeType: "image/png" } }]
    const b: EditorPart[] = ["same", { image: { name: "b.png", data: "Yg==", mimeType: "image/png" } }]
    try {
      s.activity.beginSend()
      const first = s.outbox.prepare("same", a, "folded")
      const second = s.outbox.prepare("same", b, "folded")
      s.outbox.dispatch(first, a, "steer")
      s.outbox.dispatch(second, b, "steer")
      const input = toPrompt(second)
      if (typeof input === "string") throw new Error("expected image message")
      s.outbox.steer(input, "queued", true)
      if (terminal) s.outbox.steer(input, terminal, true)
      s.pending.reject(new Error("first message was not admitted"))
      await settle()
      const expected = new Editor()
      expected.setParts(terminal === "dropped" ? [...a, "\n\n", ...b] : a)
      expect(s.editor.getParts()).toEqual(expected.getParts())
      expect(s.notices).toEqual(["first message was not admitted"])
    } finally {
      await s.dispose()
    }
  })
}

test("a late abort rejection cannot print into a replacement turn", async () => {
  const s = fixture(false)
  const first = s.agent.prompt("first")
  try {
    s.outbox.interrupt()
    await first
    const second = s.agent.prompt("second")
    s.pending.reject(new Error("old abort failed"))
    await settle()
    expect(s.notices).toEqual([])
    await second
  } finally {
    await s.dispose()
  }
})

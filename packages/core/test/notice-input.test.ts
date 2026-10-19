import { expect, test } from "bun:test"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { noticeInputAgents, noticeInputSnapshot, subscribeNoticeInputs } from "../src/agent/notice-input.ts"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"

function fixture() {
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const bus = new EventBus()
  const make = (sessionId: string, ownerBus = bus) =>
    new Agent({
      ai,
      model: ai.model("mock/test"),
      cwd: process.cwd(),
      systemPrompt: "",
      sessionId,
      bus: ownerBus,
    })
  return { bus, make }
}

test("bus notice capture bootstraps existing owners, excludes private buses, and unregisters disposed inboxes", async () => {
  const f = fixture()
  const root = f.make("root")
  const child = f.make("child")
  const privateAgent = f.make("private", new EventBus())
  const message = userMessage("already queued")
  child.expectNotice().deliver(message, { wake: false })
  const changes: [string, number, number][] = []
  const off = subscribeNoticeInputs(f.bus, (agent, snapshot) => {
    expect(noticeInputSnapshot(agent)).toEqual(snapshot)
    changes.push([agent.sessionId, snapshot.queue.length, snapshot.expected])
  })
  try {
    expect(noticeInputAgents(f.bus)).toEqual([root, child])
    expect(noticeInputSnapshot(child).queue).toMatchObject([{ message }])
    const pending = child.expectNotice()
    pending.deliver(userMessage("second"), { wake: false })
    privateAgent.expectNotice().deliver(userMessage("must stay private"), { wake: false })
    expect(changes).toEqual([
      ["child", 1, 1],
      ["child", 1, 0],
      ["child", 2, 0],
    ])
    expect(child.takeNotices()).toHaveLength(2)
    expect(changes.at(-1)).toEqual(["child", 0, 0])
    expect(noticeInputAgents(f.bus)).toEqual([root, child])
    await child.dispose()
    expect(noticeInputAgents(f.bus)).toEqual([root])
    off()
    const count = changes.length
    root.expectNotice().cancel()
    expect(changes).toHaveLength(count)
  } finally {
    off()
    await Promise.all([root.dispose(), child.dispose(), privateAgent.dispose()])
  }
})

test("a same-session replacement owns bus bootstrap and observer failures cannot reject inbox changes", async () => {
  const f = fixture()
  const old = f.make("same-session")
  const next = f.make("same-session")
  const failure = new Error("host capture failure")
  const errors: unknown[] = []
  const off = subscribeNoticeInputs(
    f.bus,
    () => {
      throw failure
    },
    (error) => errors.push(error),
  )
  try {
    expect(noticeInputAgents(f.bus)).toEqual([next])
    expect(() => next.expectNotice().deliver(userMessage("admitted"), { wake: false })).not.toThrow()
    expect(next.waitingNotices).toBe(1)
    expect(errors).toEqual([failure, failure, failure])
    await old.dispose("switch")
    expect(noticeInputAgents(f.bus)).toEqual([next])
  } finally {
    off()
    await Promise.all([old.dispose(), next.dispose()])
  }
})

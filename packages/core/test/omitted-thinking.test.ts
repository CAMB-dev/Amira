import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import {
  anthropicResponse,
  blockDelta,
  blockStart,
  blockStop,
  messageDelta,
  messageStart,
  messageStop,
  textReply,
} from "../../ai/test/anthropic-helpers.ts"
import { fakeFetch, type Seen } from "../../ai/test/helpers.ts"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"

test("omitted Anthropic thinking emits only structural timing and saves/replays its signature unchanged", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-omitted-thinking-"))
  const seen: Seen = {}
  let calls = 0
  const ai = createAi({
    fetch: fakeFetch(
      () =>
        anthropicResponse(
          calls++ === 0
            ? [
                messageStart(),
                blockStart(0, { type: "thinking", thinking: "", signature: "" }),
                blockDelta(0, { type: "thinking_delta", thinking: "" }),
                blockDelta(0, { type: "signature_delta", signature: "encrypted-signature" }),
                blockStop(0),
                blockStart(1, { type: "text", text: "" }),
                blockDelta(1, { type: "text_delta", text: "Answer." }),
                blockStop(1),
                messageDelta("end_turn"),
                messageStop,
              ]
            : textReply("Next answer."),
        ),
      seen,
    ),
    providers: [
      {
        id: "anth",
        dialect: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        compat: { thinkingDisplay: "omitted" },
        defaultModel: { caps: { thinking: true } },
      },
    ],
    retry: { retries: 0 },
  })
  const session = SessionStore.create({ cwd: dir, dir })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => {
    events.push(event)
  })
  const agent = new Agent({
    ai,
    model: ai.model("anth/claude-sonnet-5-5"),
    cwd: dir,
    systemPrompt: "",
    thinking: "high",
    session,
    bus,
  })
  let resumed: Agent | undefined
  try {
    expect((await agent.prompt("hello")).reason).toBe("done")
    await bus.flush()
    expect(events.some((e) => e.type === "message.delta" && "text" in e.data && !e.data.text)).toBe(false)
    expect(events.filter((e) => e.type === "message.stream").map((e) => e.data.kind)).toEqual([
      "request",
      "contentStart",
      "thinkingStart",
      "thinkingEnd",
      "contentStart",
      "end",
    ])
    await agent.dispose()
    const saved = SessionStore.open(session.file)
    const entry = saved.branch().find((e) => e.type === "message" && e.message.role === "assistant")
    expect(entry?.type === "message" ? entry.message.content[0] : undefined).toMatchObject({
      type: "thinking",
      text: "",
      signature: { dialect: "anthropic-messages", value: "encrypted-signature" },
    })
    resumed = new Agent({
      ai,
      model: ai.model("anth/claude-sonnet-5-5"),
      cwd: dir,
      systemPrompt: "",
      session: saved,
    })
    expect((await resumed.prompt("continue")).reason).toBe("done")
    const assistant = seen.body.messages.find((m: { role: string }) => m.role === "assistant")
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "", signature: "encrypted-signature" })
  } finally {
    await resumed?.dispose()
    await agent.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

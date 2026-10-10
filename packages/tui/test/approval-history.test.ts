import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent, EventBus, Permissions, SessionStore } from "@amira/core"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { historyLines } from "../src/history.ts"
import { finishedToolLines } from "../src/tool-view.ts"

test("denied approval keeps the live blocked styling after a session resumes without changing model history", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-approval-history-"))
  const requests: { messages: { role: string; content: unknown }[] }[] = []
  const ai = createAi({
    providers: [{ id: "test", dialect: "openai-chat", baseUrl: "https://model.test/v1" }],
    fetch: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const first = requests.length === 1
      const delta = first
        ? {
            tool_calls: [
              {
                index: 0,
                id: "c1",
                type: "function",
                function: { name: "publish", arguments: "{}" },
              },
            ],
          }
        : { content: "done" }
      const chunk = { choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    }) as typeof fetch,
  })
  const session = SessionStore.create({ cwd: dir, dir })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const options = { ai, model: ai.model("test/m"), cwd: dir, systemPrompt: "sys" }
  const agent = new Agent({
    ...options,
    session,
    bus,
    permissions: new Permissions({ mode: "edits" }),
    approve: async () => ({ approved: false, reason: "the user said no" }),
  })
  let resumed: Agent | undefined
  let ran = false
  agent.tools.register(
    defineTool({
      name: "publish",
      description: "publish",
      parameters: { type: "object", properties: {} },
      traits: { readOnly: true },
      execute: async () => {
        ran = true
        return textResult("published")
      },
    }),
    "test",
  )
  // An extension asks for approval, so the result text stays independent of shell policy details.
  agent.interceptors.add("tool.call.before", async () => ({ action: "ask", reason: "publish?" }))
  try {
    await agent.prompt("publish")
    await bus.flush()
    expect(ran).toBe(false)
    const end = events.find((event) => event.type === "tool.execute.end")
    if (end?.type !== "tool.execute.end") throw new Error("Missing tool execution end")
    const live = finishedToolLines(
      defaultTheme,
      undefined,
      { name: end.data.name, args: {}, result: end.data.result, rejected: end.data.rejected },
      "summary",
      80,
      { last: true },
    )
    expect(live.map(stripAnsi)).toEqual(["  └ publish  ⊘ Tool call not approved: the user said no"])
    expect(live[0]).toContain(defaultTheme.muted("publish"))
    expect(live[0]).toBe(
      `  ${defaultTheme.muted("└")} ${defaultTheme.muted("publish")}  ${defaultTheme.muted("⊘ Tool call not approved: the user said no")}${defaultTheme.muted("")}`,
    )

    await agent.dispose("switch")
    resumed = new Agent({ ...options, session: SessionStore.open(session.file) })
    const history = historyLines(defaultTheme, resumed.messages, { width: 80 })
    const toolRow = history.findIndex(
      (line) => stripAnsi(line) === "  └ publish  ⊘ Tool call not approved: the user said no",
    )
    expect(history.slice(toolRow, toolRow + live.length)).toEqual(live)
    expect(resumed.messages.find((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
      rejected: "blocked",
    })

    await resumed.prompt("continue")
    const expected = { role: "tool", tool_call_id: "c1", content: "Tool call not approved: the user said no" }
    expect(requests[1]!.messages.find((message) => message.role === "tool")).toEqual(expected)
    expect(requests[2]!.messages.find((message) => message.role === "tool")).toEqual(expected)
  } finally {
    await resumed?.dispose("exit")
    await agent.dispose("exit")
    await rm(dir, { recursive: true, force: true })
  }
})

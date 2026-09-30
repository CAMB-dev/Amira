import { expect, test } from "bun:test"
import {
  type AssistantMessage,
  createAi,
  type Dialect,
  type ServerToolBlock,
  type StreamEvent,
} from "@amira/ai"
import { type PrintIO, runPrint } from "../src/print.ts"
import { createSession } from "../src/session.ts"

// Print mode with a reply that searched on the provider's side and cites what it found.

const search: ServerToolBlock = {
  type: "serverTool",
  id: "ws_1",
  name: "web_search",
  input: { type: "search", query: "node lts" },
  status: "done",
}
const url = "https://nodejs.org/en/download"

const searching: Dialect = {
  id: "searching",
  async *stream(req): AsyncGenerator<StreamEvent> {
    yield { type: "start" }
    yield { type: "serverTool", block: { ...search, status: "running" } }
    yield { type: "serverTool", block: search }
    yield { type: "text.delta", text: "v24 is the LTS." }
    const message: AssistantMessage = {
      role: "assistant",
      model: { provider: req.model.provider, model: req.model.id },
      content: [
        search,
        {
          type: "text",
          text: "v24 is the LTS.",
          citations: [{ url, title: "Download Node.js", start: 0, end: 3 }],
        },
      ],
      stopReason: "end",
    }
    yield { type: "done", message }
  },
}

async function session() {
  const ai = createAi({
    dialects: [searching],
    providers: [{ id: "p", dialect: "searching", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
  })
  return createSession({ model: "p/m", cwd: import.meta.dir, extensions: [], noBuiltins: true, ai })
}

function capture(): PrintIO & { out: string; err: string } {
  const c = {
    out: "",
    err: "",
    stdout: (s: string) => {
      c.out += s
    },
    stderr: (s: string) => {
      c.err += s
    },
  }
  return c
}

test("plain print mode shows the search on stderr and the cited sources after the reply", async () => {
  const { agent } = await session()
  const io = capture()
  expect(await runPrint(agent, "which node?", false, { io })).toBe(0)
  expect(io.err).toBe('● Web search: "node lts"\n')
  expect(io.out).toBe(`v24 is the LTS.\n\nSources:\n- Download Node.js: ${url}\n`)
})

test("JSON print mode keeps the server tool block and the citations in the events", async () => {
  const { agent } = await session()
  const io = capture()
  expect(await runPrint(agent, "which node?", true, { io })).toBe(0)
  const events = io.out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
  const deltas = events.filter((e) => e.type === "message.delta" && e.data.kind === "serverTool")
  expect(deltas.map((e) => e.data.block.status)).toEqual(["running", "done"])
  const end = events.find((e) => e.type === "message.end")
  expect(end.data.message.content[0].type).toBe("serverTool")
  expect(end.data.message.content[1].citations).toEqual([
    { url, title: "Download Node.js", start: 0, end: 3 },
  ])
})

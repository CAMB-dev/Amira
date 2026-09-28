import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type MockStep } from "@amira/ai"
import type { Extension } from "@amira/api"
import { type PrintIO, runPrint } from "../src/print.ts"
import { runRpc } from "../src/rpc.ts"
import { COMMAND_PARAMS, rpcSchema } from "../src/rpc-schema.ts"
import { createSession } from "../src/session.ts"
import rpcTools from "./fixtures/rpc-tools.ts"

const here = import.meta.dir
const main = path.join(here, "..", "src", "main.ts")

type Line = Record<string, any>

/** Drives `amira --rpc` as a child process, the way a real client would. */
function spawnRpc(replies: MockReply[]) {
  const p = Bun.spawn(
    [
      "bun",
      main,
      "--rpc",
      "-m",
      "mock/m",
      "--no-builtins",
      "-e",
      path.join(here, "fixtures", "rpc-tools.ts"),
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AMIRA_TEST_MOCK: JSON.stringify(replies) },
    },
  )
  const lines: Line[] = []
  const raw: string[] = []
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of p.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        raw.push(buffer.slice(0, nl))
        lines.push(JSON.parse(buffer.slice(0, nl)))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
      }
    }
  })()
  const send = (cmd: unknown) => {
    p.stdin.write(typeof cmd === "string" ? `${cmd}\n` : `${JSON.stringify(cmd)}\n`)
    p.stdin.flush()
  }
  const waitFor = async (match: (l: Line) => boolean, what: string, timeoutMs = 20_000) => {
    const deadline = performance.now() + timeoutMs
    while (true) {
      const found = lines.find(match)
      if (found) return found
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}\n${raw.join("\n")}`)
      await Bun.sleep(10)
    }
  }
  const response = (id: unknown) => waitFor((l) => l.id === id && "ok" in l, `response ${id}`)
  const event = (type: string, after = 0) =>
    waitFor((l) => l.type === type && l.seq > after, `event ${type} after ${after}`)
  const close = async () => {
    p.stdin.end()
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    await reading
    return { code, err }
  }
  return { send, response, event, waitFor, lines, close }
}

test("amira --rpc: prompt, steer, ui.respond, reads and errors, end to end", async () => {
  const rpc = spawnRpc([
    { toolCalls: [{ name: "wait", args: { ms: 400 } }] },
    { text: "done" },
    { toolCalls: [{ name: "ask", args: {} }] },
    { text: "asked" },
  ])
  await rpc.event("session.start")

  rpc.send("this is not json")
  expect((await rpc.response(null)).error.code).toBe("parse_error")
  rpc.send({ id: "u", cmd: "nope" })
  expect((await rpc.response("u")).error.code).toBe("unknown_command")
  rpc.send({ id: "bad", cmd: "prompt" })
  expect((await rpc.response("bad")).error.code).toBe("invalid_params")

  // prompt answers with the turn id before the turn's first event.
  rpc.send({ id: 1, cmd: "prompt", text: "go" })
  const started = await rpc.response(1)
  expect(started.ok).toBe(true)
  const turnStart = await rpc.event("turn.start")
  expect(turnStart.turnId).toBe(started.turnId)
  expect(rpc.lines.indexOf(started)).toBeLessThan(rpc.lines.indexOf(turnStart))

  // Steering while the tool runs lands after its result, before the next model call.
  const toolStart = await rpc.event("tool.execute.start")
  rpc.send({ id: 2, cmd: "steer", text: "also B" })
  expect(await rpc.response(2)).toMatchObject({ ok: true, queued: true, turnId: started.turnId })
  rpc.send({ id: 3, cmd: "prompt", text: "too early" })
  expect((await rpc.response(3)).error.code).toBe("busy")
  const injected = await rpc.waitFor(
    (l) => l.type === "turn.steer" && l.data.state === "injected",
    "injected",
  )
  const toolEnd = await rpc.event("tool.execute.end")
  expect(toolEnd.seq).toBeLessThan(injected.seq)
  const end = await rpc.event("turn.end", toolStart.seq)
  expect(end.data.reason).toBe("done")

  rpc.send({ id: 4, cmd: "session.read", what: "lastTurn" })
  const last = await rpc.response(4)
  expect(last).toMatchObject({ ok: true, turnId: started.turnId, reason: "done", text: "done" })
  expect(last.messages.map((m: Line) => m.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
    "user",
    "assistant",
  ])
  expect(last.messages[3].content[0].text).toBe("also B")

  rpc.send({ id: 5, cmd: "state" })
  expect(await rpc.response(5)).toMatchObject({
    ok: true,
    status: "idle",
    model: "mock/m",
    messages: 5,
    lastAssistantText: "done",
    uiRequests: [],
  })

  // A dialog from a tool is answered by the client.
  rpc.send({ id: 6, cmd: "prompt", text: "ask me" })
  const asked = await rpc.event("ui.request")
  expect(asked.data).toMatchObject({ kind: "confirm", title: "Deploy?", message: "to production" })
  rpc.send({ id: 7, cmd: "ui.respond", requestId: asked.data.requestId, value: "yes" })
  expect((await rpc.response(7)).error.code).toBe("invalid_params")
  rpc.send({ id: 8, cmd: "ui.respond", requestId: asked.data.requestId, value: true })
  expect((await rpc.response(8)).ok).toBe(true)
  rpc.send({ id: 9, cmd: "ui.respond", requestId: asked.data.requestId, value: true })
  expect((await rpc.response(9)).error.code).toBe("not_found")
  await rpc.event("turn.end", asked.seq)
  rpc.send({ id: 10, cmd: "session.read", what: "lastTurn" })
  const second = await rpc.response(10)
  expect(second.messages[2].content[0].text).toBe("answer: true")
  expect(second.text).toBe("asked")

  rpc.send({ id: 11, cmd: "model.set", model: "mock/other" })
  expect(await rpc.response(11)).toMatchObject({ ok: true, model: "mock/other" })
  rpc.send({ id: 12, cmd: "model.set", model: "nope" })
  expect((await rpc.response(12)).error.code).toBe("invalid_params")
  rpc.send({ id: 13, cmd: "session.resume", sessionId: "s_1" })
  expect((await rpc.response(13)).error.code).toBe("not_supported")
  rpc.send({ id: 14, cmd: "session.read", what: "messages" })
  expect((await rpc.response(14)).messages.length).toBe(9)

  const { code, err } = await rpc.close()
  expect(code).toBe(0)
  expect(err).toBe("")

  // Everything on stdout is a response or an event the schema describes.
  const schema = rpcSchema() as any
  const known = new Set(schema.$defs.Event.anyOf.flatMap((e: any) => e.properties.type.enum ?? []))
  for (const l of rpc.lines) {
    if ("ok" in l) expect(typeof l.ok).toBe("boolean")
    else expect(known.has(l.type)).toBe(true)
  }
}, 60_000)

test("amira --rpc-schema prints a JSON Schema covering every command", async () => {
  const p = Bun.spawn(["bun", main, "--rpc-schema"], { stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  expect(code).toBe(0)
  const schema = JSON.parse(out)
  expect(schema.$schema).toContain("json-schema.org")
  const commands = schema.$defs.Command.oneOf.map((c: any) => c.properties.cmd.enum[0])
  expect(commands.sort()).toEqual(
    ["abort", "model.set", "prompt", "session.read", "session.resume", "state", "steer", "ui.respond"].sort(),
  )
  expect(Object.keys(COMMAND_PARAMS).sort()).toEqual(commands)
  // Every $ref points at a definition.
  for (const ref of out.match(/"#\/\$defs\/(\w+)"/g) ?? []) {
    expect(schema.$defs[ref.slice(9, -1)]).toBeDefined()
  }
}, 60_000)

/** A line source a test can push commands into. */
function channel() {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let ended = false
  const lines: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) yield queue.shift()!
        else if (ended) return
        else await new Promise<void>((r) => (wake = r))
      }
    },
  }
  return {
    lines,
    push: (cmd: unknown) => {
      queue.push(JSON.stringify(cmd))
      wake?.()
    },
    end: () => {
      ended = true
      wake?.()
    },
  }
}

async function session(steps: MockStep[], extensions: Extension[] = []) {
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  return createSession({
    model: "mock/m",
    cwd: here,
    extensions: [],
    noBuiltins: extensions.length === 0,
    ai,
    builtins: async () => extensions.map((extension, i) => ({ source: `ext${i}`, extension })),
  })
}

test("a slow client loses deltas, gets events.lost, and can resync with state", async () => {
  const s = await session([{ text: "x".repeat(4000) }])
  const input = channel()
  const out: Line[] = []
  const done = runRpc(
    { agent: s.agent, ai: s.ai, ui: s.host.ui },
    {
      io: {
        lines: input.lines,
        write: async (line) => {
          out.push(JSON.parse(line))
          await Bun.sleep(1)
        },
      },
      maxQueue: 20,
    },
  )
  input.push({ id: 1, cmd: "prompt", text: "go" })
  while (!out.some((l) => l.type === "turn.end")) await Bun.sleep(5)
  const lost = out.find((l) => l.type === "events.lost")
  expect(lost?.data.dropped).toBeGreaterThan(0)
  const deltas = out.filter((l) => l.type === "message.delta").length
  expect(deltas).toBeLessThan(500)
  expect(out.some((l) => l.type === "message.end")).toBe(true)
  input.push({ id: 2, cmd: "state" })
  input.end()
  expect(await done).toBe(0)
  expect(out.find((l) => l.id === 2)).toMatchObject({ status: "idle", lastAssistantText: "x".repeat(4000) })
})

test("amira --rpc drops deltas when the client stops reading stdout", async () => {
  const total = 100_000
  // Bun.spawn reads a child's pipe eagerly, so only node's paused stream leaves it full.
  const p = spawn("bun", [main, "--rpc", "-m", "mock/m", "--no-builtins"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AMIRA_TEST_MOCK: JSON.stringify([{ text: "x".repeat(total * 8) }]) },
  })
  p.stdout.pause()
  let err = ""
  p.stderr.on("data", (c: Buffer) => {
    err += c.toString()
  })
  p.stdin.write(`${JSON.stringify({ id: 1, cmd: "prompt", text: "go" })}\n`)
  await Bun.sleep(4000)
  // While the client ignores stdout, the process still answers (its main thread is free).
  p.stdin.write(`${JSON.stringify({ id: 2, cmd: "state" })}\n`)
  const out: Line[] = []
  let buffer = ""
  const exited = new Promise<number | null>((r) => p.on("close", r))
  p.stdout.on("data", (c: Buffer) => {
    buffer += c.toString()
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      out.push(JSON.parse(buffer.slice(0, nl)))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf("\n")
    }
    if (out.some((l) => l.type === "turn.end") && out.some((l) => l.id === 2)) p.stdin.end()
  })
  p.stdout.resume()
  expect(await exited).toBe(0)
  expect(err).toBe("")
  const deltas = out.filter((l) => l.type === "message.delta").length
  const lost = out.filter((l) => l.type === "events.lost")
  expect(lost.length).toBeGreaterThan(0)
  expect(lost.reduce((n, l) => n + l.data.dropped, 0)).toBeGreaterThan(0)
  expect(deltas).toBeLessThan(total)
  expect(out.find((l) => l.type === "turn.end")?.data.reason).toBe("done")
  expect(out.find((l) => l.id === 2)?.ok).toBe(true)
}, 90_000)

test("closing stdin waits for the running turn and cancels dialogs nobody can answer", async () => {
  const s = await session(
    [{ toolCalls: [{ name: "ask", args: {} }] }, { text: "bye", delayMs: 5 }],
    [rpcTools],
  )
  const input = channel()
  const out: Line[] = []
  const done = runRpc(
    { agent: s.agent, ai: s.ai, ui: s.host.ui },
    { io: { lines: input.lines, write: (line) => void out.push(JSON.parse(line)) } },
  )
  input.push({ id: 1, cmd: "prompt", text: "go" })
  input.end()
  expect(await done).toBe(0)
  expect(out.find((l) => l.type === "ui.resolved")?.data.cancelled).toBe(true)
  expect(out.at(-1)?.type).toBe("status.changed")
  expect(s.agent.messages.at(-1)).toMatchObject({ role: "assistant" })
})

test("print mode cancels dialogs with a note on stderr", async () => {
  const s = await session([{ toolCalls: [{ name: "ask", args: {} }] }, { text: "ok" }], [rpcTools])
  const errors: string[] = []
  const io: PrintIO = { stdout: () => {}, stderr: (t) => void errors.push(t) }
  expect(await runPrint(s.agent, "go", false, { io, ui: s.host.ui })).toBe(0)
  expect(errors.join("")).toContain('cancelled "Deploy?"')
  const result = s.agent.messages.find((m) => m.role === "toolResult")
  expect(result?.content[0]).toEqual({ type: "text", text: "answer: false" })
})

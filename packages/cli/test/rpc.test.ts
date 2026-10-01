import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type MockStep, userMessage } from "@amira/ai"
import type { Extension } from "@amira/api"
import { type PrintIO, runPrint } from "../src/print.ts"
import { runRpc } from "../src/rpc.ts"
import { COMMAND_PARAMS, rpcSchema } from "../src/rpc-schema.ts"
import { createSession } from "../src/session.ts"
import rpcTools from "./fixtures/rpc-tools.ts"

const here = import.meta.dir
const main = path.join(here, "..", "src", "main.ts")

type Line = Record<string, any>

/** Drives `amira --rpc` as a child process, the way a real client would. Sessions go to `home`. */
function spawnRpc(
  replies: MockReply[],
  home = mkdtempSync(path.join(os.tmpdir(), "amira-rpc-home-")),
  extraArgs: string[] = [],
) {
  const settingsFile = path.join(home, "settings.json")
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {}
  writeFileSync(settingsFile, JSON.stringify({ ...settings, sessions: { autoTitle: false } }))
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
      ...extraArgs,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AMIRA_TEST_MOCK: JSON.stringify(replies), AMIRA_HOME: home },
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
  expect((await rpc.response(13)).error.code).toBe("not_found")
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

test("amira --rpc: session.resume continues a stored session on the same connection", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-rpc-home-"))
  const first = spawnRpc([{ text: "first answer" }], home)
  const started = await first.event("session.start")
  first.send({ id: 1, cmd: "prompt", text: "remember me" })
  await first.response(1)
  await first.event("turn.end")
  expect((await first.close()).code).toBe(0)
  const storedId = started.sessionId

  const second = spawnRpc([{ text: "second answer" }], home)
  const fresh = await second.event("session.start")
  expect(fresh.sessionId).not.toBe(storedId)
  second.send({ id: 1, cmd: "session.resume", sessionId: storedId })
  expect(await second.response(1)).toMatchObject({ ok: true, sessionId: storedId })
  const resumed = await second.waitFor(
    (l) => l.type === "session.start" && l.data.reason === "resume",
    "resumed session.start",
  )
  expect(resumed.sessionId).toBe(storedId)
  second.send({ id: 2, cmd: "state" })
  expect(await second.response(2)).toMatchObject({ sessionId: storedId, messages: 2 })
  second.send({ id: 3, cmd: "prompt", text: "and now?" })
  await second.response(3)
  await second.waitFor((l) => l.type === "turn.end" && l.sessionId === storedId, "turn.end")
  second.send({ id: 4, cmd: "session.read", what: "messages" })
  const texts = (await second.response(4)).messages.map((m: Line) => m.content[0].text)
  expect(texts).toEqual(["remember me", "first answer", "and now?", "second answer"])
  expect((await second.close()).code).toBe(0)
}, 60_000)

test("amira --rpc: rename and fork preserve the original and expose session operations", async () => {
  const rpc = spawnRpc([{ text: "first answer" }, { text: "second answer" }])
  const start = await rpc.event("session.start")
  rpc.send({ id: "rename", cmd: "session.rename", title: "Database repair" })
  expect(await rpc.response("rename")).toMatchObject({ ok: true, title: "Database repair" })
  expect((await rpc.event("session.title")).data.title).toBe("Database repair")
  rpc.send({ id: "first", cmd: "prompt", text: "first question" })
  await rpc.response("first")
  const first = await rpc.event("turn.end")
  rpc.send({ id: "second", cmd: "prompt", text: "second question" })
  await rpc.response("second")
  await rpc.event("turn.end", first.seq)
  rpc.send({ id: "invalid", cmd: "session.fork", index: -1 })
  expect((await rpc.response("invalid")).error.code).toBe("invalid_params")
  rpc.send({ id: "fork", cmd: "session.fork", index: 2 })
  const fork = await rpc.response("fork")
  expect(fork.ok).toBe(true)
  expect(fork.sessionId).not.toBe(start.sessionId)
  expect(
    (await rpc.waitFor((l) => l.type === "session.start" && l.sessionId === fork.sessionId, "fork start"))
      .data.reason,
  ).toBe("fork")
  rpc.send({ id: "state", cmd: "state" })
  expect((await rpc.response("state")).messages).toBe(2)
  rpc.send({ id: "resume", cmd: "session.resume", sessionId: start.sessionId })
  expect((await rpc.response("resume")).ok).toBe(true)
  rpc.send({ id: "original", cmd: "state" })
  expect((await rpc.response("original")).messages).toBe(4)
  expect((await rpc.close()).code).toBe(0)
}, 60_000)

test("amira --rpc: slash commands list, complete and run, and may ask questions", async () => {
  const commandsExt = path.join(here, "..", "..", "..", "extensions", "commands", "src", "index.ts")
  const rpc = spawnRpc([{ text: "hello" }], undefined, ["-e", commandsExt])
  const started = await rpc.event("session.start")

  rpc.send({ id: 1, cmd: "command.list" })
  const names = (await rpc.response(1)).commands.map((c: Line) => c.name)
  expect(names).toContain("status")
  expect(names).toContain("cost")
  rpc.send({ id: 2, cmd: "command.complete", text: "/sta" })
  expect((await rpc.response(2)).candidates[0]).toMatchObject({ value: "status" })

  rpc.send({ id: 3, cmd: "prompt", text: "hi" })
  await rpc.event("turn.end")
  rpc.send({ id: 4, cmd: "command.run", text: "/cost" })
  const cost = await rpc.response(4)
  expect(cost).toMatchObject({ ok: true, command: "cost" })
  expect(cost.output[0]).toContain("mock/m")
  expect((await rpc.event("command.output")).data).toMatchObject({ command: "cost", level: "info" })

  // /model without an argument asks; the answer arrives while command.run is still pending.
  rpc.send({ id: 5, cmd: "command.run", text: "/model" })
  const ask = await rpc.event("ui.request")
  expect(ask.data.options).toContain("mock/m")
  rpc.send({ id: 6, cmd: "ui.respond", requestId: ask.data.requestId, value: "mock/m" })
  expect(await rpc.response(5)).toMatchObject({ ok: true, output: ["Model: mock/m"] })

  rpc.send({ id: 7, cmd: "command.run", text: "/nope" })
  expect((await rpc.response(7)).error.code).toBe("not_found")
  rpc.send({ id: 71, cmd: "command.run", text: "/usage" })
  expect(await rpc.response(71)).toMatchObject({ ok: true, command: "cost" })
  rpc.send({ id: 8, cmd: "command.run", text: "/tools enable nope" })
  expect((await rpc.response(8)).error).toEqual({ code: "command_failed", message: 'no tool named "nope"' })

  // /clear starts a new session, and the rpc frontend follows it.
  rpc.send({ id: 9, cmd: "command.run", text: "/clear" })
  await rpc.response(9)
  const cleared = await rpc.waitFor((l) => l.type === "session.start" && l.data.reason === "clear", "clear")
  expect(cleared.sessionId).not.toBe(started.sessionId)
  rpc.send({ id: 10, cmd: "state" })
  expect(await rpc.response(10)).toMatchObject({ sessionId: cleared.sessionId, messages: 0 })
  expect((await rpc.close()).code).toBe(0)
}, 60_000)

test("amira --rpc: skills are listed and run apart from the slash commands", async () => {
  const ext = (name: string) => path.join(here, "..", "..", "..", "extensions", name, "src", "index.ts")
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-rpc-home-"))
  mkdirSync(path.join(home, "skills", "rpc-deploy"), { recursive: true })
  writeFileSync(
    path.join(home, "skills", "rpc-deploy", "SKILL.md"),
    "---\nname: rpc-deploy\ndescription: Ship it\n---\nRun ./ship.sh\n",
  )
  const rpc = spawnRpc([{ text: "shipping" }], home, ["-e", ext("commands"), "-e", ext("skills")])
  await rpc.event("session.start")

  rpc.send({ id: 1, cmd: "skill.list" })
  const { skills } = await rpc.response(1)
  expect(skills.find((s: Line) => s.name === "rpc-deploy")).toEqual({
    name: "rpc-deploy",
    description: "Ship it",
    hint: "[arguments]",
    source: expect.stringMatching(/skills[/]src[/]index.ts$/),
  })
  rpc.send({ id: 2, cmd: "command.list" })
  expect((await rpc.response(2)).commands.map((c: Line) => c.name)).not.toContain("rpc-deploy")
  rpc.send({ id: 3, cmd: "command.run", text: "/rpc-deploy" })
  expect((await rpc.response(3)).error).toEqual({
    code: "not_found",
    message: "Unknown command /rpc-deploy — skills now start with $: $rpc-deploy",
  })

  rpc.send({ id: 4, cmd: "skill.run", name: "rpc-deploy", args: "to prod" })
  expect(await rpc.response(4)).toMatchObject({ ok: true, skill: "rpc-deploy", output: [] })
  await rpc.event("turn.end")
  rpc.send({ id: 5, cmd: "session.read", what: "messages" })
  const [prompt] = (await rpc.response(5)).messages
  expect(prompt.display).toEqual({ text: "$rpc-deploy to prod", note: "Loaded skill rpc-deploy (1 line)" })
  expect(prompt.content[0].text).toContain("Run ./ship.sh")
  expect(prompt.content[0].text).toContain("Arguments: to prod")

  rpc.send({ id: 6, cmd: "skill.run", name: "nope" })
  expect((await rpc.response(6)).error).toEqual({
    code: "not_found",
    message: "Unknown skill $nope. Type $ to list the skills.",
  })
  rpc.send({ id: 7, cmd: "skill.run", name: "two words" })
  expect((await rpc.response(7)).error.code).toBe("invalid_params")
  expect((await rpc.close()).code).toBe(0)
}, 60_000)

test("amira --rpc: settings aliases are listed, completed and run", async () => {
  const commandsExt = path.join(here, "..", "..", "..", "extensions", "commands", "src", "index.ts")
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-rpc-home-"))
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ commandAliases: { mm: "model mock/m", q: "status", ghost: "nope" } }),
  )
  const rpc = spawnRpc([], home, ["-e", commandsExt])
  const warning = await rpc.event("extension.error")
  expect(warning.data.error).toContain("commandAliases: /q is already an alias of /quit")

  rpc.send({ id: 1, cmd: "command.list" })
  const list = await rpc.response(1)
  expect(list.commands.find((c: Line) => c.name === "quit").aliases).toEqual(["exit", "q"])
  expect(list.aliases).toEqual([
    { name: "ghost", expansion: "nope" },
    { name: "mm", expansion: "model mock/m" },
  ])
  rpc.send({ id: 2, cmd: "command.complete", text: "/mm" })
  expect((await rpc.response(2)).candidates[0]).toMatchObject({ value: "mm", label: "mm → /model mock/m" })
  rpc.send({ id: 3, cmd: "command.run", text: "/mm" })
  expect(await rpc.response(3)).toMatchObject({ ok: true, command: "model", output: ["Model: mock/m"] })
  rpc.send({ id: 4, cmd: "command.run", text: "/ghost" })
  expect((await rpc.response(4)).error).toMatchObject({
    code: "not_found",
    message: expect.stringContaining("The alias /ghost runs /nope, which is not a command"),
  })
  expect((await rpc.close()).code).toBe(0)
}, 60_000)

test("amira --rpc-schema prints a JSON Schema covering every command", async () => {
  const p = Bun.spawn(["bun", main, "--rpc-schema"], { stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  expect(code).toBe(0)
  const schema = JSON.parse(out)
  expect(schema.$schema).toContain("json-schema.org")
  const commands = schema.$defs.Command.oneOf.map((c: any) => c.properties.cmd.enum[0])
  expect(commands.sort()).toEqual(
    [
      "abort",
      "command.complete",
      "command.list",
      "command.run",
      "model.set",
      "prompt",
      "session.read",
      "session.resume",
      "session.rename",
      "session.fork",
      "skill.list",
      "skill.run",
      "state",
      "steer",
      "ui.action",
      "ui.configure",
      "ui.focus",
      "ui.respond",
    ].sort(),
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

/** runRpc in process, with commands pushed and responses awaited by id. */
function inProcess(s: Awaited<ReturnType<typeof session>>) {
  const input = channel()
  const out: Line[] = []
  const done = runRpc(
    { agent: s.agent, ai: s.ai, ui: s.host.ui },
    { io: { lines: input.lines, write: (line) => void out.push(JSON.parse(line)) } },
  )
  const until = async (match: (l: Line) => boolean) => {
    while (!out.some(match)) await Bun.sleep(5)
    return out.find(match)!
  }
  const call = (cmd: Record<string, unknown>) => {
    input.push(cmd)
    return until((l) => l.id === cmd.id && "ok" in l)
  }
  const end = () => {
    input.end()
    return done
  }
  return { out, until, call, end }
}

test("session.read lastTurn survives history entries being replaced", async () => {
  const s = await session([{ text: "one" }, { text: "two" }])
  const rpc = inProcess(s)
  await rpc.call({ id: 1, cmd: "prompt", text: "first" })
  await rpc.until((l) => l.type === "turn.end")
  await rpc.call({ id: 2, cmd: "prompt", text: "second" })
  await rpc.until((l) => l.type === "turn.end" && l.turnId !== rpc.out.find((o) => o.id === 1)!.turnId)
  // A reload or compaction hands back equal but new message objects.
  s.agent.messages.splice(0, s.agent.messages.length, ...structuredClone(s.agent.messages))
  const last = await rpc.call({ id: 3, cmd: "session.read", what: "lastTurn" })
  expect(last).toMatchObject({ ok: true, reason: "done", text: "two" })
  expect(last.messages.map((m: Line) => m.content[0].text)).toEqual(["second", "two"])
  // A history shorter than the turn's start gives everything rather than nothing.
  s.agent.messages.splice(1)
  const short = await rpc.call({ id: 4, cmd: "session.read", what: "lastTurn" })
  expect(short.messages.map((m: Line) => m.content[0].text)).toEqual(["first"])
  expect(await rpc.end()).toBe(0)
})

test("prompt and steer take a display, which their events and session.read carry", async () => {
  const s = await session([{ text: "one", delayMs: 20 }, { text: "two" }])
  const rpc = inProcess(s)
  const bad = await rpc.call({ id: 0, cmd: "prompt", text: "x", display: { note: "no text" } })
  expect(bad.error.code).toBe("invalid_params")
  const blank = await rpc.call({ id: 0.5, cmd: "prompt", text: "x", display: { text: "  " } })
  expect(blank.error.code).toBe("invalid_params")
  const display = { text: "/review-pr 1", note: "Loaded skill review-pr (9 lines)" }
  await rpc.call({ id: 1, cmd: "prompt", text: "long skill text", display })
  expect((await rpc.call({ id: 2, cmd: "steer", text: "more", display: { text: "/more" } })).ok).toBe(true)
  expect((await rpc.until((l) => l.type === "turn.start")).data.prompt.display).toEqual(display)
  expect((await rpc.until((l) => l.type === "turn.steer")).data.message.display).toEqual({ text: "/more" })
  await rpc.until((l) => l.type === "turn.end")
  const read = await rpc.call({ id: 3, cmd: "session.read", what: "messages" })
  const users = read.messages.filter((m: Line) => m.role === "user")
  expect(users.map((m: Line) => m.display)).toEqual([display, { text: "/more" }])
  expect(await rpc.end()).toBe(0)
})

test("the rpc schema describes a user message's display and lets prompt and steer send one", () => {
  const defs = (rpcSchema() as any).$defs
  expect(defs.UserMessage.properties.display).toEqual({ $ref: "#/$defs/MessageDisplay" })
  expect(defs.UserMessage.required).not.toContain("display")
  expect(defs.MessageDisplay.required).toEqual(["text"])
  expect(Object.keys(defs.MessageDisplay.properties)).toEqual(["text", "note", "origin"])
  expect(COMMAND_PARAMS.prompt.params).toHaveProperty("display?")
  expect(COMMAND_PARAMS.steer.params).toHaveProperty("display?")
})

test("during a /compact, prompt and model.set are busy and steer queues the message", async () => {
  const s = await session([{ text: "one" }, { text: "two" }, { text: "S", delayMs: 100 }, { text: "three" }])
  const rpc = inProcess(s)
  await rpc.call({ id: 1, cmd: "prompt", text: "first" })
  await rpc.until((l) => l.type === "turn.end")
  await rpc.call({ id: 2, cmd: "prompt", text: "second" })
  await rpc.until((l) => l.type === "turn.end" && l.turnId !== rpc.out.find((o) => o.id === 1)!.turnId)
  const compacted = s.agent.compact()
  expect((await rpc.call({ id: 3, cmd: "model.set", model: "mock/other" })).error.code).toBe("busy")
  expect((await rpc.call({ id: 4, cmd: "prompt", text: "no" })).error.code).toBe("busy")
  expect(await rpc.call({ id: 6, cmd: "state" })).toMatchObject({ busy: true, status: "idle" })
  expect(await rpc.call({ id: 5, cmd: "steer", text: "later" })).toMatchObject({ ok: true, queued: true })
  expect(await compacted).toBe(true)
  const start = await rpc.until((l) => l.type === "turn.start" && l.data.prompt.content[0].text === "later")
  await rpc.until((l) => l.type === "turn.end" && l.turnId === start.turnId)
  expect(s.agent.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "three" }],
  })
  // The refused prompt started no turn of its own.
  const prompts = rpc.out.filter((l) => l.type === "turn.start").map((l) => l.data.prompt.content[0].text)
  expect(prompts).toEqual(["first", "second", "later"])
  expect(await rpc.end()).toBe(0)
})

test("ui.respond needs a value; model.set and prompt wait for the turn", async () => {
  const s = await session([{ toolCalls: [{ name: "ask", args: {} }] }, { text: "bye" }], [rpcTools])
  const rpc = inProcess(s)
  await rpc.call({ id: 1, cmd: "prompt", text: "go" })
  const asked = await rpc.until((l) => l.type === "ui.request")
  const { requestId } = asked.data

  const busy = await rpc.call({ id: 2, cmd: "model.set", model: "mock/other" })
  expect(busy.error.code).toBe("busy")
  expect(s.agent.model.id).toBe("m")
  expect((await rpc.call({ id: "p", cmd: "prompt", text: "not now" })).error.code).toBe("busy")

  // A misspelt key leaves the dialog open.
  const typo = await rpc.call({ id: 3, cmd: "ui.respond", requestId, val: true })
  expect(typo.error.code).toBe("invalid_params")
  expect((await rpc.call({ id: 4, cmd: "state" })).uiRequests.length).toBe(1)
  expect((await rpc.call({ id: 5, cmd: "ui.respond", requestId, value: null })).ok).toBe(true)
  await rpc.until((l) => l.type === "turn.end")
  expect(rpc.out.find((l) => l.type === "ui.resolved")?.data.cancelled).toBe(true)
  expect(rpc.out.filter((l) => l.type === "turn.start")).toHaveLength(1)

  expect(await rpc.call({ id: 6, cmd: "model.set", model: "mock/other" })).toMatchObject({
    ok: true,
    model: "mock/other",
  })
  expect(await rpc.end()).toBe(0)
})

test("a background result starts an ordinary turn over rpc; closing stdin waits for it", async () => {
  const later: Extension = (api) =>
    void api.registerTool({
      name: "later",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        const notice = ctx.session!.expectNotice!()
        setTimeout(
          () => notice.deliver(userMessage("late result", { text: "◆ bg finished", origin: "subagent" })),
          60,
        )
        return { content: [{ type: "text", text: "started" }] }
      },
    })
  const s = await session(
    [{ toolCalls: [{ name: "later", args: {} }] }, { text: "started it" }, { text: "reacted" }],
    [later],
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
  const starts = out.filter((l) => l.type === "turn.start")
  const ends = out.filter((l) => l.type === "turn.end")
  expect(starts.length).toBe(2)
  expect(ends.map((l) => l.data.reason)).toEqual(["done", "done"])
  expect(starts[1]?.data.prompt.display).toEqual({ text: "◆ bg finished", origin: "subagent" })
  expect(ends[1]?.turnId).toBe(starts[1]?.turnId)
  expect(s.agent.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "reacted" }],
  })
})

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
  expect(result?.content[0]).toEqual({ type: "text", text: "answer: nobody answered" })
})

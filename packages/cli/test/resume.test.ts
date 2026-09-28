import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { listSessions } from "@amira/core"
import { parseCliArgs, UsageError } from "../src/args.ts"
import { runPrint } from "../src/print.ts"
import { chooseStore, formatSessionList } from "../src/resume.ts"
import { createSession } from "../src/session.ts"

const here = import.meta.dir
let home: string
let savedHome: string | undefined

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "amira-home-"))
  savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
})

const quiet = { stdout: () => {}, stderr: () => {} }

test("parses -c, -r <id> and a bare -r", () => {
  expect(parseCliArgs(["-c", "hi"], here, {})).toMatchObject({ continue: true, prompt: "hi" })
  expect(parseCliArgs(["-r", "s_ab12cd34", "hi"], here, {})).toMatchObject({
    resume: "s_ab12cd34",
    prompt: "hi",
  })
  expect(parseCliArgs(["--resume", "s_x"], here, {}).resume).toBe("s_x")
  expect(parseCliArgs(["-r"], here, {}).resume).toBe("")
  expect(parseCliArgs(["-r", "fix the bug"], here, {})).toMatchObject({ resume: "", prompt: "fix the bug" })
  expect(parseCliArgs(["-p", "-r"], here, {})).toMatchObject({ print: true, resume: "" })
  expect(parseCliArgs(["-p", "--", "-r"], here, {}).prompt).toBe("-r")
  expect(() => parseCliArgs(["-c", "-r", "s_x"], here, {})).toThrow(UsageError)
  expect(() => parseCliArgs(["-p", "-c"], here, {})).toThrow(/needs a prompt/)
})

async function turn(store: ReturnType<typeof chooseStore>["store"], reply: string, prompt: string) {
  const mock = createMockDialect([{ text: reply }])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const { agent } = await createSession({
    model: "mock/m",
    cwd: here,
    extensions: [],
    noBuiltins: true,
    ai,
    store,
  })
  const events: AnyEvent[] = []
  agent.bus.subscribe((e) => void events.push(e))
  await runPrint(agent, prompt, false, {
    io: quiet,
    onReady: () =>
      agent.start("resume", { sessionFile: store.file, resume: ["amira", "--resume", store.id] }),
  })
  return { mock, agent, events }
}

test("a session is stored, listed, and continued with its earlier turns", async () => {
  expect(() => chooseStore({ cwd: here, continue: true })).toThrow(/no session to continue/)
  const fresh = chooseStore({ cwd: here, continue: false })
  expect(fresh.resumed).toBe(false)
  await turn(fresh.store, "4", "what is 2+2?")

  const list = listSessions(here)
  expect(list.map((s) => s.id)).toEqual([fresh.store.id])
  expect(formatSessionList(list)).toMatch(/ {2}1\. .* {3}2 msgs {2}s_\w+ {2}what is 2\+2\?/)

  const cont = chooseStore({ cwd: here, continue: true })
  expect(cont.resumed).toBe(true)
  const { mock, events } = await turn(cont.store, "8", "and doubled?")
  expect(mock.requests[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
  const start = events.find((e) => e.type === "session.start")!
  expect(start.data).toMatchObject({ reason: "resume", sessionFile: fresh.store.file })

  const byId = chooseStore({ cwd: here, continue: false, resume: fresh.store.id })
  expect(byId.store.restore().messages.length).toBe(4)
  expect(() => chooseStore({ cwd: here, continue: false, resume: "s_missing" })).toThrow(
    /no session s_missing/,
  )
})

test("amira -p -r lists this directory's sessions and exits", async () => {
  const main = path.join(here, "..", "src", "main.ts")
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", main, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AMIRA_MODEL: "", AMIRA_HOME: home },
    })
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    return { out, err, code }
  }
  const listed = await run("-p", "-r", "-C", here)
  expect(listed.code).toBe(0)
  expect(listed.out).toContain("what is 2+2?")
  const empty = await run("-p", "-r", "-C", os.tmpdir())
  expect([empty.code, empty.err]).toEqual([1, `amira: no sessions in ${os.tmpdir()}\n`])
}, 60_000)

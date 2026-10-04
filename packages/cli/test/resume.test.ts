import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { listSessions, SessionStore } from "@amira/core"
import { parseCliArgs, UsageError } from "../src/args.ts"
import { runPrint } from "../src/print.ts"
import { chooseStore, exitNote, formatSessionList } from "../src/resume.ts"
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

const pickerKeys = { Esc: "\x1b", "Ctrl+C": "\x03", Enter: "\r" }
for (const mode of ["startup", "slash", "select"] as const) {
  for (const name of mode === "select" ? (["Enter"] as const) : (["Esc", "Ctrl+C"] as const)) {
    const key = pickerKeys[name]
    test(`${mode} resume picker with ${name} leaves sessions unchanged`, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "amira-resume-cancel-"))
      const store = SessionStore.create({ cwd })
      store.append({ type: "model_change", model: { provider: "local", model: "test" } })
      store.appendMessage(userMessage("keep this session"))
      if (mode === "slash") {
        SessionStore.create({ cwd }).appendMessage(userMessage("another session to pick"))
      }
      const dir = path.dirname(store.file)
      const before = await readdir(dir)
      const contents = await Promise.all(before.map((f) => readFile(path.join(dir, f), "utf8")))
      const ids = listSessions(cwd)
        .map((s) => s.id)
        .sort()
      await writeFile(
        path.join(home, "settings.json"),
        JSON.stringify({
          model: "local/test",
          providers: {
            local: { dialect: "openai-chat", baseUrl: "http://127.0.0.1:1", models: [{ id: "test" }] },
          },
        }),
      )
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            path.join(here, "fixtures/resume-picker.ts"),
            "-r",
            ...(mode === "slash" ? [store.id] : []),
            "-C",
            cwd,
            "--no-packages",
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              AMIRA_HOME: home,
              HOME: home,
              USERPROFILE: home,
              AMIRA_MODEL: "",
              TEST_PICKER_MODE: mode,
              TEST_PICKER_KEY: key,
            },
          },
        )
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect({ code, err }, out).toEqual({ code: 0, err: "" })
        expect(out).toContain(`startup stored: ${mode === "slash"}`)
        expect(out).toContain("picker exited: 0")
        expect(await readdir(dir)).toEqual(before)
        expect(await Promise.all(before.map((f) => readFile(path.join(dir, f), "utf8")))).toEqual(contents)
        expect(
          listSessions(cwd)
            .map((s) => s.id)
            .sort(),
        ).toEqual(ids)
      } finally {
        await rm(cwd, { recursive: true, force: true })
        await rm(path.join(home, "settings.json"), { force: true })
      }
    }, 20_000)
  }
}

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
})

test("-r grouped with boolean flags keeps its optional id", () => {
  const here = process.cwd()
  expect(parseCliArgs(["-pr", "s_ab12", "fix it"], here, {})).toMatchObject({
    print: true,
    resume: "s_ab12",
    prompt: "fix it",
  })
  expect(parseCliArgs(["-pr"], here, {})).toMatchObject({ print: true, resume: "" })
  expect(() => parseCliArgs(["-pr", "fix it"], here, {})).toThrow(/only lists sessions/)
  expect(parseCliArgs(["-m", "p/m", "-r"], here, {})).toMatchObject({ model: "p/m", resume: "" })
})

test("print mode refuses a prompt it would ignore while listing sessions", () => {
  const here = process.cwd()
  expect(() => parseCliArgs(["-p", "-r", "hello there"], here, {})).toThrow(/only lists sessions/)
  expect(parseCliArgs(["-r", "hello there"], here, {})).toMatchObject({ resume: "", prompt: "hello there" })
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

test("quitting says how to continue the session, then a blank line before the shell's prompt", async () => {
  const fresh = chooseStore({ cwd: here, continue: false })
  const { agent } = await turn(fresh.store, "ok", "remember this")
  // The UI already ends with a blank line after the transcript: nothing goes before the note.
  expect(exitNote(agent, 0, here)).toBe(
    `Continue this session with amira -c (or amira -r ${fresh.store.id}).\n\n`,
  )
  expect(exitNote(agent, 2, here)).toContain("Stopping 2 sub-agents that were still running.\n")
  expect(exitNote(agent, 1, here, 1)).toContain(
    "Stopping 1 sub-agent that was still running.\nStopping 1 background job that was still running.\n",
  )
  expect(exitNote({ session: { id: "s_old" }, messages: [1] }, 0, here)).toBe(
    "Continue this session with amira -r s_old.\n\n",
  )
  // Nothing to continue: nothing; the UI's own last blank line sets the shell's prompt apart.
  expect(exitNote({ session: { id: "s_new" }, messages: [] }, 0, here)).toBe("")
  expect(exitNote({ session: undefined, messages: [1] }, 0, here)).toBe("")
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

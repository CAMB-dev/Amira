import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, Extension, UiApi } from "@amira/api"
import { runRpc } from "../src/rpc.ts"
import { createSession } from "../src/session.ts"

type Line = Record<string, any>

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function channel() {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let ended = false
  return {
    lines: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) yield queue.shift()!
          else if (ended) return
          else await new Promise<void>((resolve) => (wake = resolve))
        }
      },
    },
    push(command: unknown) {
      queue.push(JSON.stringify(command))
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
  }
}

async function setup(extension?: Extension, replay = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-rpc-ui-session-"))
  const home = path.join(dir, "home")
  await mkdir(home)
  const previousHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
  cleanup.push(async () => {
    if (previousHome === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  })
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  let ui!: UiApi
  const pending: AnyEvent[] = []
  const session = await createSession({
    ai,
    model: "mock/main",
    cwd: dir,
    extensions: [],
    noBuiltins: false,
    builtins: async () => [
      {
        source: "dialogs",
        extension: async (api) => {
          ui = api.ui
          api.settings.declare({
            fields: [{ type: "toggle", key: "enabled", label: "Enabled", default: false }],
          })
          api.on("ui.request", (event) => void pending.push(event))
          await extension?.(api)
        },
      },
    ],
  })
  await session.agent.bus.flush()
  const input = channel()
  const out: Line[] = []
  const ready = Promise.withResolvers<void>()
  const done = runRpc(
    { agent: session.agent, ai, ui: session.host.ui },
    {
      pending: replay ? pending : undefined,
      onReady: () => ready.resolve(),
      io: { lines: input.lines, write: (line) => void out.push(JSON.parse(line)) },
    },
  )
  cleanup.push(async () => {
    session.host.ui.cancelAll()
    input.end()
    expect(await done).toBe(0)
    await session.host.runExitHandlers()
    await session.agent.dispose()
  })
  await ready.promise
  const until = async (match: (line: Line) => boolean) => {
    const deadline = Date.now() + 5000
    while (true) {
      const found = out.find(match)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`Timed out waiting for RPC output: ${JSON.stringify(out)}`)
      await Bun.sleep(2)
    }
  }
  let id = 0
  const call = (command: Record<string, unknown>) => {
    const requestId = ++id
    input.push({ ...command, id: requestId })
    return until((line) => line.id === requestId && "ok" in line)
  }
  return { ui, session, out, until, call, home }
}

function openDialogs(ui: UiApi) {
  const opts = { sessionId: "display-conversation" }
  const answers = [
    ui.select("Select", ["One"], opts),
    ui.confirm("Confirm", undefined, opts),
    ui.input("Input", opts),
    ui.reviewDiff("Diff", "+line", ["Accept"], opts),
    ui.ask([{ question: "Question", options: [{ label: "Yes" }, { label: "No" }] }], opts),
    ui.form({ title: "Form", fields: [{ type: "text", id: "name", label: "Name" }] }, opts),
    ui.extensionSettings("dialogs", opts),
    ui.confirm("Unassociated"),
  ]
  opts.sessionId = "changed-after-open"
  return answers
}

for (const delivery of ["live", "replayed"]) {
  test(`RPC ${delivery} events and state serialize every request kind's display association`, async () => {
    let answers: Promise<unknown>[] = []
    const rpc = await setup((api) => {
      if (delivery === "replayed") answers = openDialogs(api.ui)
    }, delivery === "replayed")
    if (delivery === "live") answers = openDialogs(rpc.ui)
    await rpc.session.agent.bus.flush()
    const requests = rpc.out.filter((line) => line.type === "ui.request")
    expect(requests.map((line) => line.data.kind)).toEqual([
      "select",
      "confirm",
      "input",
      "diff-review",
      "ask",
      "form",
      "extension-settings",
      "confirm",
    ])
    for (const [index, request] of requests.entries()) {
      const sessionId = index === 7 ? "host" : "display-conversation"
      expect(request.sessionId).toBe(sessionId)
      expect(request.data).toMatchObject({ sessionId, source: "dialogs" })
    }
    const state = await rpc.call({ cmd: "state" })
    expect(state.ok).toBe(true)
    expect(state.sessionId).toBe(rpc.session.agent.sessionId)
    expect(state.sessionId).not.toBe("display-conversation")
    expect(state.uiRequests).toEqual(requests.map((line) => line.data))
    for (const request of requests) {
      expect((await rpc.call({ cmd: "ui.respond", requestId: request.data.requestId, value: null })).ok).toBe(
        true,
      )
      const resolved = await rpc.until(
        (line) => line.type === "ui.resolved" && line.data.requestId === request.data.requestId,
      )
      expect(resolved.sessionId).toBe(request.sessionId)
      expect(resolved.data).toEqual({ requestId: request.data.requestId, cancelled: true })
    }
    expect(await Promise.all(answers)).toEqual(Array(8).fill(undefined))
    expect((await rpc.call({ cmd: "state" })).uiRequests).toEqual([])
  })
}

test("RPC serializes associated form progress and live request updates without changing identities", async () => {
  const rpc = await setup()
  const formAnswer = rpc.ui.form(
    {
      title: "Connection",
      fields: [
        {
          type: "action",
          id: "probe",
          label: "Probe",
          run: async ({ progress }) => {
            progress("Connecting")
            return { message: "Connected" }
          },
        },
      ],
    },
    { sessionId: "display-conversation" },
  )
  const request = await rpc.until((line) => line.type === "ui.request")
  expect(
    (await rpc.call({ cmd: "ui.action", requestId: request.data.requestId, action: "probe" })).result,
  ).toEqual({
    message: "Connected",
  })
  const progress = await rpc.until((line) => line.type === "ui.progress")
  expect(progress.sessionId).toBe("display-conversation")
  expect(progress.data).toEqual({ requestId: request.data.requestId, action: "probe", text: "Connecting" })
  expect((await rpc.call({ cmd: "ui.respond", requestId: request.data.requestId, value: {} })).ok).toBe(true)
  expect(await formAnswer).toEqual({})
  let label = "Before"
  const opts = { sessionId: "display-conversation", sections: [], live: () => ({ optionLabels: [label] }) }
  const choice = rpc.ui.choose("Choose", ["identity"], opts)
  const original = await rpc.until((line) => line.type === "ui.request" && line.data.kind === "select")
  opts.sessionId = "changed-after-open"
  label = "After"
  rpc.session.agent.bus.emit(
    "session.title",
    { title: "Changed" },
    { sessionId: rpc.session.agent.sessionId },
  )
  const updated = await rpc.until(
    (line) => line.type === "ui.request" && line.data.optionLabels?.[0] === "After",
  )
  expect(updated.sessionId).toBe("display-conversation")
  expect(updated.data).toEqual({ ...original.data, optionLabels: ["After"] })
  expect((await rpc.call({ cmd: "state" })).uiRequests).toEqual([updated.data])
  expect(
    (await rpc.call({ cmd: "ui.respond", requestId: original.data.requestId, value: "identity" })).ok,
  ).toBe(true)
  expect(await choice).toEqual({ option: "identity" })
  await rpc.session.agent.bus.flush()
  const resolved = rpc.out.filter((line) => line.type === "ui.resolved")
  expect(resolved.map((line) => line.sessionId)).toEqual(["display-conversation", "display-conversation"])
})

test("RPC settings-save errors and successful retry preserve display association", async () => {
  const rpc = await setup()
  const answer = rpc.ui.extensionSettings("dialogs", { sessionId: "display-conversation" })
  const request = await rpc.until((line) => line.type === "ui.request")
  await writeFile(path.join(rpc.home, "settings.json"), "[]")
  const command = {
    cmd: "ui.respond",
    requestId: request.data.requestId,
    value: { values: { enabled: true }, scope: "user" },
  }
  expect((await rpc.call(command)).ok).toBe(true)
  const progress = await rpc.until((line) => line.type === "ui.progress")
  expect(progress.sessionId).toBe("display-conversation")
  expect(progress.data).toMatchObject({ requestId: request.data.requestId, action: "save" })
  expect(progress.data.text).toContain("must hold a JSON object")
  expect((await rpc.call({ cmd: "state" })).uiRequests).toEqual([request.data])
  await writeFile(path.join(rpc.home, "settings.json"), "{}")
  expect((await rpc.call(command)).ok).toBe(true)
  expect(await answer).toEqual({ values: { enabled: true }, scope: "user" })
  const resolved = await rpc.until((line) => line.type === "ui.resolved")
  expect(resolved.sessionId).toBe("display-conversation")
  expect(resolved.data).toEqual({ requestId: request.data.requestId, cancelled: false })
  expect((await rpc.call({ cmd: "state" })).uiRequests).toEqual([])
})

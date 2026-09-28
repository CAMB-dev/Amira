import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { defineExtension, defineTool, type Extension, type FormSpec, textResult } from "@amira/api"
import { runRpc } from "../src/rpc.ts"
import { rpcSchema } from "../src/rpc-schema.ts"
import { createSession } from "../src/session.ts"

type Line = Record<string, any>

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

async function rpcWith(steps: MockStep[], extension: Extension) {
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const s = await createSession({
    model: "mock/m",
    cwd: import.meta.dir,
    extensions: [],
    noBuiltins: false,
    ai,
    builtins: async () => [{ source: "forms", extension }],
  })
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
  return { out, until, call, end, session: s }
}

let gate: () => void = () => {}

const spec = (): FormSpec => ({
  title: "Token",
  fields: [
    { type: "text", id: "host", label: "Host", required: true },
    { type: "secret", id: "token", label: "Token" },
    {
      type: "action",
      id: "probe",
      label: "Probe",
      run: async ({ values, progress }) => {
        progress(`probing ${values.host}`)
        await new Promise<void>((r) => {
          gate = r
        })
        return {
          message: "reachable",
          tone: "success",
          options: { region: [{ value: "eu" }, { value: "us" }] },
        }
      },
    },
    { type: "select", id: "region", label: "Region", options: [{ value: "any" }] },
  ],
})

const formTool = defineExtension((api) => {
  api.registerTool(
    defineTool({
      name: "configure",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const v = await api.ui.form(spec())
        return textResult(
          v ? `host=${v.host} region=${v.region} token=${v.token ? "set" : "none"}` : "cancelled",
        )
      },
    }),
  )
})

test("rpc: a form arrives as a schema; ui.action runs its button while other lines are handled", async () => {
  const rpc = await rpcWith([{ toolCalls: [{ name: "configure", args: {} }] }, { text: "done" }], formTool)
  await rpc.call({ id: 1, cmd: "prompt", text: "go" })
  const req = await rpc.until((l) => l.type === "ui.request")
  expect(req.data).toMatchObject({ kind: "form", title: "Token", source: "forms" })
  expect(req.data.fields.map((f: Line) => f.type)).toEqual(["text", "secret", "action", "select"])
  const requestId = req.data.requestId

  rpc.call({ id: 2, cmd: "ui.action", requestId, action: "probe", values: { host: "h1" } })
  await rpc.until((l) => l.type === "ui.progress")
  // The action is still running; state answers meanwhile.
  expect((await rpc.call({ id: 3, cmd: "state" })).uiRequests[0].kind).toBe("form")
  gate()
  const action = await rpc.until((l) => l.id === 2 && "ok" in l)
  expect(action.result).toEqual({
    message: "reachable",
    tone: "success",
    options: { region: [{ value: "eu" }, { value: "us" }] },
  })
  expect(rpc.out.find((l) => l.type === "ui.progress")!.data).toEqual({
    requestId,
    action: "probe",
    text: "probing h1",
  })

  const bad = await rpc.call({ id: 4, cmd: "ui.respond", requestId, value: { host: "", region: "mars" } })
  expect(bad.error.code).toBe("invalid_params")
  expect(bad.error.message).toContain("Host: is required")
  expect(bad.error.message).toContain("Region: must be one of the options")
  // The options the action filled in are accepted now.
  const ok = await rpc.call({
    id: 5,
    cmd: "ui.respond",
    requestId,
    value: { host: "h1", token: "tk-9Z", region: "eu" },
  })
  expect(ok.ok).toBe(true)
  await rpc.until((l) => l.type === "turn.end")
  const toolEnd = rpc.out.find((l) => l.type === "tool.execute.end")!
  expect(toolEnd.data.result.content[0].text).toBe("host=h1 region=eu token=set")
  const resolved = rpc.out.find((l) => l.type === "ui.resolved")!
  expect(resolved.data).toEqual({ requestId, cancelled: false })
  // Only the line the client sent held the token; nothing sent back does.
  expect(JSON.stringify(rpc.out)).not.toContain("tk-9Z")
  const missing = await rpc.call({ id: 6, cmd: "ui.action", requestId, action: "probe" })
  expect(missing.error.code).toBe("not_found")
  expect(await rpc.end()).toBe(0)
})

test("rpc: ui.configure dialogs asks a form one field at a time", async () => {
  const rpc = await rpcWith([{ toolCalls: [{ name: "configure", args: {} }] }, { text: "done" }], formTool)
  expect((await rpc.call({ id: 1, cmd: "ui.configure", forms: "dialogs" })).ok).toBe(true)
  expect((await rpc.call({ id: 2, cmd: "ui.configure", forms: "nope" })).error.code).toBe("invalid_params")
  await rpc.call({ id: 3, cmd: "prompt", text: "go" })
  const answers: unknown[] = ["h2", "tk-1", "No", "any", "Save"]
  let id = 10
  for (let i = 0; i < answers.length; i++) {
    await rpc.until(() => rpc.out.filter((l) => l.type === "ui.request").length > i)
    const req = rpc.out.filter((l) => l.type === "ui.request")[i]!
    if (i === 1) expect(req.data).toMatchObject({ kind: "input", secret: true })
    expect(
      (await rpc.call({ id: id++, cmd: "ui.respond", requestId: req.data.requestId, value: answers[i] })).ok,
    ).toBe(true)
  }
  await rpc.until((l) => l.type === "turn.end")
  const toolEnd = rpc.out.find((l) => l.type === "tool.execute.end")!
  expect(toolEnd.data.result.content[0].text).toBe("host=h2 region=any token=set")
  expect(await rpc.end()).toBe(0)
})

test("the rpc schema describes forms, ui.action and ui.progress", () => {
  const schema = rpcSchema() as any
  const kinds = schema.$defs.UiRequest.oneOf.map((o: any) => o.properties.kind.enum[0])
  expect(kinds).toContain("form")
  const types = schema.$defs.FormField.oneOf.map((o: any) => o.properties.type.enum[0])
  expect(types).toEqual([
    "text",
    "secret",
    "number",
    "select",
    "multiselect",
    "checkbox",
    "textarea",
    "action",
  ])
  const events = schema.$defs.Event.anyOf.flatMap((e: any) => e.properties.type.enum ?? [])
  expect(events).toContain("ui.progress")
})

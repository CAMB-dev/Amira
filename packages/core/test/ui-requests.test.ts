import { expect, test } from "bun:test"
import type { AnyEvent, EventEnvelope, FormSpec } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { UiRequests } from "../src/ui-requests.ts"

function setup() {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const ui = new UiRequests(bus)
  const next = async () => {
    await bus.flush()
    return events.filter((e) => e.type === "ui.request").at(-1) as EventEnvelope<"ui.request">
  }
  return { bus, events, ui, next }
}

test("select, confirm and input round trip through events and respond()", async () => {
  const { ui, next, events, bus } = setup()
  const api = ui.api("ext")

  const choice = api.select("Pick", ["a", "b"])
  const req = await next()
  expect(req.data).toMatchObject({ kind: "select", title: "Pick", options: ["a", "b"], source: "ext" })
  expect(ui.respond(req.data.requestId, "c")).toContain("one of the options")
  expect(ui.pending.length).toBe(1)
  expect(ui.respond(req.data.requestId, "b")).toBeUndefined()
  expect(await choice).toBe("b")

  const ok = api.confirm("Sure?", "really")
  expect(ui.respond((await next()).data.requestId, "yes")).toContain("true or false")
  ui.respond((await next()).data.requestId, true)
  expect(await ok).toBe(true)

  const text = api.input("Name", { initial: "x" })
  ui.respond((await next()).data.requestId, "Ada")
  expect(await text).toBe("Ada")

  await bus.flush()
  const resolved = events.flatMap((e) => (e.type === "ui.resolved" ? [e.data] : []))
  expect(resolved.map((r) => r.value)).toEqual(["b", true, "Ada"])
  expect(ui.respond("nope", 1)).toContain("no pending")
})

test("null cancels; timeouts and abort signals cancel too", async () => {
  const { ui, next, events, bus } = setup()
  const api = ui.api()
  const a = api.confirm("Sure?")
  ui.respond((await next()).data.requestId, null)
  // Cancelled is not the same as a no.
  expect(await a).toBeUndefined()
  const no = api.confirm("Sure?")
  ui.respond((await next()).data.requestId, false)
  expect(await no).toBe(false)

  expect(await api.input("slow", { timeoutMs: 10 })).toBeUndefined()

  const ac = new AbortController()
  const c = api.select("x", ["1"], { signal: ac.signal })
  ac.abort()
  expect(await c).toBeUndefined()
  expect(await api.select("x", ["1"], { signal: ac.signal })).toBeUndefined()

  await bus.flush()
  const resolved = events.flatMap((e) => (e.type === "ui.resolved" ? [e.data.cancelled] : []))
  expect(resolved).toEqual([true, false, true, true])
  expect(ui.pending).toEqual([])
})

test("extensions get api.ui; unloading one cancels its open dialogs", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  let answer: Promise<string | undefined> | undefined
  await host.load((api) => {
    answer = api.ui.input("Name")
  }, "ext")
  expect(host.ui.pending.map((p) => p.source)).toEqual(["ext"])
  host.unload("ext")
  expect(await answer).toBeUndefined()
})

test("diff-review shows a diff and resolves with one of its options", async () => {
  const { ui, next } = setup()
  const answer = ui.api("agent").reviewDiff("Merge?", "+a\n-b\n", ["merge", "keep"])
  const req = await next()
  expect(req.data).toMatchObject({ kind: "diff-review", diff: "+a\n-b\n", options: ["merge", "keep"] })
  expect(ui.respond(req.data.requestId, "other")).toContain("one of the options")
  ui.respond(req.data.requestId, "keep")
  expect(await answer).toBe("keep")
})

const keyForm = (): FormSpec => ({
  title: "Key",
  fields: [
    { type: "text", id: "name", label: "Name", required: true },
    { type: "secret", id: "key", label: "Key", validate: (v) => (v === "bad" ? "rejected" : undefined) },
    {
      type: "action",
      id: "check",
      label: "Check",
      run: async ({ values, progress, signal }) => {
        progress("checking")
        if (values.name === "slow") {
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("stopped"))),
          )
        }
        return { message: `ok ${values.name}`, options: {}, values: { key: "overwrite" } }
      },
    },
  ],
})

test("a form travels as a schema; answers are checked and never echoed", async () => {
  const { ui, next, events, bus } = setup()
  const values = ui.api("ext").form(keyForm())
  const req = await next()
  expect(req.data).toMatchObject({ kind: "form", title: "Key", source: "ext" })
  expect(JSON.stringify(req.data)).not.toContain("validate")
  const id = req.data.requestId
  expect(ui.validateForm(id, { key: "bad" })).toEqual({ name: "is required", key: "rejected" })
  expect(ui.respond(id, "x")).toContain("object")
  expect(ui.respond(id, { name: "", key: "sk-secret" })).toContain("Name: is required")
  const progress: string[] = []
  const r = await ui.runFormAction(id, "check", { name: "a" }, { onProgress: (t) => progress.push(t) })
  expect(r).toEqual({ message: "ok a", options: {}, values: {} })
  expect(progress).toEqual(["checking"])
  expect(ui.respond(id, { name: "a", key: "sk-secret" })).toBeUndefined()
  expect(await values).toEqual({ name: "a", key: "sk-secret" })
  await bus.flush()
  expect(events.find((e) => e.type === "ui.progress")?.data).toEqual({
    requestId: id,
    action: "check",
    text: "checking",
  })
  expect(events.find((e) => e.type === "ui.resolved")?.data).toEqual({ requestId: id, cancelled: false })
  expect(JSON.stringify(events)).not.toContain("sk-secret")
})

test("closing a form aborts its running actions; secret inputs keep their answer out of events", async () => {
  const { ui, next, events, bus } = setup()
  const values = ui.api().form(keyForm())
  const id = (await next()).data.requestId
  const running = ui.runFormAction(id, "check", { name: "slow" })
  ui.cancel(id)
  expect(await values).toBeUndefined()
  expect((await running).tone).toBe("warning")
  expect(await ui.runFormAction(id, "check", {})).toMatchObject({ tone: "error" })

  const key = ui.api().input("Key", { secret: true, initial: "old" })
  const req = await next()
  expect(req.data).toMatchObject({ kind: "input", secret: true })
  expect("initial" in req.data).toBe(false)
  ui.respond(req.data.requestId, "sk-typed")
  expect(await key).toBe("sk-typed")
  await bus.flush()
  expect(JSON.stringify(events)).not.toContain("sk-typed")
})

test("in dialogs mode a form is asked one field at a time", async () => {
  const { ui, events, bus } = setup()
  ui.formMode = "dialogs"
  bus.subscribe(
    (e) => {
      if (e.type !== "ui.request") return
      const d = e.data
      if (d.kind === "input") ui.respond(d.requestId, d.secret ? "sk-1" : "ada")
      // "Check? No|Yes" takes the default; the last question offers Save first.
      else if (d.kind === "select") ui.respond(d.requestId, d.options[0]!)
    },
    { types: ["ui.request"] },
  )
  expect(await ui.api().form(keyForm())).toEqual({ name: "ada", key: "sk-1" })
  await bus.flush()
  const kinds = events.filter((e) => e.type === "ui.request").map((e) => (e.data as { kind: string }).kind)
  expect(kinds).toEqual(["input", "input", "select", "select"])
  expect(JSON.stringify(events)).not.toContain("sk-1")
})

test("ask questions are answered with one AskAnswer per question, checked against the options", async () => {
  const { ui, next } = setup()
  const questions = [
    { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
    { question: "Which extras?", options: [{ label: "x" }, { label: "y" }], multiSelect: true },
  ]
  const answered = ui.api("ext").ask(questions)
  const req = await next()
  expect(req.data).toMatchObject({ kind: "ask", title: "2 questions", questions, source: "ext" })
  const id = req.data.requestId
  expect(ui.respond(id, [{ selected: ["A"] }])).toContain("array of 2 answer(s)")
  expect(ui.respond(id, [{ selected: ["C"] }, { selected: [] }])).toContain('"C" is not one of the options')
  expect(ui.respond(id, [{ selected: ["A", "B"] }, { selected: [] }])).toContain("must choose one option")
  expect(ui.respond(id, [{ selected: [], other: " " }, { selected: [] }])).toContain('"other" must be text')
  expect(ui.respond(id, [{ selected: ["A"] }, { selected: ["x", "x"] }])).toBe(
    "answer 2 names an option twice",
  )
  const value = [{ selected: [], other: "neither" }, { selected: ["x", "y"] }]
  expect(ui.respond(id, value)).toBeUndefined()
  expect(await answered).toEqual(value)
  // One question names the request.
  void ui.api().ask([questions[0]!])
  expect((await next()).data.title).toBe("Which approach?")
})

test("a confirm takes always and other text only when it offers them", async () => {
  const { ui, next } = setup()
  const plain = ui.ask({ kind: "confirm", title: "Go?" })
  const id = (await next()).data.requestId
  expect(ui.respond(id, "always")).toBe("value must be true or false")
  expect(ui.respond(id, { other: "no" })).toBe("value must be true or false")
  ui.respond(id, false)
  expect(await plain).toBe(false)
  const rich = ui.ask({ kind: "confirm", title: "Go?", always: true, other: true })
  const id2 = (await next()).data.requestId
  expect(ui.respond(id2, "sometimes")).toBe('value must be true or false, or "always", or {"other": text}')
  expect(ui.respond(id2, { other: "use rm -i" })).toBeUndefined()
  expect(await rich).toEqual({ other: "use rm -i" })
  // The api's confirm stays a boolean: always is yes.
  const api = ui.api().confirm("Sure?")
  ui.respond((await next()).data.requestId, true)
  expect(await api).toBe(true)
})

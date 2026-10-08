import { expect, test } from "bun:test"
import type { AnyEvent, EventEnvelope, FormActionResult, FormSpec, FormValues } from "@amira/api"
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

test("select forwards the initial option, and still supports cancellation and signals", async () => {
  const { ui, next } = setup()
  const controller = new AbortController()
  const choice = ui.api("ext").select("Effort", ["low", "high", "default"], {
    initial: "high",
    signal: controller.signal,
  })
  const request = (await next()).data
  expect(request).toMatchObject({ kind: "select", initial: "high", source: "ext" })
  expect(request).not.toHaveProperty("signal")
  controller.abort()
  expect(await choice).toBeUndefined()
  expect(ui.pending).toEqual([])

  const defaultChoice = ui.api().select("Effort", ["low", "high"])
  const defaultRequest = (await next()).data
  expect(defaultRequest).not.toHaveProperty("initial")
  ui.respond(defaultRequest.requestId, "low")
  expect(await defaultChoice).toBe("low")
})

test("choose sends sections and takes a key of the option's section, or the option alone", async () => {
  const { ui, next } = setup()
  const api = ui.api("ext")
  const sections = [
    { at: 0, choose: "open", keys: [{ key: "p", label: "print" }] },
    { at: 1, title: "Worktrees" },
  ]
  const first = api.choose("Pick", ["a", "b"], { sections })
  const req = await next()
  expect(req.data).toMatchObject({ kind: "select", options: ["a", "b"], sections })
  // p is a key of a's section only.
  expect(ui.respond(req.data.requestId, { option: "b", key: "p" })).toContain("keys of the option's section")
  expect(ui.respond(req.data.requestId, { option: "a", key: "p" })).toBeUndefined()
  expect(await first).toEqual({ option: "a", key: "p" })
  // A client that answers with the option alone chose it with Enter.
  const second = api.choose("Pick", ["a", "b"], { sections })
  ui.respond((await next()).data.requestId, "b")
  expect(await second).toEqual({ option: "b" })
  // A plain select answered with a choice still resolves with the option.
  const plain = api.select("Pick", ["a", "b"])
  ui.respond((await next()).data.requestId, { option: "a" })
  expect(await plain).toBe("a")
  // A key on a select without sections is refused.
  const keyless = api.select("Pick", ["a", "b"])
  const req2 = await next()
  expect(ui.respond(req2.data.requestId, { option: "a", key: "p" })).toContain("keys of the option's section")
  ui.cancel(req2.data.requestId)
  expect(await keyless).toBeUndefined()
})

test("choose refuses repeated options and malformed sections", async () => {
  const api = setup().ui.api("ext")
  const bad = (options: string[], sections: Parameters<typeof api.choose>[2]["sections"]) =>
    api.choose("Pick", options, { sections })
  await expect(bad(["a", "a"], [])).rejects.toThrow("options must differ")
  await expect(bad(["a", "b"], [{ at: 1 }, { at: 0 }])).rejects.toThrow("increasing option indexes")
  await expect(bad(["a", "b"], [{ at: 2 }])).rejects.toThrow("increasing option indexes")
  await expect(bad(["a"], [{ at: 0, keys: [{ key: "1", label: "one" }] }])).rejects.toThrow("not a digit")
  await expect(bad(["a"], [{ at: 0, keys: [{ key: "pp", label: "print" }] }])).rejects.toThrow(
    "one printable",
  )
  await expect(
    bad(
      ["a"],
      [
        {
          at: 0,
          keys: [
            { key: "p", label: "print" },
            { key: "p", label: "paste" },
          ],
        },
      ],
    ),
  ).rejects.toThrow("used twice")
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

test("automatic form eligibility uses host-only readiness and normalized pending values", async () => {
  const { ui, next, events, bus } = setup()
  const checked: FormValues[] = []
  let runs = 0
  let hiddenChecks = 0
  const run = async () => {
    runs++
    return {}
  }
  const answer = ui.form({
    title: "Connection",
    fields: [
      { type: "checkbox", id: "enabled", label: "Enabled", default: true },
      { type: "secret", id: "key", label: "Key", required: true },
      { type: "number", id: "attempts", label: "Attempts", default: 3 },
      { type: "text", id: "hidden", label: "Hidden", when: { field: "enabled", is: false } },
      {
        type: "action",
        id: "fetch",
        label: "Fetch",
        when: { field: "enabled", is: true },
        auto: {
          watch: ["key", "attempts"],
          ready: (values) => {
            checked.push(values)
            return values.key === "sk-host-only" && values.attempts === 3
          },
        },
        run,
      },
      {
        type: "action",
        id: "hidden-action",
        label: "Hidden action",
        when: { field: "enabled", is: false },
        auto: {
          watch: ["key"],
          ready: () => {
            hiddenChecks++
            return true
          },
        },
        run,
      },
      { type: "action", id: "manual", label: "Manual", run },
    ],
  })
  const request = (await next()).data
  if (request.kind !== "form") throw new Error("expected a form")
  expect(request.fields.find((field) => field.id === "fetch")).toMatchObject({
    auto: { watch: ["key", "attempts"] },
  })
  for (const field of request.fields) {
    expect(field).not.toHaveProperty("run")
    expect(field).not.toHaveProperty("auto.ready")
  }
  const id = request.requestId
  expect(ui.autoFormActions(id, {})).toEqual([])
  const input = { key: "sk-host-only", attempts: "3", hidden: "omit", unknown: "omit" }
  expect(ui.autoFormActions(id, input)).toEqual(["fetch"])
  expect(checked.at(-1)).toEqual({ enabled: true, key: "sk-host-only", attempts: 3 })
  expect(ui.autoFormActions(id, { key: "sk-host-only", attempts: "invalid" })).toEqual([])
  expect(hiddenChecks).toBe(0)
  expect(ui.autoFormActions(id, { ...input, enabled: false })).toEqual(["hidden-action"])
  expect(hiddenChecks).toBe(1)
  expect(runs).toBe(0)
  expect(ui.respond(id, input)).toBeUndefined()
  expect(await answer).toEqual({ enabled: true, key: "sk-host-only", attempts: 3 })
  expect(ui.autoFormActions(id, input)).toEqual([])
  await bus.flush()
  expect(JSON.stringify(events)).not.toContain("sk-host-only")
  expect(events.filter((event) => event.type === "ui.progress")).toEqual([])
  expect(events.find((event) => event.type === "ui.resolved")?.data).toEqual({
    requestId: id,
    cancelled: false,
  })
})

test("automatic form eligibility is empty for unknown, non-form and cancelled requests", async () => {
  const { ui, next } = setup()
  expect(ui.autoFormActions("unknown", {})).toEqual([])
  const input = ui.api().input("Name")
  const inputId = (await next()).data.requestId
  expect(ui.autoFormActions(inputId, {})).toEqual([])
  ui.cancel(inputId)
  expect(await input).toBeUndefined()
  const answer = ui.form(keyForm())
  const formId = (await next()).data.requestId
  ui.cancel(formId)
  expect(await answer).toBeUndefined()
  expect(ui.autoFormActions(formId, {})).toEqual([])
})

test("an aborted action cannot replace options from a newer action", async () => {
  const { ui, next, events, bus } = setup()
  const started = Promise.withResolvers<AbortSignal>()
  const stale = Promise.withResolvers<FormActionResult>()
  const answer = ui.form({
    title: "Models",
    fields: [
      { type: "secret", id: "key", label: "Key" },
      { type: "select", id: "model", label: "Model", options: [{ value: "initial" }] },
      {
        type: "action",
        id: "fetch",
        label: "Fetch",
        run: async ({ values, signal, progress }) => {
          if (values.key === "old-key") {
            started.resolve(signal)
            const result = await stale.promise
            progress("stale response")
            return result
          }
          return { options: { model: [{ value: "new" }] } }
        },
      },
      {
        type: "action",
        id: "check",
        label: "Check",
        auto: { watch: ["model"], ready: (values) => values.model === "new" },
        run: async () => ({}),
      },
    ],
  })
  const id = (await next()).data.requestId
  const controller = new AbortController()
  const running = ui.runFormAction(id, "fetch", { key: "old-key" }, { signal: controller.signal })
  const signal = await started.promise
  controller.abort()
  expect(signal.aborted).toBe(true)
  await ui.runFormAction(id, "fetch", { key: "new-key" })
  expect(ui.autoFormActions(id, { model: "new" })).toEqual(["check"])
  stale.resolve({ options: { model: [{ value: "stale" }] } })
  await running
  expect(ui.validateForm(id, { model: "new" })).toEqual({})
  expect(ui.validateForm(id, { model: "stale" })).toEqual({ model: "must be one of the options" })
  expect(ui.autoFormActions(id, { model: "new" })).toEqual(["check"])
  expect(ui.respond(id, { model: "new" })).toBeUndefined()
  expect(await answer).toEqual({ key: "", model: "new" })
  await bus.flush()
  expect(events.filter((event) => event.type === "ui.progress")).toEqual([])
  expect(JSON.stringify(events)).not.toContain("old-key")
  expect(JSON.stringify(events)).not.toContain("new-key")
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

test("dialogs mode keeps automatic actions manual", async () => {
  const { ui, bus } = setup()
  ui.formMode = "dialogs"
  let readinessChecks = 0
  let runs = 0
  bus.subscribe(
    (event) => {
      if (event.type !== "ui.request" || event.data.kind !== "select") return
      ui.respond(event.data.requestId, event.data.options[0]!)
    },
    { types: ["ui.request"] },
  )
  expect(
    await ui.form({
      title: "Manual",
      fields: [
        {
          type: "action",
          id: "check",
          label: "Check",
          auto: {
            watch: [],
            ready: () => {
              readinessChecks++
              return true
            },
          },
          run: async () => {
            runs++
            return {}
          },
        },
      ],
    }),
  ).toEqual({})
  expect(readinessChecks).toBe(0)
  expect(runs).toBe(0)
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

import { expect, test } from "bun:test"
import type { FormActionResult, FormSpec } from "@amira/api"
import {
  createUiFormBackend,
  EventBus,
  type FormEvaluation,
  type FrontendFormBackend,
  UiRequests,
} from "@amira/core"
import { key, textKey } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { operationFormBackend } from "../src/form-operation-backend.ts"
import { FormView } from "../src/form-view.ts"

const tick = () => Bun.sleep(0)
function setup(
  spec: FormSpec,
  wrap: (backend: FrontendFormBackend) => FrontendFormBackend = (backend) => backend,
) {
  const ui = new UiRequests(new EventBus())
  const answer = ui.form(spec)
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  const view = new FormView(operationFormBackend(wrap(createUiFormBackend(ui, request))), {
    requestRender: () => {},
    onClose: () => {},
  })
  return {
    ui,
    view,
    frame: () => view.render(100, { ...plain, rows: 30 }).join("\n"),
    async close() {
      view.close()
      ui.cancelAll()
      await answer
    },
  }
}

test("focus-only evaluation retains pending dependent-field patches and invokes change once", async () => {
  const pending: {
    result: FormEvaluation
    done: ReturnType<typeof Promise.withResolvers<FormEvaluation>>
  }[] = []
  let changes = 0
  const s = setup(
    {
      title: "Dependent fields",
      fields: [
        { type: "text", id: "name", label: "Name" },
        { type: "text", id: "derived", label: "Derived" },
      ],
      change: (values, previous) => {
        if (values.name === previous.name) return {}
        changes++
        return { values: { derived: `preset ${values.name}` } }
      },
    },
    (backend) => ({
      ...backend,
      evaluate: (draft) => {
        const result = backend.evaluate(draft)
        if (result instanceof Promise) throw new Error("expected synchronous local evaluator")
        const done = Promise.withResolvers<FormEvaluation>()
        pending.push({ result, done })
        return done.promise
      },
    }),
  )
  try {
    await tick()
    pending[0]!.done.resolve(pending[0]!.result)
    await tick()
    s.view.handleInput(textKey("x"))
    s.view.handleInput(key("tab"))
    expect(pending).toHaveLength(3)
    pending[2]!.done.resolve(pending[2]!.result)
    await tick()
    pending[1]!.done.resolve(pending[1]!.result)
    await tick()
    expect(s.view.form.values).toMatchObject({ name: "x", derived: "preset x" })
    expect(changes).toBe(1)
  } finally {
    await s.close()
    for (const item of pending) item.done.resolve(item.result)
  }
})

test("a failed asynchronous submit refreshes host-controlled recovery visibility", async () => {
  let tested = false
  const s = setup({
    title: "Provider check",
    fields: [
      { type: "text", id: "name", label: "Name", default: "Ada" },
      { type: "checkbox", id: "saveAnyway", label: "Save anyway" },
    ],
    visible: (id) => id !== "saveAnyway" || tested,
    beforeSubmit: async () => {
      tested = true
      return { message: "Test failed. Choose Save anyway", tone: "error" }
    },
  })
  try {
    await tick()
    expect(s.frame()).not.toContain("Save anyway")
    s.view.handleInput(key("s", { ctrl: true }))
    await tick()
    expect(s.view.closed).toBe(false)
    expect(s.frame()).toContain("Save anyway")
    s.view.handleInput(key("tab"))
    expect(s.view.form.focused).toBe("saveAnyway")
  } finally {
    await s.close()
  }
})

test("an unrelated edit invalidating an automatic result permits a fresh admitted attempt", async () => {
  let calls = 0
  const gate = Promise.withResolvers<FormActionResult>()
  const s = setup({
    title: "Automatic load",
    fields: [
      { type: "text", id: "endpoint", label: "Endpoint", default: "server" },
      { type: "text", id: "notes", label: "Notes" },
      { type: "select", id: "choice", label: "Choice", options: [{ value: "original" }] },
      {
        type: "action",
        id: "load",
        label: "Load",
        auto: { watch: ["endpoint"], ready: () => true },
        run: async () => {
          calls++
          return calls === 1
            ? gate.promise
            : { options: { choice: [{ value: "loaded" }] }, values: { choice: "loaded" }, message: "Loaded" }
        },
      },
    ],
  })
  try {
    await tick()
    expect(calls).toBe(1)
    s.view.handleInput(key("tab"))
    s.view.handleInput(textKey("n"))
    gate.resolve({ options: { choice: [{ value: "stale" }] } })
    await tick()
    await tick()
    expect(calls).toBe(2)
    expect(s.view.form.values).toMatchObject({ notes: "n", choice: "loaded" })
    expect(s.frame()).toContain("Loaded")
  } finally {
    gate.resolve({})
    await s.close()
  }
})

import { expect, test } from "bun:test"
import type { FormActionResult, FormSpec } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { createUiFormBackend } from "../src/frontend/form-backend.ts"
import { UiRequests } from "../src/ui-requests.ts"

function setup(spec: FormSpec) {
  const ui = new UiRequests(new EventBus())
  const answer = ui.form(spec)
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  return { ui, answer, request, backend: createUiFormBackend(ui, request) }
}

const field = { type: "text", id: "name", label: "Name", required: true } as const

for (const operation of ["evaluate", "action", "submit", "cancel", "claim"] as const) {
  test(`delayed ${operation} from a separate adapter cannot affect its replacement`, async () => {
    const gate = Promise.withResolvers<void>()
    let callbacks = 0
    const app = setup({
      title: "Shared authority",
      fields: [
        field,
        {
          type: "action",
          id: "load",
          label: "Load",
          run: async () => {
            callbacks++
            return {}
          },
        },
      ],
      change: () => {
        callbacks++
        return {}
      },
      beforeSubmit: async () => {
        callbacks++
        return {}
      },
    })
    const controller = new AbortController()
    try {
      const old = { ...(await app.backend.openEditor!()), values: { name: "old" } }
      await app.backend.evaluate(old)
      const delayed = gate.promise
        .then(async () => {
          switch (operation) {
            case "evaluate":
              return app.backend.evaluate({ ...old, revision: old.revision + 100, previous: {} })
            case "action":
              return app.backend.runAction({ ...old, action: "load" })
            case "submit":
              return app.backend.submit(old)
            case "cancel":
              return app.backend.cancel(old.editor)
            case "claim":
              return app.backend.openEditor!({ signal: controller.signal })
          }
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
      controller.abort()
      const replacement = createUiFormBackend(app.ui, structuredClone(app.request))
      const fresh = { ...(await replacement.openEditor!()), values: { name: "new" } }
      expect(fresh.editor).not.toBe(old.editor)
      expect(fresh.revision).toBeGreaterThan(old.revision)
      await replacement.evaluate(fresh)
      gate.resolve()
      const reply = await delayed
      if (operation === "evaluate" || operation === "claim") expect(reply).toHaveProperty("error")
      else expect(reply).toMatchObject({ value: { status: operation === "cancel" ? "invalid" : "stale" } })
      expect(callbacks).toBe(0)
      expect(app.ui.requestState(app.request.requestId)).toBe("pending")
      expect((await replacement.submit(fresh)).status).toBe("accepted")
      expect(await app.answer).toEqual({ name: "new" })
    } finally {
      gate.resolve()
      app.ui.cancelAll()
      await app.answer
    }
  })
}

test("form evaluation is JSON display data; submit acknowledges validation and final acceptance", async () => {
  const app = setup({ title: "Name", fields: [field], preview: (values) => [String(values.name)] })
  try {
    const draft = { revision: 0, values: { name: "" } }
    const evaluation = JSON.parse(JSON.stringify(await app.backend.evaluate(draft)))
    expect(evaluation.errors.name).toBeDefined()
    expect(evaluation.visible).toEqual({ name: true })
    expect((await app.backend.submit(draft)).status).toBe("invalid")
    expect(app.ui.requestState(app.request.requestId)).toBe("pending")
    const valid = { revision: 1, values: { name: "Ada" } }
    await app.backend.evaluate(valid)
    expect((await app.backend.submit(valid)).status).toBe("accepted")
    expect(await app.answer).toEqual({ name: "Ada" })
    expect(app.ui.respondAcknowledged(app.request.requestId, "late")).toEqual({ status: "settled" })
  } finally {
    app.ui.cancelAll()
  }
})

test("cancellation and approval remain tied to the current revision of an editor", async () => {
  const app = setup({ title: "Revision authority", fields: [field], beforeSubmit: async () => ({}) })
  try {
    const old = { ...(await app.backend.openEditor!()), values: { name: "old" } }
    await app.backend.evaluate(old)
    await app.ui.beforeSubmitForm(app.request.requestId, old.values)
    const fresh = { ...old, revision: old.revision + 1 }
    await app.backend.evaluate(fresh)
    expect(app.ui.respondAcknowledged(app.request.requestId, old.values).status).toBe("invalid")
    expect((await app.backend.cancel(old.editor, old.revision)).status).toBe("invalid")
    expect(app.ui.requestState(app.request.requestId)).toBe("pending")
    expect((await app.backend.submit(fresh)).status).toBe("accepted")
    expect(await app.answer).toEqual({ name: "old" })
  } finally {
    app.ui.cancelAll()
    await app.answer
  }
})

test("a slow before-submit cannot settle or approve a newer draft", async () => {
  const deferred = Promise.withResolvers<{ message: string }>()
  const app = setup({ title: "Name", fields: [field], beforeSubmit: () => deferred.promise })
  try {
    const old = { revision: 1, values: { name: "old" } }
    await app.backend.evaluate(old)
    const submit = app.backend.submit(old)
    await app.backend.evaluate({ revision: 2, values: { name: "new" } })
    deferred.resolve({ message: "done" })
    expect((await submit).status).toBe("stale")
    expect(app.ui.requestState(app.request.requestId)).toBe("pending")
  } finally {
    app.ui.cancelAll()
    await app.answer
  }
})

test("stale action options are not committed on the host", async () => {
  const deferred = Promise.withResolvers<{ options: { choice: { value: string }[] } }>()
  const app = setup({
    title: "Options",
    fields: [
      field,
      { type: "select", id: "choice", label: "Choice", options: [{ value: "original" }] },
      { type: "action", id: "load", label: "Load", run: () => deferred.promise },
    ],
  })
  try {
    const old = { revision: 1, values: { name: "old" } }
    await app.backend.evaluate(old)
    const action = app.backend.runAction({ ...old, action: "load" })
    await app.backend.evaluate({ revision: 2, values: { name: "new" } })
    deferred.resolve({ options: { choice: [{ value: "stale" }] } })
    expect((await action).status).toBe("stale")
    expect(app.ui.validateForm(app.request.requestId, { name: "new", choice: "original" })).toEqual({})
  } finally {
    app.ui.cancelAll()
    await app.answer
  }
})

test("automatic action admission survives frontend recreation, while manual actions remain runnable", async () => {
  let calls = 0
  const app = setup({
    title: "Automatic",
    fields: [
      field,
      {
        type: "action",
        id: "load",
        label: "Load",
        auto: { watch: ["name"], ready: () => true },
        run: async () => {
          calls++
          return {}
        },
      },
    ],
  })
  try {
    const draft = { ...(await app.backend.openEditor!()), values: { name: "Ada" } }
    await app.backend.evaluate(draft)
    await app.backend.runAction({ ...draft, action: "load", automatic: true })
    const reattached = { ...(await app.backend.openEditor!()), values: draft.values }
    await app.backend.evaluate(reattached)
    await app.backend.runAction({ ...reattached, action: "load", automatic: true })
    expect(calls).toBe(1)
    await app.backend.runAction({ ...reattached, action: "load" })
    expect(calls).toBe(2)
    expect(await app.backend.cancel(reattached.editor)).toEqual({ status: "cancelled" })
    expect(await app.answer).toBeUndefined()
  } finally {
    app.ui.cancelAll()
  }
})

test("legacy asynchronous submission cannot settle or approve a replacement editor", async () => {
  const check = Promise.withResolvers<FormActionResult>()
  const app = setup({ title: "Legacy check", fields: [field], beforeSubmit: () => check.promise })
  try {
    expect(app.ui.respond(app.request.requestId, { name: "old" })).toBeUndefined()
    const replacement = createUiFormBackend(app.ui, app.request)
    const fresh = { ...(await replacement.openEditor!()), values: { name: "new" } }
    await replacement.evaluate(fresh)
    check.resolve({})
    await Bun.sleep(0)
    expect(app.ui.requestState(app.request.requestId)).toBe("pending")
    expect(app.ui.respondAcknowledged(app.request.requestId, { name: "old" }).status).toBe("invalid")
    expect((await replacement.submit(fresh)).status).toBe("accepted")
    expect(await app.answer).toEqual({ name: "new" })
    expect(app.ui.formEditorState(app.request.requestId)).toBeUndefined()
    expect(() => replacement.openEditor!()).toThrow("no pending form editor")
    expect(() => replacement.evaluate(fresh)).toThrow("stale form evaluation")
  } finally {
    check.resolve({})
    app.ui.cancelAll()
    await app.answer
  }
})

test("a refused unprepared response never schedules a legacy asynchronous form save", async () => {
  let checks = 0
  const app = setup({
    title: "Checked",
    fields: [field],
    beforeSubmit: async () => {
      checks++
      return {}
    },
  })
  try {
    expect(app.ui.respondAcknowledged(app.request.requestId, { name: "Ada" }).status).toBe("invalid")
    await Bun.sleep(0)
    expect(checks).toBe(0)
    expect(app.ui.requestState(app.request.requestId)).toBe("pending")
    const draft = { revision: 1, values: { name: "Ada" } }
    await app.backend.evaluate(draft)
    expect((await app.backend.submit(draft)).status).toBe("accepted")
    expect(checks).toBe(1)
    expect(await app.answer).toEqual({ name: "Ada" })
  } finally {
    app.ui.cancelAll()
  }
})

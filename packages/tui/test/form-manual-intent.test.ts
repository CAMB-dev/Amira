import { expect, test } from "bun:test"
import type { FormSpec, FormValues } from "@amira/api"
import { createUiFormBackend, EventBus, type FormEvaluation, UiRequests } from "@amira/core"
import { key, textKey } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { operationFormBackend } from "../src/form-operation-backend.ts"
import { FormView } from "../src/form-view.ts"

const tick = () => Bun.sleep(0)

function setup(automatic = false, change?: FormSpec["change"]) {
  const calls: FormValues[] = []
  const admissions: string[] = []
  const pending: {
    admit: () => FormEvaluation | Promise<FormEvaluation>
    done: ReturnType<typeof Promise.withResolvers<FormEvaluation>>
  }[] = []
  const ui = new UiRequests(new EventBus())
  const answer = ui.form({
    title: "Hosted manual action",
    ...(change ? { change } : {}),
    fields: [
      { type: "text", id: "name", label: "Name" },
      {
        type: "action",
        id: "load",
        label: "Load",
        ...(automatic ? { auto: { watch: ["name"], ready: (values: FormValues) => !!values.name } } : {}),
        run: async ({ values }) => {
          calls.push(structuredClone(values))
          return { message: "Loaded" }
        },
      },
    ],
  })
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  const host = createUiFormBackend(ui, request)
  let delayed = false
  const adapter = operationFormBackend({
    ...host,
    evaluate: (draft) => {
      if (!delayed) return host.evaluate(draft)
      const done = Promise.withResolvers<FormEvaluation>()
      pending.push({ admit: () => host.evaluate(draft), done })
      return done.promise
    },
    runAction: async (draft, options) => {
      const result = await host.runAction(draft, options)
      admissions.push(result.status)
      return result
    },
  })
  const mount = () => new FormView(adapter, { requestRender: () => {}, onClose: () => {} })
  const view = mount()
  return {
    view,
    calls,
    admissions,
    pending,
    mount,
    delay: () => (delayed = true),
    frame: () => view.render(100, { ...plain, rows: 30 }).join("\n"),
    async release() {
      delayed = false
      for (const item of pending.splice(0)) {
        try {
          item.done.resolve(await item.admit())
        } catch (error) {
          item.done.reject(error)
        }
      }
      await tick()
    },
    async close() {
      view.close()
      await this.release()
      ui.cancelAll()
      await answer
    },
  }
}

test("manual Load waits for delayed host admission and executes once for the evaluated draft", async () => {
  const s = setup()
  try {
    await tick()
    s.delay()
    s.view.handleInput(textKey("x"))
    s.view.handleInput(key("tab"))
    s.view.handleInput(key("enter"))
    await tick()
    expect(s.calls).toHaveLength(0)
    expect(s.admissions).toEqual([])
    expect(s.frame()).toContain("Checking form…")
    await s.release()
    expect(s.calls).toEqual([{ name: "x" }])
    expect(s.admissions).toEqual(["accepted"])
    expect(s.frame()).toContain("Loaded")
  } finally {
    await s.close()
  }
})

for (const automatic of [false, true]) {
  test(`a retained manual intent is not duplicated by repeated activation or automatic replay (${automatic})`, async () => {
    const s = setup(automatic)
    try {
      await tick()
      s.delay()
      s.view.handleInput(textKey("x"))
      s.view.handleInput(key("tab"))
      for (let i = 0; i < 3; i++) s.view.handleInput(key("enter"))
      await s.release()
      await tick()
      expect(s.calls).toEqual([{ name: "x" }])
      expect(s.admissions).toEqual(["accepted"])
    } finally {
      await s.close()
    }
  })
}

for (const mode of ["synchronous", "evaluation-first"] as const) {
  test(`manual Load still executes once with ${mode} evaluation`, async () => {
    const s = setup()
    try {
      await tick()
      if (mode === "evaluation-first") s.delay()
      s.view.handleInput(textKey("x"))
      s.view.handleInput(key("tab"))
      if (mode === "evaluation-first") await s.release()
      s.view.handleInput(key("enter"))
      await tick()
      expect(s.calls).toEqual([{ name: "x" }])
      expect(s.admissions).toEqual(["accepted"])
    } finally {
      await s.close()
    }
  })
}

test("typing a replacement draft cancels retained intent even when the edit is reverted", async () => {
  const s = setup()
  try {
    await tick()
    s.delay()
    s.view.handleInput(textKey("x"))
    s.view.handleInput(key("tab"))
    s.view.handleInput(key("enter"))
    s.view.handleInput(key("tab", { shift: true }))
    s.view.handleInput(textKey("y"))
    s.view.handleInput(key("backspace"))
    await s.release()
    expect(s.calls).toEqual([])
    expect(s.frame()).not.toContain("Checking form…")
    s.view.handleInput(key("tab"))
    s.view.handleInput(key("enter"))
    await tick()
    expect(s.calls).toEqual([{ name: "x" }])
  } finally {
    await s.close()
  }
})

test("a host change replacing the evaluated draft cancels retained intent", async () => {
  const s = setup(false, (values) => (values.name === "x" ? { values: { name: "normalized" } } : {}))
  try {
    await tick()
    s.delay()
    s.view.handleInput(textKey("x"))
    s.view.handleInput(key("tab"))
    s.view.handleInput(key("enter"))
    await s.release()
    expect(s.view.form.values.name).toBe("normalized")
    expect(s.calls).toEqual([])
    expect(s.frame()).not.toContain("Checking form…")
  } finally {
    await s.close()
  }
})

for (const mode of ["close", "detach", "replace"] as const) {
  test(`${mode} cancels a retained intent before host evaluation admission`, async () => {
    const s = setup()
    let replacement: FormView | undefined
    try {
      await tick()
      s.delay()
      s.view.handleInput(textKey("x"))
      s.view.handleInput(key("tab"))
      s.view.handleInput(key("enter"))
      if (mode === "replace") replacement = s.mount()
      else s.view.close(mode === "detach")
      await s.release()
      expect(s.calls).toEqual([])
      expect(s.admissions).toEqual([])
      if (mode === "replace") expect(s.frame()).not.toContain("Checking form…")
    } finally {
      replacement?.close()
      await s.close()
    }
  })
}

test("Escape cancels a retained manual intent", async () => {
  const s = setup()
  try {
    await tick()
    s.delay()
    s.view.handleInput(textKey("x"))
    s.view.handleInput(key("tab"))
    s.view.handleInput(key("enter"))
    s.view.handleInput(key("escape"))
    await s.release()
    expect(s.calls).toEqual([])
    expect(s.view.closed).toBe(false)
    expect(s.frame()).not.toContain("Checking form…")
  } finally {
    await s.close()
  }
})

test("a wrong-revision response cannot release intent; a matching evaluation releases it once", async () => {
  const s = setup()
  try {
    await tick()
    s.delay()
    s.view.handleInput(textKey("x"))
    s.view.handleInput(key("tab"))
    s.view.handleInput(key("enter"))
    const latest = s.pending.pop()!
    latest.done.resolve({ ...(await latest.admit()), revision: -1 })
    await tick()
    expect(s.calls).toEqual([])
    expect(s.frame()).toContain("Checking form…")
    // An older same-revision response is also insufficient: only the latest evaluation applies.
    const older = s.pending.pop()!
    older.done.resolve(await older.admit())
    await tick()
    expect(s.calls).toEqual([])
    s.view.handleInput(key("tab", { shift: true }))
    await s.release()
    expect(s.calls).toEqual([{ name: "x" }])
    expect(s.admissions).toEqual(["accepted"])
  } finally {
    await s.close()
  }
})

test("an older evaluation arriving after manual execution cannot replay it automatically", async () => {
  const s = setup(true)
  try {
    await tick()
    s.delay()
    s.view.handleInput(textKey("x"))
    const older = s.pending.shift()!
    s.view.handleInput(key("tab"))
    s.view.handleInput(key("enter"))
    await s.release()
    expect(s.calls).toEqual([{ name: "x" }])
    older.done.resolve(await older.admit())
    await tick()
    expect(s.calls).toEqual([{ name: "x" }])
    expect(s.admissions).toEqual(["accepted"])
  } finally {
    await s.close()
  }
})

test("a delayed old-revision evaluation cannot release the replacement draft's intent", async () => {
  const s = setup()
  try {
    await tick()
    s.delay()
    s.view.handleInput(textKey("x"))
    const older = s.pending.shift()!
    s.view.handleInput(textKey("y"))
    s.view.handleInput(key("tab"))
    s.view.handleInput(key("enter"))
    older.done.resolve(await older.admit())
    await tick()
    expect(s.calls).toEqual([])
    await s.release()
    expect(s.calls).toEqual([{ name: "xy" }])
    expect(s.admissions).toEqual(["accepted"])
  } finally {
    await s.close()
  }
})

for (const detach of [false, true]) {
  test(`manual activation during a replacement claim is visibly blocked, detach ${detach}`, async () => {
    const calls: FormValues[] = []
    const ui = new UiRequests(new EventBus())
    const answer = ui.form({
      title: "Pending editor",
      fields: [
        { type: "text", id: "name", label: "Name" },
        {
          type: "action",
          id: "load",
          label: "Load",
          run: async ({ values }) => {
            calls.push(values)
            return { message: "Loaded" }
          },
        },
      ],
    })
    const request = ui.pending[0]!
    if (request.kind !== "form") throw new Error("expected form")
    const host = createUiFormBackend(ui, request)
    const first = new FormView(operationFormBackend(host), { requestRender: () => {}, onClose: () => {} })
    for (const c of "abcdef") first.handleInput(textKey(c))
    first.close(true)
    const gate = Promise.withResolvers<void>()
    const view = new FormView(
      operationFormBackend({
        ...host,
        openEditor: async (options) => {
          const claim = await host.openEditor!(options)
          await gate.promise
          return claim
        },
      }),
      { requestRender: () => {}, onClose: () => {} },
    )
    const frame = () => view.render(100, { ...plain, rows: 30 }).join("\n")
    try {
      view.handleInput(textKey("x"))
      view.handleInput(key("tab"))
      view.handleInput(key("enter"))
      expect(calls).toEqual([])
      expect(frame()).toContain("Checking form…")
      if (detach) view.close(true)
      gate.resolve()
      await tick()
      expect(calls).toEqual([]) // This activation was explicitly blocked, not admitted or silently consumed.
      if (!detach) {
        expect(frame()).not.toContain("Checking form…")
        view.handleInput(key("enter"))
        await tick()
        expect(calls).toEqual([{ name: "x" }])
      }
    } finally {
      gate.resolve()
      first.close()
      view.close()
      ui.cancelAll()
      await answer
    }
  })
}

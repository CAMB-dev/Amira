import { expect, test } from "bun:test"
import type { FormActionResult } from "@amira/api"
import { createUiFormBackend, EventBus, type FormDraft, UiRequests } from "@amira/core"
import { key, textKey } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { operationFormBackend } from "../src/form-operation-backend.ts"
import { FormView } from "../src/form-view.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import type { TranscriptView } from "../src/view.ts"

const tick = () => Bun.sleep(0)

for (const recreate of [false, true]) {
  test(`default overlay replacement fences an abandoned save, new manager ${recreate}`, async () => {
    const save = Promise.withResolvers<FormActionResult>()
    const ui = new UiRequests(new EventBus())
    let checks = 0
    const answer = ui.form({
      title: "Default overlay",
      fields: [{ type: "text", id: "name", label: "Name" }],
      beforeSubmit: async () => (++checks === 1 ? save.promise : {}),
    })
    const request = ui.pending[0]!
    const mount = () =>
      new OverlayManager({
        ui,
        keys: defaultKeybindings(),
        theme: plain.theme,
        env: {},
        reaches: () => true,
        view: () =>
          ({
            openOverlay: () => {},
            closeOverlay: () => {},
            requestRender: () => {},
            requestOverlayRender: () => {},
            renderOverlay: () => {},
          }) as unknown as TranscriptView,
        emitWaiting: () => {},
        working: () => false,
        interrupt: () => {},
        quitting: () => false,
        editorEmpty: () => true,
        searchActive: () => false,
        searchHint: () => undefined,
        inputFocused: () => {},
        renderInput: () => [],
      })
    const first = mount()
    let replacement = first
    try {
      first.onUiRequest(request)
      for (const character of "old") first.handleInput(textKey(character))
      first.handleInput(key("s", { ctrl: true }))
      expect(checks).toBe(1)
      first.detachConversation()
      if (recreate) replacement = mount()
      replacement.onUiRequest(structuredClone(request))
      for (const character of "new") replacement.handleInput(textKey(character))
      save.resolve({})
      await tick()
      expect(ui.requestState(request.requestId)).toBe("pending")
      expect(replacement.render(100, { ...plain, rows: 30 }).join("\n")).not.toContain(
        "stale form evaluation",
      )
      replacement.handleInput(key("s", { ctrl: true }))
      await tick()
      expect(await answer).toEqual({ name: recreate ? "new" : "oldnew" })
    } finally {
      save.resolve({})
      first.dispose()
      if (replacement !== first) replacement.dispose()
      ui.cancelAll()
      await answer
    }
  })
}

test("mounting a replacement fences delayed and in-flight operations from the abandoned editor", async () => {
  const action = Promise.withResolvers<FormActionResult>()
  const save = Promise.withResolvers<FormActionResult>()
  let actions = 0
  let checks = 0
  let changes = 0
  const ui = new UiRequests(new EventBus())
  const answer = ui.form({
    title: "Retained authority",
    fields: [
      { type: "text", id: "name", label: "Name" },
      {
        type: "select",
        id: "choice",
        label: "Choice",
        options: [{ value: "original" }],
        default: "original",
      },
      {
        type: "action",
        id: "load",
        label: "Load",
        run: () => {
          actions++
          return action.promise
        },
      },
    ],
    change: () => {
      changes++
      return {}
    },
    beforeSubmit: async () => {
      checks++
      return checks === 1 ? save.promise : {}
    },
  })
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  const backend = createUiFormBackend(ui, request)
  let draft: FormDraft = { revision: -1, values: {} }
  let mounts = 0
  const mount = () => {
    const host = mounts++ ? createUiFormBackend(ui, structuredClone(request)) : backend
    return new FormView(
      operationFormBackend({
        ...host,
        evaluate: (value) => {
          draft = value
          return host.evaluate(value)
        },
      }),
      { requestRender: () => {}, onClose: () => {} },
    )
  }
  const first = mount()
  let replacement: FormView | undefined
  try {
    for (const character of "abcdef") first.handleInput(textKey(character))
    const old = draft
    const pendingAction = backend.runAction({ ...old, action: "load" })
    const pendingSave = backend.submit(old)
    expect(actions).toBe(1)
    expect(checks).toBe(1)
    first.close(true)
    replacement = mount()
    const resumed = draft
    expect(resumed.revision).toBe(7)
    expect(resumed.editor).not.toBe(old.editor)
    // Neither a higher revision nor a coincidentally matching revision restores old authority.
    for (const revision of [resumed.revision, 1000]) {
      expect(() => backend.evaluate({ ...old, revision, previous: {} })).toThrow("stale form evaluation")
      expect((await backend.runAction({ ...old, revision, action: "load" })).status).toBe("stale")
      expect((await backend.submit({ ...old, revision })).status).toBe("stale")
    }
    expect(() => backend.evaluate({ revision: 1000, values: {} })).toThrow("stale form evaluation")
    expect((await backend.cancel(old.editor)).status).toBe("invalid")
    expect((await backend.cancel()).status).toBe("invalid")
    expect(actions).toBe(1)
    expect(checks).toBe(1)
    expect(changes).toBe(6)
    action.resolve({ options: { choice: [{ value: "stale action" }] } })
    save.resolve({ options: { choice: [{ value: "stale save" }] } })
    expect((await pendingAction).status).toBe("stale")
    expect((await pendingSave).status).toBe("stale")
    expect(ui.formOptions(request.requestId)).toEqual({})
    expect(ui.requestState(request.requestId)).toBe("pending")
    replacement.handleInput(textKey("z"))
    replacement.handleInput(key("s", { ctrl: true }))
    await tick()
    expect(replacement.closed).toBe(true)
    expect(await answer).toEqual({ name: "z", choice: "original" })
  } finally {
    action.resolve({})
    save.resolve({})
    first.close()
    replacement?.close()
    ui.cancelAll()
    await answer
  }
})

test("an asynchronous editor claim preserves early edits and keeps presentation reads local", async () => {
  const ui = new UiRequests(new EventBus())
  const answer = ui.form({ title: "Remote claim", fields: [{ type: "text", id: "name", label: "Name" }] })
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  const backend = createUiFormBackend(ui, request)
  const first = new FormView(operationFormBackend(backend), { requestRender: () => {}, onClose: () => {} })
  for (const character of "abcdef") first.handleInput(textKey(character))
  first.close(true)
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const revisions: number[] = []
  const view = new FormView(
    operationFormBackend({
      ...backend,
      openEditor: async (options) => {
        calls++
        const claim = await backend.openEditor!(options)
        await gate.promise
        return JSON.parse(JSON.stringify(claim))
      },
      evaluate: async (draft) => {
        calls++
        revisions.push(draft.revision)
        return backend.evaluate(JSON.parse(JSON.stringify(draft)))
      },
    }),
    { requestRender: () => {}, onClose: () => {} },
  )
  try {
    view.handleInput(textKey("z"))
    view.handleInput(key("s", { ctrl: true }))
    for (let i = 0; i < 3; i++) view.render(100, { ...plain, rows: 30 })
    expect(calls).toBe(1)
    expect(ui.requestState(request.requestId)).toBe("pending")
    gate.resolve()
    await tick()
    expect(revisions).toEqual([8])
    expect(view.form.values.name).toBe("z")
    for (let i = 0; i < 3; i++) view.render(100, { ...plain, rows: 30 })
    expect(calls).toBe(2)
    view.handleInput(key("s", { ctrl: true }))
    await tick()
    expect(view.closed).toBe(true)
    expect(await answer).toEqual({ name: "z" })
  } finally {
    gate.resolve()
    view.close()
    ui.cancelAll()
    await answer
  }
})

test("cancellation waits for an asynchronous claim and a detached claimant cannot cancel its replacement", async () => {
  const ui = new UiRequests(new EventBus())
  const answer = ui.form({ title: "Cancel claim", fields: [{ type: "text", id: "name", label: "Name" }] })
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  const backend = createUiFormBackend(ui, request)
  const gate = Promise.withResolvers<void>()
  let cancels = 0
  const adapter = operationFormBackend({
    ...backend,
    openEditor: async (options) => {
      const claim = await backend.openEditor!(options)
      await gate.promise
      return claim
    },
    cancel: (editor) => {
      cancels++
      return backend.cancel(editor)
    },
  })
  const mount = () => new FormView(adapter, { requestRender: () => {}, onClose: () => {} })
  const first = mount()
  let replacement: FormView | undefined
  try {
    first.handleInput(key("escape"))
    expect(cancels).toBe(0)
    first.close(true)
    replacement = mount()
    replacement.handleInput(key("escape"))
    expect(cancels).toBe(0)
    gate.resolve()
    await tick()
    expect(cancels).toBe(1)
    expect(replacement.closed).toBe(true)
    expect(await answer).toBeUndefined()
  } finally {
    gate.resolve()
    first.close()
    replacement?.close()
    ui.cancelAll()
    await answer
  }
})

test("an abandoned delayed claim cannot revoke the replacement editor", async () => {
  const ui = new UiRequests(new EventBus())
  const answer = ui.form({ title: "Delayed claim", fields: [{ type: "text", id: "name", label: "Name" }] })
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  const backend = createUiFormBackend(ui, request)
  const gate = Promise.withResolvers<void>()
  let claims = 0
  const adapter = operationFormBackend({
    ...backend,
    openEditor: async (options) => {
      if (++claims === 1) await gate.promise
      return backend.openEditor!(options)
    },
  })
  const mount = () => new FormView(adapter, { requestRender: () => {}, onClose: () => {} })
  const first = mount()
  first.close(true)
  const replacement = mount()
  try {
    await tick()
    replacement.handleInput(textKey("z"))
    gate.resolve()
    await tick()
    replacement.handleInput(textKey("y"))
    expect(replacement.render(100, { ...plain, rows: 30 }).join("\n")).not.toContain("stale form evaluation")
    replacement.handleInput(key("s", { ctrl: true }))
    await tick()
    expect(replacement.closed).toBe(true)
    expect(ui.requestState(request.requestId)).toBe("settled")
    expect(await answer).toEqual({ name: "zy" })
  } finally {
    gate.resolve()
    first.close()
    replacement.close()
    ui.cancelAll()
    await answer
  }
})

test("a replacement retries an obsolete running automatic action but retains its completed result", async () => {
  const firstResult = Promise.withResolvers<FormActionResult>()
  const replacementResult = Promise.withResolvers<FormActionResult>()
  let calls = 0
  let firstSignal: AbortSignal | undefined
  const ui = new UiRequests(new EventBus())
  const answer = ui.form({
    title: "Automatic replacement",
    fields: [
      { type: "text", id: "name", label: "Name", default: "Ada" },
      { type: "select", id: "choice", label: "Choice", options: [{ value: "original" }] },
      {
        type: "action",
        id: "load",
        label: "Load",
        auto: { watch: ["name"], ready: () => true },
        run: (context) => {
          calls++
          if (calls === 1) {
            firstSignal = context.signal
            return firstResult.promise
          }
          return replacementResult.promise
        },
      },
    ],
  })
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  const backend = createUiFormBackend(ui, request)
  const adapter = operationFormBackend(backend)
  const mount = () => new FormView(adapter, { requestRender: () => {}, onClose: () => {} })
  const first = mount()
  let replacement: FormView | undefined
  let third: FormView | undefined
  try {
    await tick()
    expect(calls).toBe(1)
    first.close(true)
    expect(firstSignal?.aborted).toBe(false)
    replacement = mount()
    await tick()
    expect(calls).toBe(2)
    expect(firstSignal?.aborted).toBe(true)
    replacementResult.resolve({ options: { choice: [{ value: "loaded" }] } })
    await tick()
    expect(ui.formOptions(request.requestId)).toEqual({ choice: [{ value: "loaded" }] })
    expect(replacement.render(100, { ...plain, rows: 30 }).join("\n")).toContain("loaded")
    // The old attempt finishes after the replacement has recorded the same fingerprint.
    firstResult.resolve({ options: { choice: [{ value: "obsolete" }] } })
    await tick()
    expect(ui.formOptions(request.requestId)).toEqual({ choice: [{ value: "loaded" }] })
    replacement.close(true)
    third = mount()
    await tick()
    expect(calls).toBe(2)
    expect(third.render(100, { ...plain, rows: 30 }).join("\n")).toContain("loaded")
  } finally {
    firstResult.resolve({})
    replacementResult.resolve({})
    first.close()
    replacement?.close()
    third?.close()
    ui.cancelAll()
    await answer
  }
})

test("a replacement editor saves against the same retained backend after six edits", async () => {
  const ui = new UiRequests(new EventBus())
  const answer = ui.form({ title: "Retained form", fields: [{ type: "text", id: "name", label: "Name" }] })
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  const backend = createUiFormBackend(ui, request)
  const revisions: number[] = []
  const adapter = operationFormBackend({
    ...backend,
    evaluate: (draft) => {
      revisions.push(draft.revision)
      return backend.evaluate(draft)
    },
  })
  const mount = () => new FormView(adapter, { requestRender: () => {}, onClose: () => {} })
  const first = mount()
  let replacement: FormView | undefined
  try {
    for (const character of "abcdef") first.handleInput(textKey(character))
    expect(revisions.at(-1)).toBe(6)
    first.close(true)
    replacement = mount()
    await tick()
    expect(revisions.at(-1)).toBe(7)
    expect(replacement.render(100, { ...plain, rows: 30 }).join("\n")).not.toContain("stale form evaluation")
    replacement.handleInput(textKey("z"))
    replacement.handleInput(key("s", { ctrl: true }))
    await tick()
    expect(ui.requestState(request.requestId)).toBe("settled")
    expect(replacement.closed).toBe(true)
    expect(await answer).toEqual({ name: "z" })
  } finally {
    first.close()
    replacement?.close()
    ui.cancelAll()
    await answer
  }
})

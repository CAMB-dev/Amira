import { expect, test } from "bun:test"
import { type MarkdownRenderResult, toFormSchema } from "@amira/api"
import { EventBus, UiRequests } from "@amira/core"
import { key, textKey } from "@amira/tui-kit"
import type {
  FormEvaluation,
  FrontendFormBackend,
  UiResponseAck,
} from "../../core/src/frontend/form-backend.ts"
import { plain } from "../../tui-kit/test/context.ts"
import { ExtensionSettingsView, uiExtensionSettingsBackend } from "../src/extension-settings-view.ts"
import { operationFormBackend } from "../src/form-operation-backend.ts"
import { FormView } from "../src/form-view.ts"

const schema = toFormSchema({
  title: "Remote form",
  fields: [
    { type: "text", id: "name", label: "Name" },
    {
      type: "action",
      id: "load",
      label: "Load",
      auto: { watch: ["name"], ready: () => true },
      run: async () => ({}),
    },
  ],
})

const evaluation = (revision: number, text: string): FormEvaluation => ({
  revision,
  errors: {},
  visible: { name: true, load: true },
  preview: [text],
  autoActions: [],
  change: {},
})

function backend(overrides: Partial<FrontendFormBackend> = {}): FrontendFormBackend {
  return {
    schema,
    evaluate: (draft) => evaluation(draft.revision, "cached"),
    runAction: async (draft) => ({ revision: draft.revision, status: "accepted" }),
    submit: async (draft) => ({ revision: draft.revision, status: "accepted" }),
    cancel: () => ({ status: "cancelled" }),
    ...overrides,
  }
}

const tick = () => Bun.sleep(0)

test("reordered and stalled evaluations preserve the draft and render only the newest cache", async () => {
  const pending: { revision: number; done: ReturnType<typeof Promise.withResolvers<FormEvaluation>> }[] = []
  const host = backend({
    evaluate: (draft) => {
      const done = Promise.withResolvers<FormEvaluation>()
      pending.push({ revision: draft.revision, done })
      return done.promise
    },
  })
  const view = new FormView(operationFormBackend(host), { requestRender: () => {}, onClose: () => {} })
  try {
    await tick()
    view.handleInput(textKey("a"))
    view.handleInput(textKey("b"))
    expect(view.form.values.name).toBe("ab")
    pending.at(-1)!.done.resolve(evaluation(2, "new preview"))
    await tick()
    pending[0]!.done.resolve(evaluation(0, "stale preview"))
    await tick()
    const frame = view.render(100, { ...plain, rows: 30 }).join("\n")
    expect(frame).toContain("new preview")
    expect(frame).not.toContain("stale preview")
    expect(view.form.values.name).toBe("ab")
  } finally {
    view.close()
    for (const item of pending) item.done.resolve(evaluation(item.revision, "late"))
  }
})

test("submit and cancel await acknowledgement; disconnect leaves the draft open", async () => {
  const save = Promise.withResolvers<{ revision: number; status: "disconnected"; message: string }>()
  const cancel = Promise.withResolvers<UiResponseAck>()
  let closed = 0
  const host = backend({ submit: () => save.promise, cancel: () => cancel.promise })
  const view = new FormView(operationFormBackend(host), { requestRender: () => {}, onClose: () => closed++ })
  try {
    await tick()
    view.handleInput(textKey("a"))
    view.handleInput(key("s", { ctrl: true }))
    expect(view.closed).toBe(false)
    save.resolve({ revision: 1, status: "disconnected", message: "Connection lost" })
    await tick()
    expect(view.closed).toBe(false)
    expect(view.form.values.name).toBe("a")
    expect(view.render(100, { ...plain, rows: 30 }).join("\n")).toContain("Connection lost")
    view.handleInput(key("escape"))
    view.handleInput(textKey("y"))
    expect(view.closed).toBe(false)
    cancel.resolve({ status: "cancelled" })
    await tick()
    expect(view.closed).toBe(true)
    expect(closed).toBe(1)
  } finally {
    view.close()
  }
})

for (const kind of ["form", "settings"] as const) {
  for (const reject of [false, true]) {
    test(`a detached ${kind} ignores a late cancellation ${reject ? "rejection" : "acknowledgement"}`, async () => {
      const cancel = Promise.withResolvers<UiResponseAck>()
      let renders = 0
      const options = { requestRender: () => renders++, onClose: () => {} }
      const view =
        kind === "form"
          ? new FormView(operationFormBackend(backend({ cancel: () => cancel.promise })), options)
          : new ExtensionSettingsView(
              {
                request: {
                  kind: "extension-settings",
                  requestId: "page",
                  name: "page",
                  title: "Settings",
                  fields: [],
                  values: {},
                  scope: "project",
                },
                submit: async () => undefined,
                cancel: () => cancel.promise,
              },
              options,
            )
      view.handleInput(key("escape"))
      view.close()
      const before = renders
      if (reject) cancel.reject(new Error("obsolete cancel"))
      else cancel.resolve({ status: "invalid", message: "obsolete cancel" })
      await tick()
      expect(renders).toBe(before)
    })
  }
}

test("an action reply with the wrong revision never updates the draft", async () => {
  const adapter = operationFormBackend(
    backend({
      runAction: async (draft) => ({
        revision: draft.revision - 1,
        status: "accepted",
        result: { values: { name: "obsolete" } },
      }),
    }),
  )
  const result = await adapter.runAction(
    "load",
    { name: "new" },
    {
      revision: 5,
      signal: new AbortController().signal,
      onProgress: () => {},
    },
  )
  expect(result).toEqual({ message: "Form changed. Try the action again.", tone: "error" })
})

test("a stale action acknowledgement is an explicit error, never empty success", async () => {
  const adapter = operationFormBackend(
    backend({ runAction: async (draft) => ({ revision: draft.revision, status: "stale" }) }),
  )
  const result = await adapter.runAction(
    "load",
    {},
    {
      revision: 1,
      signal: new AbortController().signal,
      onProgress: () => {},
    },
  )
  expect(result).toEqual({ message: "Form changed. Try the action again.", tone: "error" })
})

test("replay mounts never start automatic actions", async () => {
  let calls = 0
  const host = backend({
    evaluate: (draft) => ({ ...evaluation(draft.revision, "replayed"), autoActions: ["load"] }),
    runAction: async (draft) => {
      calls++
      return { revision: draft.revision, status: "accepted" }
    },
  })
  const view = new FormView(operationFormBackend(host), {
    replay: true,
    requestRender: () => {},
    onClose: () => {},
  })
  try {
    await tick()
    view.render(100, { ...plain, rows: 30 })
    view.handleInput(key("tab"))
    await tick()
    expect(calls).toBe(0)
    view.handleInput(key("tab", { shift: true }))
    view.handleInput(textKey("a"))
    view.handleInput(key("tab"))
    await tick()
    expect(calls).toBe(1)
  } finally {
    view.close()
  }
})

test("settings recreation fences an old save and delayed submit/cancel admissions", async () => {
  const save = Promise.withResolvers<void>()
  const ui = new UiRequests(new EventBus())
  let saves = 0
  ui.setExtensionSettingsAccessor(() => ({
    fields: [],
    get: () => ({}),
    defaultScope: "project",
    save: () => {
      saves++
      return saves === 1 ? save.promise : undefined
    },
  }))
  const answer = ui.extensionSettings("page")
  const request = ui.pending[0]!
  if (request.kind !== "extension-settings") throw new Error("expected settings")
  const old = uiExtensionSettingsBackend(ui, request)
  try {
    const pending = old.submit({}, "project")
    expect(saves).toBe(1)
    const replacement = uiExtensionSettingsBackend(ui, structuredClone(request))
    save.resolve()
    expect(await pending).toMatchObject({ status: "invalid" })
    expect(ui.requestState(request.requestId)).toBe("pending")
    expect(await old.submit({}, "project")).toMatchObject({ status: "invalid" })
    expect(await old.cancel()).toMatchObject({ status: "invalid" })
    expect(saves).toBe(1)
    expect(await replacement.submit({}, "user")).toMatchObject({ status: "accepted" })
    expect(await answer).toEqual({ values: {}, scope: "user" })
  } finally {
    save.resolve()
    ui.cancelAll()
    await answer
  }
})

test("settings revisions ignore old preview replies and disconnected acknowledgements keep the editor", async () => {
  const pending: {
    revision: number
    done: ReturnType<typeof Promise.withResolvers<{ revision: number; preview: MarkdownRenderResult }>>
  }[] = []
  let cancel: UiResponseAck = { status: "disconnected", message: "Not connected" }
  const view = new ExtensionSettingsView(
    {
      request: {
        kind: "extension-settings",
        requestId: "page",
        name: "page",
        title: "Settings",
        fields: [{ key: "count", type: "number", label: "Count", default: 1 }],
        values: { count: 1 },
        scope: "project",
      },
      evaluate: (draft) => {
        const done = Promise.withResolvers<{ revision: number; preview: MarkdownRenderResult }>()
        pending.push({ revision: draft.revision, done })
        return done.promise
      },
      submit: async () => ({ status: "disconnected", message: "Not connected" }),
      cancel: () => cancel,
    },
    { requestRender: () => {}, onClose: () => {} },
  )
  const frame = () => view.render(100, { ...plain, rows: 30 }).join("\n")
  try {
    frame()
    await tick()
    view.handleInput(key("right"))
    frame()
    await tick()
    expect(pending).toHaveLength(2)
    pending[1]!.done.resolve({
      revision: pending[1]!.revision,
      preview: { lines: [{ kind: "text", text: "current preview" }] },
    })
    await tick()
    pending[0]!.done.resolve({
      revision: pending[0]!.revision,
      preview: { lines: [{ kind: "text", text: "stale preview" }] },
    })
    await tick()
    expect(frame()).toContain("current preview")
    expect(frame()).not.toContain("stale preview")
    view.handleInput(key("enter"))
    view.handleInput(key("enter"))
    await tick()
    expect(view.closed).toBe(false)
    expect(view.values.count).toBe(2)
    expect(frame()).toContain("Not connected")
    view.handleInput(key("escape"))
    expect(view.closed).toBe(false)
    cancel = { status: "cancelled" }
    view.handleInput(key("escape"))
    expect(view.closed).toBe(true)
  } finally {
    view.close()
  }
})

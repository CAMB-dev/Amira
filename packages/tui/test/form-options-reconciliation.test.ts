import { expect, spyOn, test } from "bun:test"
import type { FormOption, FormSpec } from "@amira/api"
import { createUiFormBackend, EventBus, UiRequests } from "@amira/core"
import { key, textKey } from "@amira/tui-kit"
import { operationFormBackend } from "../src/form-operation-backend.ts"
import { FormView, uiFormBackend } from "../src/form-view.ts"

function setup(spec: FormSpec, hosted = true) {
  const ui = new UiRequests(new EventBus())
  const answer = ui.form(spec)
  const request = ui.pending[0]!
  if (request.kind !== "form") throw new Error("expected form")
  const backend = hosted ? operationFormBackend(createUiFormBackend(ui, request)) : uiFormBackend(ui, request)
  const view = new FormView(backend, { requestRender: () => {}, onClose: () => {} })
  return {
    view,
    async close() {
      view.close()
      ui.cancelAll()
      await answer
    },
  }
}

test("hosted option reconciliation compares schema and snapshots by content, including metadata and order", async () => {
  const initial: FormOption[] = [
    { value: "first", label: "First", group: "Models", description: "Original", detail: ["128k", "$1"] },
    { value: "second" },
    { value: "third" },
  ]
  let options: FormOption[] = [
    { detail: ["128k", "$1"], description: "Original", group: "Models", label: "First", value: "first" },
    { value: "second" },
    { value: "third" },
  ]
  const s = setup({
    title: "Models",
    fields: [
      { type: "multiselect", id: "models", label: "Models", options: initial },
      { type: "checkbox", id: "refresh", label: "Refresh" },
    ],
    change: () => ({ options: { models: options } }),
  })
  const setOptions = spyOn(s.view.form, "setOptions")
  const refresh = () => {
    s.view.handleInput(key("tab"))
    s.view.handleInput(textKey(" "))
    s.view.handleInput(key("tab", { shift: true }))
  }
  try {
    s.view.handleInput(key("down"))
    refresh()
    expect(setOptions).not.toHaveBeenCalled()
    s.view.handleInput(textKey(" "))
    expect(s.view.form.values.models).toEqual(["second"])
    s.view.handleInput(textKey(" "))
    expect(s.view.form.values.models).toEqual([])
    expect(setOptions).not.toHaveBeenCalled()

    for (const patch of [
      { label: "Renamed" },
      { group: "Other models" },
      { description: "Updated" },
      { detail: ["256k", "$2"] },
      { value: "replacement" },
    ]) {
      Object.assign(options[0]!, patch)
      setOptions.mockClear()
      refresh()
      expect(setOptions).toHaveBeenCalledTimes(1)
      expect(setOptions).toHaveBeenCalledWith("models", options)
    }
    for (const replacement of [[options[2]!, options[1]!, options[0]!], []]) {
      options = replacement
      setOptions.mockClear()
      refresh()
      expect(setOptions).toHaveBeenCalledTimes(1)
      expect(setOptions).toHaveBeenCalledWith("models", options)
    }
    setOptions.mockClear()
    refresh()
    expect(setOptions).not.toHaveBeenCalled()
  } finally {
    setOptions.mockRestore()
    await s.close()
  }
})

for (const hosted of [false, true]) {
  test(`${hosted ? "hosted" : "direct"} loaded checklist toggles the highlighted second model twice`, async () => {
    const s = setup(
      {
        title: "Models",
        fields: [
          { type: "multiselect", id: "models", label: "Models", options: [] },
          {
            type: "action",
            id: "load",
            label: "Load models",
            run: async () => ({
              options: { models: [{ value: "first" }, { value: "second" }, { value: "third" }] },
            }),
          },
        ],
      },
      hosted,
    )
    try {
      s.view.handleInput(key("tab"))
      expect(s.view.form.focused).toBe("load")
      s.view.handleInput(key("enter"))
      await Bun.sleep(0)
      s.view.handleInput(key("tab", { shift: true }))
      expect(s.view.form.focused).toBe("models")
      s.view.handleInput(key("down"))
      s.view.handleInput(textKey(" "))
      expect(s.view.form.values.models).toEqual(["second"])
      s.view.handleInput(textKey(" "))
      expect(s.view.form.values.models).toEqual([])
    } finally {
      await s.close()
    }
  })
}

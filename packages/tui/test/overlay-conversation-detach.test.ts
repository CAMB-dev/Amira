import { expect, test } from "bun:test"
import type { EventMap, UiControl, ViewDefinition } from "@amira/api"
import { EventBus, UiRequests } from "@amira/core"
import { CURSOR_MARKER, key, textKey } from "@amira/tui-kit"
import { plain as ctx } from "../../tui-kit/test/context.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import type { TranscriptView } from "../src/view.ts"

function setup(_mode: "fullscreen", definition?: ViewDefinition) {
  const errors: unknown[] = []
  const bus = new EventBus((error) => errors.push(error))
  const ui = new UiRequests(bus)
  const calls: string[] = []
  const renders: string[] = []
  const changes: EventMap["ui.waiting"][] = []
  let focused = true
  let unwatch = 0
  const transcript = (name: string) => {
    const state = { overlay: false, visible: true }
    const view = {
      openOverlay: () => {
        expect(state.visible).toBe(true)
        state.overlay = true
        calls.push(`${name}:open`)
      },
      closeOverlay: () => {
        expect(state.visible).toBe(true)
        state.overlay = false
        calls.push(`${name}:close`)
      },
      renderOverlay: () => {},
      requestOverlayRender: () => renders.push(`${name}:overlay`),
      requestRender: () => renders.push(`${name}:input`),
      dialogEcho: () => {},
    } as unknown as TranscriptView
    return { state, view }
  }
  const main = transcript("main")
  const child = transcript("child")
  child.state.visible = false
  let active = main
  const manager = new OverlayManager({
    ui,
    keys: defaultKeybindings(),
    theme: ctx.theme,
    env: {},
    views: {
      get: () => definition,
      watch: () => () => {
        unwatch++
      },
    },
    reaches: () => true,
    view: () => active.view,
    emitWaiting: (data) => changes.push(data),
    working: () => false,
    interrupt: () => {},
    quitting: () => false,
    editorEmpty: () => true,
    searchActive: () => false,
    searchHint: () => undefined,
    inputFocused: (value) => {
      focused = value
    },
    renderInput: () => [],
  })
  const off = bus.subscribe((event) => {
    if (event.type === "ui.resolved") manager.onUiResolved(event.data)
  })
  return {
    manager,
    ui,
    bus,
    main,
    child,
    calls,
    renders,
    changes,
    errors,
    focused: () => focused,
    unwatch: () => unwatch,
    switchTo(next: typeof main, requests: EventMap["ui.request"][] = []) {
      manager.detachConversation()
      expect(manager.hasFullscreen).toBe(false)
      expect(manager.dialogs).toHaveLength(0)
      expect(active.state.overlay).toBe(false)
      active.state.visible = false
      active = next
      active.state.visible = true
      for (const request of requests) manager.onUiRequest(request)
    },
    dispose() {
      off()
      manager.dispose()
      for (const request of ui.pending) ui.cancel(request.requestId)
    },
  }
}

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: pending form, queued form and dialog detach without settling and reopen on return`, async () => {
    const app = setup(mode)
    try {
      const first = app.ui.api("test").form({ title: "Main form", fields: [] })
      const second = app.ui.api("test").form({ title: "Queued form", fields: [] })
      const answer = app.ui.api("test").confirm("Main question")
      const requests = [...app.ui.pending]
      for (const request of requests) app.manager.onUiRequest(request)
      expect(app.manager.render(80, ctx).join("\n")).toContain("Main form")
      expect(app.calls).toEqual(["main:open"])

      app.switchTo(app.child)
      expect(app.manager.render(80, ctx)).toEqual([])
      expect(app.manager.handleInput(key("escape"))).toBe(false)
      expect(app.calls).toEqual(["main:open", "main:close"])
      expect(app.changes.at(-1)).toMatchObject({ pending: 0, hidden: false, change: "visibility" })
      expect(app.focused()).toBe(true)
      for (const request of requests) expect(app.ui.requestState(request.requestId)).toBe("pending")
      await app.bus.flush()
      expect(app.ui.pending).toHaveLength(3)

      app.switchTo(app.main, requests)
      expect(app.manager.hasFullscreen).toBe(true)
      expect(app.manager.render(80, ctx).join("\n")).toContain("Main form")
      expect(app.manager.dialogs).toHaveLength(1)
      expect(app.calls).toEqual(["main:open", "main:close", "main:open"])
      expect(app.ui.respond(requests[0]!.requestId, {})).toBeUndefined()
      await app.bus.flush()
      // The dialog keeps the queued form waiting, just as before the switch.
      expect(app.manager.hasFullscreen).toBe(false)
      app.manager.dialogs[0]!.handleInput(key("down"))
      app.manager.dialogs[0]!.handleInput(key("enter"))
      await app.bus.flush()
      expect(app.manager.render(80, ctx).join("\n")).toContain("Queued form")
      expect(app.ui.respond(requests[1]!.requestId, {})).toBeUndefined()
      await app.bus.flush()
      expect(await first).toEqual({})
      expect(await second).toEqual({})
      expect(await answer).toBe(true)
      expect(app.errors).toEqual([])
    } finally {
      app.dispose()
    }
  })

  test(`${mode}: key reference detaches without opening a queued form on the old transcript`, async () => {
    const app = setup(mode)
    try {
      app.manager.openKeyReference()
      const result = app.ui.api("test").form({ title: "Waiting form", fields: [] })
      const request = app.ui.pending[0]!
      app.manager.onUiRequest(request)
      expect(app.manager.render(80, ctx).join("\n")).toContain("Keys")
      expect(app.focused()).toBe(false)
      app.switchTo(app.child)
      expect(app.calls).toEqual(["main:open", "main:close"])
      expect(app.focused()).toBe(true)
      expect(app.ui.requestState(request.requestId)).toBe("pending")
      app.switchTo(app.main, [request])
      expect(app.manager.render(80, ctx).join("\n")).toContain("Waiting form")
      expect(app.manager.handleInput(key("escape"))).toBe(true)
      await app.bus.flush()
      expect(await result).toBeUndefined()
      app.manager.openKeyReference()
      expect(app.manager.render(80, ctx).join("\n")).toContain("Keys")
      app.manager.handleInput(key("escape"))
      expect(app.manager.hasFullscreen).toBe(false)
      expect(app.errors).toEqual([])
    } finally {
      app.dispose()
    }
  })

  test(`${mode}: detached external settings request can be replayed without becoming settled`, () => {
    const app = setup(mode)
    const request: EventMap["ui.request"] = {
      kind: "extension-settings",
      requestId: "settings",
      name: "test",
      title: "Main settings",
      fields: [{ key: "name", type: "text", label: "Name", default: "" }],
      values: {},
      scope: "user",
    }
    try {
      app.manager.onUiRequest(request)
      for (const text of "Settings draft") app.manager.handleInput(textKey(text))
      app.manager.handleInput(key("left"))
      app.switchTo(app.child)
      app.switchTo(app.main, [structuredClone(request)])
      expect(app.manager.hasFullscreen).toBe(true)
      expect(app.manager.render(80, ctx).join("\n")).toContain("Main settings")
      expect(app.manager.render(80, ctx).join("\n")).toContain(`Settings draf${CURSOR_MARKER}t`)
      app.manager.handleInput(textKey("!"))
      expect(app.manager.render(80, ctx).join("\n")).toContain(`Settings draf!${CURSOR_MARKER}t`)
      app.switchTo(app.child)
      app.manager.onUiResolved({ requestId: request.requestId, cancelled: false })
      app.switchTo(app.main, [request])
      expect(app.manager.hasFullscreen).toBe(false)
      expect(app.errors).toEqual([])
    } finally {
      app.dispose()
    }
  })

  test(`${mode}: suspended dialog is reused with selection, filtering and refreshed presentation intact`, () => {
    const app = setup(mode)
    const request: EventMap["ui.request"] = {
      kind: "select",
      requestId: "live-owned-picker",
      title: "Owned picker",
      options: ["Beta One", "Beta Two", "Gamma"],
      optionStatuses: ["working", "working", "working"],
    }
    try {
      app.manager.onUiRequest(request)
      const dialog = app.manager.dialogs[0]!
      for (const text of "Beta") dialog.handleInput(textKey(text))
      dialog.handleInput(key("down"))
      const before = dialog.render(80, ctx).join("\n")
      expect(before).toContain("Beta Two")
      expect(before).not.toContain("Gamma")
      app.switchTo(app.child)
      app.switchTo(app.main, [{ ...structuredClone(request), optionStatuses: ["done", "paused", "done"] }])
      expect(app.manager.dialogs).toEqual([dialog])
      const after = dialog.render(80, ctx).join("\n")
      expect(after).toContain("Beta Two")
      expect(after).toContain("paused")
      expect(after).not.toContain("Gamma")
      dialog.handleInput(key("enter"))
      expect(app.manager.dialogs).toHaveLength(0)
      app.manager.onUiRequest(structuredClone(request))
      expect(app.manager.dialogs).toHaveLength(0)
      expect(app.errors).toEqual([])
    } finally {
      app.dispose()
    }
  })

  test(`${mode}: background form action retains its editor but never repaints the active other form`, async () => {
    const app = setup(mode)
    let progress!: (text: string) => void
    let finish!: () => void
    let signal!: AbortSignal
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    try {
      const answer = app.ui.api("owned").form({
        title: "Suspended action form",
        fields: [
          { type: "text", id: "name", label: "Name" },
          {
            type: "action",
            id: "check",
            label: "Check",
            run: async (action) => {
              progress = action.progress
              signal = action.signal
              await done
              return { message: "Completed while hidden" }
            },
          },
        ],
      })
      const request = app.ui.pending[0]!
      app.manager.onUiRequest(request)
      for (const text of "Unfinished") app.manager.handleInput(textKey(text))
      app.manager.handleInput(key("tab"))
      app.manager.handleInput(key("enter"))
      await app.bus.flush()
      expect(signal.aborted).toBe(false)
      app.switchTo(app.child)
      const child = app.ui.api("child").form({ title: "Active child form", fields: [] })
      const childRequest = app.ui.pending.find((pending) => pending.requestId !== request.requestId)!
      app.manager.onUiRequest(childRequest)
      const calls = [...app.calls]
      const renders = [...app.renders]
      expect(signal.aborted).toBe(false)
      progress("Hidden progress")
      finish()
      await done
      await Bun.sleep(0)
      expect(app.calls).toEqual(calls)
      expect(app.renders).toEqual(renders)
      expect(app.manager.render(80, ctx).join("\n")).toContain("Active child form")
      app.switchTo(app.main, [structuredClone(request)])
      const rows = app.manager.render(80, ctx).join("\n")
      expect(rows).toContain("Unfinished")
      expect(rows).toContain("Completed while hidden")
      // Focus is still on Check: shift-tab reaches the same text buffer.
      app.manager.handleInput(key("tab", { shift: true }))
      app.manager.handleInput(textKey("!"))
      app.manager.handleInput(key("s", { ctrl: true }))
      expect(await answer).toEqual({ name: "Unfinished!" })
      await app.bus.flush()
      expect(app.manager.hasFullscreen).toBe(false)
      app.ui.cancel(childRequest.requestId)
      expect(await child).toBeUndefined()
      await app.bus.flush()
      expect(app.errors).toEqual([])
    } finally {
      finish()
      app.dispose()
    }
  })

  test(`${mode}: a suspended settings save closes only its own instance while another form is active`, async () => {
    const app = setup(mode)
    let finish!: () => void
    const saved = new Promise<void>((resolve) => {
      finish = resolve
    })
    try {
      app.ui.setExtensionSettingsAccessor(() => ({
        name: "owned-settings",
        title: "Saving owned settings",
        defaultScope: "project",
        fields: [{ type: "text", key: "name", label: "Name", default: "" }],
        get: () => ({ name: "Draft" }),
        save: async () => saved,
      }))
      const answer = app.ui.extensionSettings("owned-settings")
      const request = app.ui.pending[0]!
      app.manager.onUiRequest(request)
      app.manager.handleInput(key("enter"))
      app.manager.handleInput(key("enter"))
      expect(app.manager.render(80, ctx).join("\n")).toContain("saving settings")
      app.switchTo(app.child)
      const child = app.ui.api("child").form({ title: "Other active form", fields: [] })
      const childRequest = app.ui.pending.find((pending) => pending.requestId !== request.requestId)!
      app.manager.onUiRequest(childRequest)
      const calls = [...app.calls]
      const renders = [...app.renders]
      finish()
      expect(await answer).toMatchObject({ values: { name: "Draft" } })
      await app.bus.flush()
      await Bun.sleep(0)
      expect(app.calls).toEqual(calls)
      expect(app.renders).toEqual(renders)
      expect(app.manager.render(80, ctx).join("\n")).toContain("Other active form")
      app.switchTo(app.main, [structuredClone(request)])
      expect(app.manager.hasFullscreen).toBe(false)
      app.ui.cancel(childRequest.requestId)
      expect(await child).toBeUndefined()
      await app.bus.flush()
      expect(app.errors).toEqual([])
    } finally {
      finish()
      app.dispose()
    }
  })

  for (const reason of ["cancel", "resolve", "unload", "dispose"] as const) {
    test(`${mode}: ${reason} destroys suspended form and dialog without opening a hidden queued request`, async () => {
      const app = setup(mode)
      let signal!: AbortSignal
      let finish!: () => void
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      try {
        const answer = app.ui.api("owned").form({
          title: "Hidden form",
          fields: [
            {
              type: "action",
              id: "run",
              label: "Run",
              run: async (action) => {
                signal = action.signal
                await done
                return { message: "Stale result" }
              },
            },
          ],
        })
        const queued = app.ui.api("owned").form({ title: "Hidden queued form", fields: [] })
        const input = app.ui.api("owned").input("Hidden input")
        const requests = [...app.ui.pending]
        for (const request of requests) app.manager.onUiRequest(request)
        const dialog = app.manager.dialogs[0]!
        dialog.handleInput(textKey("x"))
        app.manager.handleInput(key("enter"))
        await app.bus.flush()
        expect(signal.aborted).toBe(false)
        app.switchTo(app.child)
        const calls = [...app.calls]
        const renders = [...app.renders]
        if (reason === "dispose") app.manager.dispose()
        else if (reason === "unload") app.ui.cancelAll("owned")
        else {
          for (const request of requests) {
            if (reason === "cancel") app.ui.cancel(request.requestId)
            else app.ui.respond(request.requestId, request.kind === "input" ? "external" : {})
          }
        }
        await app.bus.flush()
        expect(signal.aborted).toBe(true)
        expect(await answer).toEqual(reason === "resolve" ? {} : undefined)
        expect(await queued).toEqual(reason === "resolve" ? {} : undefined)
        expect(await input).toEqual(reason === "resolve" ? "external" : undefined)
        expect(dialog.handleInput(key("enter"))).toBe(false)
        expect(dialog.render(80, ctx)).toEqual([])
        finish()
        await done
        await Bun.sleep(0)
        expect(app.calls).toEqual(calls)
        expect(app.renders).toEqual(renders)
        expect(app.manager.hasFullscreen).toBe(false)
        app.switchTo(
          app.main,
          requests.map((request) => structuredClone(request)),
        )
        expect(app.manager.hasFullscreen).toBe(false)
        expect(app.manager.dialogs).toHaveLength(0)
        expect(app.errors).toEqual([])
      } finally {
        finish()
        app.dispose()
      }
    })
  }

  test(`${mode}: detaching disposes fullscreen viewers and docks once, ignoring stale close controls`, async () => {
    const controls: UiControl[] = []
    let closed = 0
    const app = setup(mode, {
      kind: "test",
      title: () => "Main viewer",
      render: () => [],
      onOpen: (_data, control) => {
        controls.push(control)
      },
      onClose: () => {
        closed++
      },
    })
    try {
      app.manager.openView({ kind: "test", placement: "dock" })
      app.manager.openView({ kind: "test" })
      const result = app.ui.api("test").form({ title: "Behind viewer", fields: [] })
      const request = app.ui.pending[0]!
      app.manager.onUiRequest(request)
      app.switchTo(app.child)
      expect(app.manager.dock).toBeUndefined()
      expect(closed).toBe(2)
      expect(app.unwatch()).toBe(2)
      for (const control of controls) control.close()
      expect(app.calls).toEqual(["main:open", "main:close"])
      expect(app.ui.requestState(request.requestId)).toBe("pending")
      app.switchTo(app.main, [request])
      expect(app.manager.render(80, ctx).join("\n")).toContain("Behind viewer")
      app.manager.dispose()
      expect(closed).toBe(2)
      await app.bus.flush()
      expect(await result).toBeUndefined()
      expect(app.errors).toEqual([])
    } finally {
      app.dispose()
    }
  })
}

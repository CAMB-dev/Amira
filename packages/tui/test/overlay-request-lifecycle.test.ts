import { expect, test } from "bun:test"
import type { EventMap } from "@amira/api"
import { EventBus, UiRequests } from "@amira/core"
import { key } from "@amira/tui-kit"
import { plain as ctx } from "../../tui-kit/test/context.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import type { TranscriptView } from "../src/view.ts"

function setup(_mode: "fullscreen" = "fullscreen") {
  const errors: unknown[] = []
  const bus = new EventBus((error) => errors.push(error))
  const ui = new UiRequests(bus)
  const changes: string[] = []
  const manager = new OverlayManager({
    ui,
    keys: defaultKeybindings(),
    theme: ctx.theme,
    env: {},
    reaches: () => true,
    view: () => ({ requestRender: () => {}, dialogEcho: () => {} }) as unknown as TranscriptView,
    emitWaiting: (data) => changes.push(data.change),
    working: () => false,
    interrupt: () => {},
    quitting: () => false,
    editorEmpty: () => true,
    searchActive: () => false,
    searchHint: () => undefined,
    inputFocused: () => {},
    renderInput: () => [],
  })
  const off = bus.subscribe((event) => {
    if (event.type === "ui.request") manager.onUiRequest(event.data)
    else if (event.type === "ui.resolved") manager.onUiResolved(event.data)
  })
  return {
    bus: {
      emit<K extends keyof EventMap>(type: K, data: EventMap[K]) {
        return bus.emit(type, data, { sessionId: "host" })
      },
      flush: () => bus.flush(),
    },
    ui,
    manager,
    changes,
    errors,
    dispose() {
      off()
      for (const request of ui.pending) ui.cancel(request.requestId)
      manager.dispose()
    },
  }
}

const external: EventMap["ui.request"] = {
  requestId: "short-model",
  kind: "select",
  title: "Model",
  options: ["first", "second"],
}

for (const mode of ["fullscreen"] as const) {
  test(`fresh externally announced request opens once and refreshes in ${mode}`, async () => {
    const app = setup(mode)
    try {
      app.bus.emit("ui.request", structuredClone(external))
      await app.bus.flush()
      expect(app.ui.pending).toHaveLength(0)
      expect(app.ui.requestState(external.requestId)).toBe("unknown")
      expect(app.manager.dialogs).toHaveLength(1)
      const dialog = app.manager.dialogs[0]!
      app.bus.emit("ui.request", structuredClone(external))
      app.bus.emit("ui.request", { ...external, optionStatuses: ["working", "done"] })
      await app.bus.flush()
      expect(app.manager.dialogs).toEqual([dialog])
      expect(dialog.request).toMatchObject({ optionStatuses: ["working", "done"] })
      expect(app.changes).toEqual(["opened"])
      expect(app.errors).toEqual([])
    } finally {
      app.dispose()
    }
  })
}

for (const pressed of ["enter", "escape"] as const) {
  test(`cloned external refresh after local ${pressed} cannot reopen the request`, async () => {
    const app = setup()
    try {
      app.bus.emit("ui.request", structuredClone(external))
      await app.bus.flush()
      expect(app.manager.dialogs).toHaveLength(1)
      app.bus.emit("ui.request", structuredClone(external))
      app.manager.dialogs[0]!.handleInput(key(pressed))
      expect(app.manager.dialogs).toHaveLength(0)
      await app.bus.flush()
      expect(app.manager.dialogs).toHaveLength(0)
      expect(app.changes).toEqual(["opened", "resolved"])
      expect(app.errors).toEqual([])
    } finally {
      app.dispose()
    }
  })
}

for (const announced of [false, true]) {
  test(`externally resolved ID cannot reopen, previously announced ${announced}`, async () => {
    const app = setup()
    try {
      if (announced) {
        app.bus.emit("ui.request", structuredClone(external))
        await app.bus.flush()
        expect(app.manager.dialogs).toHaveLength(1)
      }
      app.bus.emit("ui.resolved", { requestId: external.requestId, cancelled: false })
      await app.bus.flush()
      app.bus.emit("ui.request", structuredClone(external))
      await app.bus.flush()
      expect(app.manager.dialogs).toHaveLength(0)
      expect(app.changes).toEqual(announced ? ["opened", "resolved"] : [])
      expect(app.errors).toEqual([])
    } finally {
      app.dispose()
    }
  })
}

for (const cancelled of [false, true]) {
  test(`registered request settled before initial delivery never opens, cancelled ${cancelled}`, async () => {
    const app = setup()
    try {
      const result = app.ui.api("test").select("Model", ["first", "second"])
      const request = structuredClone(app.ui.pending[0]!)
      expect(app.ui.requestState(request.requestId)).toBe("pending")
      if (cancelled) app.ui.cancel(request.requestId)
      else expect(app.ui.respond(request.requestId, "first")).toBeUndefined()
      expect(app.ui.requestState(request.requestId)).toBe("settled")
      app.bus.emit("ui.request", structuredClone(request))
      await app.bus.flush()
      expect(await result).toBe(cancelled ? undefined : "first")
      expect(app.manager.dialogs).toHaveLength(0)
      expect(app.changes).toEqual([])
      // Even a later cloned payload retains the settled ID's identity.
      app.bus.emit("ui.request", structuredClone(request))
      await app.bus.flush()
      expect(app.manager.dialogs).toHaveLength(0)
      expect(app.errors).toEqual([])
    } finally {
      app.dispose()
    }
  })
}

test("external resolution takes precedence over a still-registered pending request", async () => {
  const app = setup()
  try {
    const result = app.ui.api("test").select("Model", ["first", "second"])
    const request = structuredClone(app.ui.pending[0]!)
    await app.bus.flush()
    expect(app.manager.dialogs).toHaveLength(1)
    app.bus.emit("ui.resolved", { requestId: request.requestId, cancelled: false })
    await app.bus.flush()
    expect(app.ui.requestState(request.requestId)).toBe("pending")
    app.bus.emit("ui.request", structuredClone(request))
    await app.bus.flush()
    expect(app.manager.dialogs).toHaveLength(0)
    expect(app.changes).toEqual(["opened", "resolved"])
    app.ui.cancel(request.requestId)
    expect(await result).toBeUndefined()
    expect(app.errors).toEqual([])
  } finally {
    app.dispose()
  }
})

test("disposed manager ignores fresh and cloned settled announcements", async () => {
  const app = setup()
  try {
    app.bus.emit("ui.resolved", { requestId: external.requestId, cancelled: true })
    await app.bus.flush()
    app.manager.dispose()
    app.bus.emit("ui.request", structuredClone(external))
    app.bus.emit("ui.request", { ...external, requestId: "fresh-after-disposal" })
    await app.bus.flush()
    expect(app.manager.dialogs).toHaveLength(0)
    expect(app.changes).toEqual([])
    expect(app.errors).toEqual([])
  } finally {
    app.dispose()
  }
})

test("registered duplicate and live-status refresh update the same dialog", async () => {
  const app = setup()
  try {
    let status: "working" | "done" = "working"
    const result = app.ui.api("test").choose("Agents", ["child"], {
      sections: [],
      live: () => ({ optionStatuses: [status] }),
    })
    await app.bus.flush()
    expect(app.manager.dialogs).toHaveLength(1)
    const dialog = app.manager.dialogs[0]!
    app.bus.emit("ui.request", structuredClone(app.ui.pending[0]!))
    status = "done"
    app.bus.emit("subagent.state", { childSessionId: "child", state: "idle", turns: 1 })
    await app.bus.flush()
    expect(app.manager.dialogs).toEqual([dialog])
    expect(dialog.request).toMatchObject({ optionStatuses: ["done"] })
    expect(app.changes).toEqual(["opened"])
    dialog.handleInput(key("enter"))
    await app.bus.flush()
    expect(await result).toEqual({ option: "child" })
    expect(app.errors).toEqual([])
  } finally {
    app.dispose()
  }
})

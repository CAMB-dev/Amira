import { expect, test } from "bun:test"
import type { EventMap } from "@amira/api"
import { EventBus, UiRequests } from "@amira/core"
import { key } from "@amira/tui-kit"
import { plain as ctx } from "../../tui-kit/test/context.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import type { TranscriptView } from "../src/view.ts"

for (const pressed of ["enter", "escape"] as const) {
  test(`queued live update after local ${pressed} never reopens the resolved dialog`, async () => {
    const errors: unknown[] = []
    const bus = new EventBus((error) => errors.push(error))
    const ui = new UiRequests(bus)
    const changes: string[] = []
    const seen: EventMap["ui.request"][] = []
    const manager = new OverlayManager({
      ui,
      keys: defaultKeybindings(),
      theme: ctx.theme,
      mode: "fullscreen",
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
    let status: "working" | "done" = "working"
    let answerBeforeUpdate = false
    const off = bus.subscribe((event) => {
      if (event.type === "ui.request") {
        seen.push(event.data)
        if (answerBeforeUpdate) {
          answerBeforeUpdate = false
          manager.dialogs[0]!.handleInput(key(pressed))
          expect(ui.pending).toHaveLength(0)
        }
        manager.onUiRequest(event.data)
        // Catch the transient duplicate opening, not just final ui.resolved cleanup.
        expect(manager.dialogs.length).toBe(ui.pending.length)
      } else if (event.type === "ui.resolved") manager.onUiResolved(event.data)
    })
    try {
      const result = ui.api("test").choose("Agents", ["child"], {
        sections: [],
        live: () => ({ optionStatuses: [status] }),
      })
      await bus.flush()
      expect(manager.dialogs).toHaveLength(1)
      status = "done"
      answerBeforeUpdate = true
      bus.emit("subagent.state", { childSessionId: "child", state: "idle", turns: 1 }, { sessionId: "host" })
      await bus.flush()
      expect(seen).toHaveLength(2)
      expect(errors).toEqual([])
      expect(await result).toEqual(pressed === "enter" ? { option: "child" } : undefined)
      expect(manager.dialogs).toHaveLength(0)
      expect(changes.filter((change) => change === "opened")).toHaveLength(1)
      expect(changes.filter((change) => change === "resolved")).toHaveLength(1)
    } finally {
      off()
      for (const request of ui.pending) ui.cancel(request.requestId)
      manager.dispose()
    }
  })
}

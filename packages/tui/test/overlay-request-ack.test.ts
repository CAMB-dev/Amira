import { expect, test } from "bun:test"
import { EventBus, UiRequests } from "@amira/core"
import { key } from "@amira/tui-kit"
import { plain as ctx } from "../../tui-kit/test/context.ts"
import { OverlayManager, type OverlayRequestBackend } from "../src/app/overlays.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import type { TranscriptView } from "../src/view.ts"

for (const status of ["invalid", "disconnected"] as const) {
  test(`${status} dialog acknowledgement stays pending, retries, and remote disposal does not cancel`, async () => {
    const ui = new UiRequests(new EventBus())
    const answer = ui.api().select("Pick", ["first", "second"])
    const request = ui.pending[0]!
    const reply = Promise.withResolvers<{ status: typeof status; message: string }>()
    let calls = 0
    const backend: OverlayRequestBackend = {
      requestState: (id) => ui.requestState(id),
      respond: (id, value) => (++calls === 1 ? reply.promise : ui.respondAcknowledged(id, value)),
      form: () => {
        throw new Error("not a form")
      },
      settings: () => {
        throw new Error("not settings")
      },
    }
    const manager = new OverlayManager({
      ui,
      requests: backend,
      keys: defaultKeybindings(),
      theme: ctx.theme,
      env: {},
      reaches: () => true,
      view: () => ({ requestRender: () => {}, dialogEcho: () => {} }) as unknown as TranscriptView,
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
    try {
      manager.onUiRequest(request)
      manager.dialogs[0]!.handleInput(key("enter"))
      expect(manager.dialogs).toHaveLength(1)
      expect(ui.requestState(request.requestId)).toBe("pending")
      reply.resolve({ status, message: "not accepted" })
      await Bun.sleep(0)
      expect(manager.dialogs).toHaveLength(1)
      expect(ui.requestState(request.requestId)).toBe("pending")
      manager.dialogs[0]!.handleInput(key("enter"))
      expect(manager.dialogs).toHaveLength(0)
      expect(await answer).toBe("first")
      const next = ui.api().select("Next", ["one"])
      manager.onUiRequest(ui.pending[0]!)
      manager.dispose()
      expect(ui.pending).toHaveLength(1)
      ui.cancelAll()
      expect(await next).toBeUndefined()
    } finally {
      manager.dispose()
      ui.cancelAll()
    }
  })
}

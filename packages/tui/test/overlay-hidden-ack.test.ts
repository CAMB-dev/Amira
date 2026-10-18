import { expect, test } from "bun:test"
import { EventBus, UiRequests, type UiResponseAck } from "@amira/core"
import { key } from "@amira/tui-kit"
import { plain as ctx } from "../../tui-kit/test/context.ts"
import { OverlayManager, type OverlayRequestBackend } from "../src/app/overlays.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import type { TranscriptView } from "../src/view.ts"

function fixture(respond: OverlayRequestBackend["respond"]) {
  const ui = new UiRequests(new EventBus())
  let interrupts = 0
  const manager = new OverlayManager({
    ui,
    requests: {
      requestState: (id) => ui.requestState(id),
      respond,
      form: () => {
        throw new Error("not a form")
      },
      settings: () => {
        throw new Error("not settings")
      },
    },
    keys: defaultKeybindings(),
    theme: ctx.theme,
    env: {},
    reaches: () => true,
    view: () => ({ requestRender: () => {}, dialogEcho: () => {} }) as unknown as TranscriptView,
    emitWaiting: () => {},
    working: () => true,
    interrupt: () => {
      interrupts++
    },
    quitting: () => false,
    editorEmpty: () => true,
    searchActive: () => false,
    searchHint: () => undefined,
    inputFocused: () => {},
    renderInput: () => [],
  })
  return { ui, manager, interrupts: () => interrupts }
}

for (const status of ["invalid", "disconnected"] as const) {
  test(`${status} acknowledgement re-arms a hidden dialog without losing selection`, async () => {
    const reply = Promise.withResolvers<UiResponseAck>()
    let calls = 0
    const s = fixture((id, value) => (++calls === 1 ? reply.promise : s.ui.respondAcknowledged(id, value)))
    const answer = s.ui.api().select("Pick", ["first", "second"])
    const request = s.ui.pending[0]!
    try {
      s.manager.onUiRequest(request)
      const dialog = s.manager.dialogs[0]!
      dialog.handleInput(key("down"))
      dialog.handleInput(key("enter"))
      s.manager.detachConversation()
      expect(s.manager.dialogs).toEqual([])
      reply.resolve({ status, message: "Not accepted" })
      await Bun.sleep(0)
      s.manager.onUiRequest(request)
      expect(s.manager.dialogs[0]).toBe(dialog)
      expect(dialog.handleInput(key("enter"))).toBe(true)
      expect(await answer).toBe("second")
    } finally {
      s.manager.dispose(true)
      s.ui.cancelAll()
    }
  })
}

test("an already-settled approval cannot abort work when its stale dialog is dismissed", async () => {
  const s = fixture((id, value) => s.ui.respondAcknowledged(id, value))
  const answer = s.ui.api("approval").confirm("Allow?")
  const request = s.ui.pending[0]!
  try {
    s.manager.onUiRequest(request)
    expect(s.ui.respondAcknowledged(request.requestId, true)).toEqual({ status: "accepted" })
    s.manager.dialogs[0]!.handleInput(key("escape"))
    expect(s.interrupts()).toBe(0)
    expect(s.manager.dialogs).toEqual([])
    expect(await answer).toBe(true)
  } finally {
    s.manager.dispose(true)
    s.ui.cancelAll()
  }
})

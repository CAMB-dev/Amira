import { expect, test } from "bun:test"
import type { EventMap } from "@amira/api"
import type { UiResponseAck } from "@amira/core"
import { key } from "@amira/tui-kit"
import { plain as ctx } from "../../tui-kit/test/context.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import type { TranscriptView } from "../src/view.ts"

function fixture(request: EventMap["ui.request"], approvalHook = false) {
  const reply = Promise.withResolvers<UiResponseAck>()
  const echoes: string[][] = []
  const changes: string[] = []
  let calls = 0
  let interrupts = 0
  let cancellations = 0
  let renders = 0
  let state: "pending" | "settled" = "pending"
  const manager = new OverlayManager({
    requests: {
      requestState: () => state,
      respond: () => {
        calls++
        return reply.promise
      },
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
    view: () =>
      ({
        requestRender: () => renders++,
        dialogEcho: (render: (width: number) => string[]) => echoes.push(render(80)),
      }) as unknown as TranscriptView,
    emitWaiting: ({ change }) => changes.push(change),
    working: () => true,
    interrupt: () => interrupts++,
    ...(approvalHook ? { approvalCancelled: () => cancellations++ } : {}),
    quitting: () => false,
    editorEmpty: () => true,
    searchActive: () => false,
    searchHint: () => undefined,
    inputFocused: () => {},
    renderInput: () => [],
  })
  manager.onUiRequest(request)
  const dialog = manager.dialogs[0]!
  return {
    manager,
    dialog,
    reply,
    echoes,
    changes,
    effects: () => ({ interrupts, cancellations, renders }),
    calls: () => calls,
    settle(notify = true) {
      state = "settled"
      if (notify) manager.onUiResolved({ requestId: request.requestId, cancelled: false })
    },
  }
}

const approval: EventMap["ui.request"] = {
  requestId: "approval",
  kind: "confirm",
  source: "approval",
  title: "Allow?",
}
const select: EventMap["ui.request"] = {
  requestId: "select",
  kind: "select",
  title: "Pick",
  options: ["first", "second"],
}
const input: EventMap["ui.request"] = {
  requestId: "input",
  kind: "input",
  title: "Name",
  initial: "typed answer",
}

for (const approvalHook of [false, true]) {
  test(`resolution before cancellation acknowledgement stops approval once (hook: ${approvalHook})`, async () => {
    const s = fixture(approval, approvalHook)
    try {
      s.dialog.handleInput(key("escape"))
      s.settle()
      s.settle()
      s.manager.onUiRequest(structuredClone(approval))
      expect(s.manager.dialogs).toHaveLength(0)
      s.reply.resolve({ status: "cancelled" })
      await Bun.sleep(0)
      s.settle()
      expect(s.effects()).toMatchObject({
        interrupts: approvalHook ? 0 : 1,
        cancellations: approvalHook ? 1 : 0,
      })
      expect(s.calls()).toBe(1)
      expect(s.echoes).toEqual([])
      expect(s.changes).toEqual(["opened", "resolved"])
    } finally {
      s.manager.dispose(true)
    }
  })
}

for (const request of [select, input]) {
  for (const resolutionFirst of [false, true]) {
    test(`${request.kind} echoes once with resolution first: ${resolutionFirst}`, async () => {
      const s = fixture(request)
      try {
        s.dialog.handleInput(key("enter"))
        s.dialog.handleInput(key("enter"))
        s.manager.onUiRequest(structuredClone(request))
        if (resolutionFirst) {
          s.settle()
          s.settle()
        }
        s.reply.resolve({ status: "accepted" })
        await Bun.sleep(0)
        s.settle()
        s.settle()
        s.manager.onUiRequest(structuredClone(request))
        expect(s.echoes).toHaveLength(1)
        expect(s.echoes[0]!.join("\n")).toContain(request.kind === "select" ? "first" : "typed answer")
        expect(s.calls()).toBe(1)
        expect(s.manager.dialogs).toHaveLength(0)
        expect(s.changes).toEqual(["opened", "resolved"])
      } finally {
        s.manager.dispose(true)
      }
    })
  }
}

for (const fence of ["dispose", "sessionChanged"] as const) {
  for (const request of [approval, select, input]) {
    for (const resolutionFirst of [false, true]) {
      test(`${fence} fences delayed ${request.kind} acknowledgement (resolved: ${resolutionFirst})`, async () => {
        const s = fixture(request)
        try {
          s.dialog.handleInput(key(request.kind === "confirm" ? "escape" : "enter"))
          if (resolutionFirst) s.settle()
          if (fence === "dispose") s.manager.dispose(true)
          else s.manager.sessionChanged()
          const effects = s.effects()
          const changes = [...s.changes]
          s.reply.resolve({ status: request.kind === "confirm" ? "cancelled" : "accepted" })
          await Bun.sleep(0)
          expect(s.effects()).toEqual(effects)
          expect(s.changes).toEqual(changes)
          expect(s.echoes).toEqual([])
        } finally {
          s.manager.dispose(true)
        }
      })
    }
  }
}

for (const status of ["invalid", "disconnected"] as const) {
  test(`${status} acknowledgement cannot rearm a host-settled dialog before resolution delivery`, async () => {
    const s = fixture(select)
    try {
      s.dialog.handleInput(key("enter"))
      s.settle(false)
      s.reply.resolve({ status, message: "Not accepted" })
      await Bun.sleep(0)
      expect(s.manager.dialogs).toHaveLength(0)
      expect(s.dialog.handleInput(key("enter"))).toBe(false)
      expect(s.calls()).toBe(1)
      expect(s.echoes).toEqual([])
    } finally {
      s.manager.dispose(true)
    }
  })

  for (const fence of ["dispose", "sessionChanged"] as const) {
    test(`${fence} fences delayed ${status} acknowledgement without rearming`, async () => {
      const s = fixture(select)
      try {
        s.dialog.handleInput(key("enter"))
        if (fence === "dispose") s.manager.dispose(true)
        else s.manager.sessionChanged()
        const effects = s.effects()
        s.reply.resolve({ status, message: "Not accepted" })
        await Bun.sleep(0)
        expect(s.effects()).toEqual(effects)
        expect(s.dialog.handleInput(key("enter"))).toBe(false)
        expect(s.calls()).toBe(1)
      } finally {
        s.manager.dispose(true)
      }
    })
  }
}

for (const resolutionFirst of [false, true]) {
  test(`settled acknowledgement does not cancel approval (resolved: ${resolutionFirst})`, async () => {
    const s = fixture(approval, true)
    try {
      s.dialog.handleInput(key("escape"))
      if (resolutionFirst) s.settle()
      s.reply.resolve({ status: "settled" })
      await Bun.sleep(0)
      expect(s.effects()).toMatchObject({ interrupts: 0, cancellations: 0 })
      expect(s.manager.dialogs).toHaveLength(0)
    } finally {
      s.manager.dispose(true)
    }
  })

  test(`settled acknowledgement never echoes the attempted answer (resolved: ${resolutionFirst})`, async () => {
    const s = fixture(select)
    try {
      s.dialog.handleInput(key("enter"))
      if (resolutionFirst) s.settle()
      s.reply.resolve({ status: "settled" })
      await Bun.sleep(0)
      expect(s.echoes).toHaveLength(resolutionFirst ? 0 : 1)
      if (!resolutionFirst) expect(s.echoes[0]!.join("\n")).toContain("cancelled")
    } finally {
      s.manager.dispose(true)
    }
  })

  test(`detached presentation suppresses delayed echoes (resolved: ${resolutionFirst})`, async () => {
    const s = fixture(select)
    try {
      s.dialog.handleInput(key("enter"))
      if (resolutionFirst) s.settle()
      s.manager.detachConversation()
      s.reply.resolve({ status: "accepted" })
      await Bun.sleep(0)
      expect(s.echoes).toEqual([])
      expect(s.manager.dialogs).toHaveLength(0)
    } finally {
      s.manager.dispose(true)
    }
  })
}

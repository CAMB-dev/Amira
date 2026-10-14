import { expect, test } from "bun:test"
import type { CommandContext } from "@amira/api"
import { closeImageApp, INPUT_PNG, paste, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: F6 is safe when a mounted view reenters unfocus in onClose`, async () => {
    let closeCount = 0
    const reentries: (boolean | undefined)[] = []
    const s = await focusFixture(mode, [], "/work/design", {
      extensions: [
        (api) => {
          api.registerView({
            kind: "reentrant-unfocus",
            title: () => "Reentrant mounted view",
            render: () => [{ kind: "text", text: "Mounted" }],
            onClose: () => {
              closeCount++
              reentries.push(s.context().unfocusConversation?.())
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focus")
      expect((await s.viewContext()).openView?.({ kind: "reentrant-unfocus" })).toBe(true)
      await s.shows("Reentrant mounted view")
      expect(() => s.terminal.send(F6)).not.toThrow()
      await waitFor(() => !s.live().includes("main idle"), "main restored")
      expect(closeCount).toBe(1)
      expect(reentries).toEqual([false])
      s.terminal.send("Main safe\r")
      await s.idle()
      expect(userTexts(s.agent)).toEqual(["Main history", "Main safe"])
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: a mounted view may quit in onClose without resurrecting a hidden renderer`, async () => {
    const s = await focusFixture(mode, [], "/work/design", {
      extensions: [
        (api) =>
          void api.registerView({
            kind: "reentrant-quit",
            title: () => "Quit during close",
            render: () => [{ kind: "text", text: "Mounted quit view" }],
            onClose: () => s.context().quit(),
          }),
      ],
    })
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main idle"), "focus")
      expect((await s.viewContext()).openView?.({ kind: "reentrant-quit" })).toBe(true)
      await s.shows("Quit during close")
      expect(() => s.terminal.send(F6)).not.toThrow()
      expect(await s.exited).toBe(0)
      expect(s.screen.inAltScreen).toBe(false)
      const writes = s.terminal.writes.length
      s.terminal.setSize(80, 30)
      await Bun.sleep(30)
      expect(s.terminal.writes).toHaveLength(writes)
    } finally {
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: detachment rejects a replacement view opened reentrantly from onClose`, async () => {
    const opens: (boolean | undefined)[] = []
    let viewContext: CommandContext | undefined
    const s = await focusFixture(mode, [], "/work/design", {
      extensions: [
        (api) => {
          api.registerView({
            kind: "closing-view",
            title: () => "Closing owned view",
            render: () => [{ kind: "text", text: "First view" }],
            onClose: () => opens.push(viewContext?.openView?.({ kind: "replacement-view" })),
          })
          api.registerView({
            kind: "replacement-view",
            title: () => "Ghost replacement view",
            render: () => [{ kind: "text", text: "Must not open during detach" }],
          })
        },
      ],
    })
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main idle"), "focus")
      viewContext = await s.viewContext()
      expect(viewContext.openView?.({ kind: "closing-view" })).toBe(true)
      await s.shows("Closing owned view")
      s.terminal.send(F6)
      expect(opens).toEqual([false])
      await waitFor(() => !s.live().includes("main idle"), "main restored")
      expect(s.live()).not.toContain("Ghost replacement view")
      s.terminal.send("Main input after detach\r")
      await s.idle()
      expect(userTexts(s.agent)).toEqual(["Main history", "Main input after detach"])
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  for (const kind of ["text", "paste", "image"] as const) {
    test(`${mode}: cancelled guarded command never returns or discards a newer ${kind} draft`, async () => {
      const s = await focusFixture(mode)
      const text =
        kind === "paste"
          ? Array.from({ length: 12 }, (_, i) => `owned paste ${i}`).join("\n")
          : "New owned draft"
      try {
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("Design · fixture"), "focus")
        s.terminal.send("/clear\r")
        await s.shows("Return to main")
        s.terminal.send("\x03")
        if (kind === "image") {
          s.terminal.send("\x1bv")
          await s.shows("[image 1: photo.png 68 B]")
        } else s.terminal.send(paste(text))
        await waitFor(
          () =>
            s.live().includes(kind === "image" ? "[image 1:" : kind === "paste" ? "[pasted 12 lines" : text),
          "new draft",
        )
        s.terminal.send(F6)
        s.terminal.send("\r")
        await s.bus.flush()
        await Bun.sleep(30)
        expect(s.all()).not.toContain("CLEARED MAIN")
        expect(userTexts(s.agent)).toEqual(["Main history"])
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("main idle"), "refocus")
        expect(s.live()).toContain(
          kind === "image" ? "[image 1:" : kind === "paste" ? "[pasted 12 lines" : text,
        )
        s.terminal.send("\r")
        await waitFor(() => s.owned.messages.length > 2, "owned accepted draft")
        const message = s.owned.messages.findLast((m) => m.role === "user")!
        if (kind === "image")
          expect(message.content).toEqual([
            { type: "image", name: "photo.png", mimeType: "image/png", data: INPUT_PNG },
          ])
        else {
          expect(message.content).toEqual([{ type: "text", text }])
          if (kind === "paste") expect(message.display?.text).toContain("[pasted 12 lines")
        }
      } finally {
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }

  test(`${mode}: focused placeholder names the target and main restores its placeholder`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main idle"), "focus")
      expect(s.live()).toContain("Message Design · fixture")
      s.terminal.send(F6)
      await waitFor(() => !s.live().includes("main idle"), "main")
      expect(s.live()).toContain("Message Amira")
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}

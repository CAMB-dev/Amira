import { expect, test } from "bun:test"
import { PromptHistory } from "../src/prompt-history.ts"
import { closeImageApp, inputImage, paste, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  for (const origin of ["main", "owned"] as const) {
    for (const kind of ["text", "paste", "image"] as const) {
      test(`${mode}: ${origin} search preview never replaces its unsent ${kind} draft across focus`, async () => {
        const history = new PromptHistory()
        history.add(["MAIN_HISTORY_PREVIEW"])
        const s = await focusFixture(mode, [{ text: "Draft received" }], "/work/design", {
          promptHistory: history,
        })
        const text =
          kind === "paste"
            ? Array.from({ length: 12 }, (_, i) => `${origin} unsent paste ${i}`).join("\n")
            : `${origin.toUpperCase()}_UNSENT_DRAFT`
        try {
          s.terminal.send("/design\r")
          await waitFor(() => s.live().includes("main idle"), "initial focus")
          if (origin === "main") expect(s.context().unfocusConversation?.()).toBe(true)
          if (kind === "image") {
            s.terminal.send("\x1bv")
            await s.shows("[image 1: photo.png 68 B]")
          } else s.terminal.send(paste(text))
          await waitFor(
            () =>
              s
                .live()
                .includes(kind === "image" ? "[image 1:" : kind === "paste" ? "[pasted 12 lines" : text),
            "original draft",
          )
          s.terminal.send(`\x12${origin === "main" ? "MAIN_HISTORY_PREVIEW" : "Design history"}`)
          const preview = origin === "main" ? "MAIN_HISTORY_PREVIEW" : "Design history"
          await waitFor(() => s.live().includes(`│›${preview}`), "actual history preview")
          if (origin === "main") expect(s.context().focusConversation?.(s.conversation)).toBe(true)
          else expect(s.context().unfocusConversation?.()).toBe(true)
          await waitFor(
            () => s.live().includes(origin === "main" ? "Message Design · fixture" : "Message Amira"),
            "other scope empty",
          )
          if (origin === "main") expect(s.context().unfocusConversation?.()).toBe(true)
          else expect(s.context().focusConversation?.(s.conversation)).toBe(true)
          await Bun.sleep(30)
          expect(s.live()).toContain(
            kind === "image" ? "[image 1:" : kind === "paste" ? "[pasted 12 lines" : text,
          )
          expect(s.live()).not.toContain(`│›${preview}`)
          s.terminal.send("\r")
          const agent = origin === "main" ? s.agent : s.owned
          await waitFor(
            () => agent.messages.filter((m) => m.role === "user").length === 2,
            "correct draft submitted",
          )
          const message = agent.messages.findLast((m) => m.role === "user")!
          expect(message.content).toEqual(
            kind === "image" ? [{ type: "image", ...inputImage() }] : [{ type: "text", text }],
          )
          if (kind === "paste") expect(message.display?.text).toContain("[pasted 12 lines")
        } finally {
          s.context()?.unfocusConversation?.()
          await s.conversation.release()
          await closeImageApp(s)
        }
      })
    }
  }
}

import { expect, test } from "bun:test"
import { closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"
const ANSWER = "OWNED_UNSENT_ANSWER"

async function answerMainAndReturn(s: Awaited<ReturnType<typeof focusFixture>>) {
  const main = s.host.ui.ask({ kind: "confirm", title: "Main attention detour" })
  await waitFor(() => s.live().includes("f6 to answer"), "main attention chrome")
  s.terminal.send(F6)
  await s.shows("Main attention detour")
  s.terminal.send("\x1b[B\r")
  expect(await main).toBe(true)
  await s.bus.flush()
  s.terminal.send("/design\r")
}

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: suspended secret input retains its pasted buffer and caret without displaying it`, async () => {
    const s = await focusFixture(mode)
    const secret = "owned-secret-9"
    try {
      s.terminal.send("/design\r")
      await s.shows("Design · fixture")
      const answer = s.host.ui.ask(
        { kind: "input", title: "Owned secret input", secret: true },
        { sessionId: s.conversation.id },
      )
      await s.shows("Owned secret input")
      s.terminal.send(`\x1b[200~${secret}\x1b[201~\x1b[D`)
      await s.shows("*".repeat(secret.length))
      await answerMainAndReturn(s)
      await s.shows("Owned secret input")
      expect(s.live()).toContain("*".repeat(secret.length))
      expect(s.all()).not.toContain(secret)
      s.terminal.send("!\r")
      expect(await answer).toBe("owned-secret-!9")
      expect(s.all()).not.toContain("owned-secret-")
    } finally {
      s.host.ui.cancelAll()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: suspended form retains non-current pasted fields, secret buffers and filtered multiselect focus`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send("/design\r")
      await s.shows("Design · fixture")
      const answer = s.host.ui.api("test-owned").form(
        {
          title: "Owned mixed form",
          fields: [
            { type: "text", id: "name", label: "Name" },
            { type: "text", id: "note", label: "Note" },
            { type: "secret", id: "token", label: "Token" },
            {
              type: "multiselect",
              id: "choices",
              label: "Choices",
              options: [{ value: "Alpha" }, { value: "Beta" }, { value: "Gamma" }],
            },
          ],
        },
        { sessionId: s.conversation.id },
      )
      await s.shows("Owned mixed form")
      s.terminal.send(`${ANSWER}\t\x1b[200~PASTED_NOTE\x1b[201~\x1b[D\t`)
      s.terminal.send("\x1b[200~owned-secret-9\x1b[201~\x1b[D\t \x1b[BBe")
      await s.shows("Beta")
      await answerMainAndReturn(s)
      await s.shows("Owned mixed form")
      expect(s.live()).toContain(ANSWER)
      expect(s.live()).toContain("PASTED_NOTE")
      expect(s.live()).toContain("Be")
      expect(s.live()).not.toContain("Gamma")
      expect(s.all()).not.toContain("owned-secret-")
      // Space checks Beta in the retained filter, not Alpha in a rebuilt first field.
      s.terminal.send(" \x1b[Z!\x1b[Z!")
      await s.shows("PASTED_NOT!E")
      s.terminal.send("\x13")
      expect(await answer).toEqual({
        name: ANSWER,
        note: "PASTED_NOT!E",
        token: "owned-secret-!9",
        choices: ["Alpha", "Beta"],
      })
      expect(s.all()).not.toContain("owned-secret-")
    } finally {
      s.host.ui.cancelAll()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  for (const kind of ["input", "form"] as const) {
    test(`${mode}: unfinished owned ${kind} answer survives F6 main attention and return`, async () => {
      const s = await focusFixture(mode)
      try {
        s.terminal.send("/design\r")
        await s.shows("Design · fixture")
        const answer =
          kind === "input"
            ? s.host.ui.ask(
                { kind: "input", title: "Owned unfinished input" },
                { sessionId: s.conversation.id },
              )
            : s.host.ui.api("test-owned").form(
                {
                  title: "Owned unfinished form",
                  fields: [{ type: "text", id: "answer", label: "Answer" }],
                },
                { sessionId: s.conversation.id },
              )
        await s.shows(`Owned unfinished ${kind}`)
        s.terminal.send(ANSWER)
        await s.shows(ANSWER)
        // Keep the caret inside the unfinished buffer, not just its submitted value.
        s.terminal.send("\x1b[D")
        const main = s.host.ui.ask({ kind: "confirm", title: "Main needs an answer" })
        await waitFor(() => s.live().includes("f6 to answer"), "main attention chrome")
        expect(s.live()).not.toContain("Main needs an answer")
        s.terminal.send(F6)
        await s.shows("Main needs an answer")
        expect(s.live()).not.toContain(ANSWER)
        s.terminal.send("\x1b[B\r")
        expect(await main).toBe(true)
        await s.bus.flush()
        s.terminal.send("/design\r")
        await s.shows(`Owned unfinished ${kind}`)
        expect(s.live().split(ANSWER)).toHaveLength(2)
        expect(s.screen.lines[s.screen.y]).toContain(ANSWER)
        s.terminal.send("!")
        const edited = "OWNED_UNSENT_ANSWE!R"
        await s.shows(edited)
        s.terminal.send(kind === "input" ? "\r" : "\x13")
        expect(await answer).toEqual(kind === "input" ? edited : { answer: edited })
      } finally {
        s.host.ui.cancelAll()
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }
}

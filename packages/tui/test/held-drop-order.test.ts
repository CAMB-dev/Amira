import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import { ALT_ENTER, exchange, setup, waitFor } from "./app-harness.ts"

for (const mixed of [false, true]) {
  test(`cancelled compaction restores ${mixed ? "mixed held/queued" : "held"} input once in typing order ahead of a newer draft`, async () => {
    const s = await setup([{ text: "SUMMARY ".repeat(200), delayMs: 10 }, { text: "fresh reply" }], {
      history: [...exchange("a"), ...exchange("b")],
      cols: 140,
      rows: 40,
    })
    try {
      const compacted = s.agent.compact()
      await waitFor(() => s.live().includes("Compacting the conversation…"), "compaction")
      s.terminal.send("FIRST-HELD\r")
      await s.bus.flush()
      if (mixed) s.terminal.send(`MIDDLE-QUEUED${ALT_ENTER}`)
      s.terminal.send("SECOND-HELD\r")
      await s.bus.flush()
      s.terminal.send("NEWER-DRAFT\x1b")
      await compacted
      await s.idle()
      s.terminal.send("\r")
      await s.shows("fresh reply")
      await s.idle()
      expect(s.agent.messages.at(-2)).toMatchObject({
        role: "user",
        content: [
          {
            type: "text",
            text: ["FIRST-HELD", ...(mixed ? ["MIDDLE-QUEUED"] : []), "SECOND-HELD", "NEWER-DRAFT"].join(
              "\n\n",
            ),
          },
        ],
      })
    } finally {
      s.agent.abort()
      await s.idle()
      s.terminal.send("\x03\x03")
      await s.exited
      await s.agent.dispose()
    }
  })
}

for (const commandFirst of [false, true]) {
  for (const display of [false, true]) {
    test(`command-held input ${commandFirst ? "before" : "after"} local input restores typing order ${display ? "with" : "without"} display correlation`, async () => {
      let sent = false
      const s = await setup([{ text: "SUMMARY ".repeat(200), delayMs: 10 }, { text: "fresh reply" }], {
        history: [...exchange("a"), ...exchange("b")],
        cols: 140,
        rows: 40,
        commands: [
          {
            name: "hold",
            description: "Hold a message",
            run: async (_args, ctx) => {
              await ctx.session.send(
                commandFirst ? "FIRST-HELD" : "SECOND-HELD",
                display ? { display: { text: "/hold" } } : undefined,
              )
              sent = true
            },
          },
        ],
        control: {
          send: async (text, options) => {
            s.agent.steer(userMessage(text, options?.display))
          },
        },
      })
      try {
        const compacted = s.agent.compact()
        await waitFor(() => s.live().includes("Compacting the conversation…"), "compaction")
        if (!commandFirst) s.terminal.send("FIRST-HELD\r")
        s.terminal.send("/hold\r")
        await waitFor(() => sent, "command held input")
        if (commandFirst) s.terminal.send("SECOND-HELD\r")
        await s.bus.flush()
        s.terminal.send("NEWER-DRAFT\x1b")
        await compacted
        await s.idle()
        s.terminal.send("\r")
        await s.shows("fresh reply")
        await s.idle()
        expect(s.agent.messages.at(-2)).toMatchObject({
          role: "user",
          content: [{ type: "text", text: "FIRST-HELD\n\nSECOND-HELD\n\nNEWER-DRAFT" }],
        })
      } finally {
        s.agent.abort()
        await s.idle()
        s.terminal.send("\x03\x03")
        await s.exited
        await s.agent.dispose()
      }
    })
  }
}

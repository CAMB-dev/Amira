import { expect, test } from "bun:test"
import { exchange, setup, waitFor } from "./app-harness.ts"

test("cancelling compaction drops an admitted held prompt without leaving the UI working", async () => {
  const s = await setup([{ text: "SUMMARY ".repeat(200), delayMs: 10 }, { text: "fresh reply" }], {
    history: [...exchange("a"), ...exchange("b")],
  })
  try {
    const compacted = s.agent.compact()
    await waitFor(() => s.live().includes("Compacting the conversation…"), "compaction")
    s.terminal.send("held prompt\r")
    await s.bus.flush()
    await Bun.sleep(10)
    s.terminal.send("\x1b")
    await compacted
    await s.idle()
    expect(s.live()).toContain("held prompt")
    expect(s.live()).not.toContain("esc stop")
    s.terminal.send("\x15fresh\r")
    await s.shows("fresh reply")
    await s.idle()
    expect(s.agent.messages.at(-2)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "fresh" }],
    })
  } finally {
    s.agent.abort()
    await s.idle()
    s.terminal.send("\x03\x03")
    await s.exited
    await s.agent.dispose()
  }
})

test("a local embedder without commands still sends slash-prefixed literal prompts", async () => {
  const s = await setup([{ text: "literal reply" }])
  try {
    s.terminal.send("/some literal prompt\r")
    await s.shows("literal reply")
    await s.idle()
    expect(s.agent.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "/some literal prompt" }],
    })
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
    await s.agent.dispose()
  }
})

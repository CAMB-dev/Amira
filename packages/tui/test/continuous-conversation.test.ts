import { describe, expect, test } from "bun:test"
import { closeImageApp, setup, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

function clickText(
  app: { screen: { lines: string[] }; terminal: { send(data: string): void } },
  text: string,
  rowMatch?: string,
) {
  const y = app.screen.lines.findIndex(
    (line) => line.includes(text) && (!rowMatch || line.includes(rowMatch)),
  )
  expect(y).toBeGreaterThanOrEqual(0)
  const x = app.screen.lines[y]!.indexOf(text) + 2
  app.terminal.send(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`)
}

describe("continuous conversation UX", () => {
  test("clickable Enter mode pill toggles steer/queue, Up recalls queued message, and queued row buttons promote/drop", async () => {
    const firstTurn = Promise.withResolvers<void>()
    const app = await setup(
      [{ text: "First reply", hold: { chunks: 1, until: firstTurn.promise } }, { text: "Second reply" }],
      { cols: 110, rows: 32 },
    )
    try {
      app.terminal.send("Start task\r")
      await waitFor(
        () => app.live().includes("First") && app.live().includes("[ Enter: steer ]"),
        "working turn shows clickable Enter: steer pill",
      )

      // 1. Click [ Enter: steer ] -> flips live to [ Enter: queue ].
      clickText(app, "[ Enter: steer ]")
      await waitFor(() => app.live().includes("[ Enter: queue ]"), "flipped to Enter: queue")

      // 2. Sending with Enter now queues two messages instead of steering immediately.
      app.terminal.send("Follow-up one\r")
      await waitFor(() => app.live().includes("queued › Follow-up one"), "first queued")
      app.terminal.send("Follow-up two\r")
      await waitFor(() => app.live().includes("queued › Follow-up two"), "second queued")

      // 3. Empty-editor Up arrow recalls the latest queued message back into the editor for editing!
      app.terminal.send("\x1b[A")
      await waitFor(
        () => app.live().includes("│ › Follow-up two") && !app.live().includes("queued › Follow-up two"),
        "Up recalled latest queued message into editor",
      )
      // Re-submit edited message back into queue.
      app.terminal.send(" edited\r")
      await waitFor(() => app.live().includes("queued › Follow-up two edited"), "re-queued edited message")

      // 4. Click [ × ] on the second queued row to drop it cleanly.
      clickText(app, "[ × ]", "Follow-up two edited")
      await waitFor(() => !app.live().includes("Follow-up two edited"), "dropped queued row via [ × ]")
      expect(app.live()).toContain("queued › Follow-up one")

      // 5. Click [ steer ] on the first queued row to promote it into steering immediately.
      clickText(app, "[ steer ]", "Follow-up one")
      await waitFor(
        () => app.live().includes("steering › Follow-up one") && app.live().includes("next step"),
        "promoted queued message to steering",
      )

      // Release first turn so promoted steer finishes cleanly.
      firstTurn.resolve()
      await app.idle()
      expect(userTexts(app.agent)).toEqual(["Start task", "Follow-up one"])
    } finally {
      firstTurn.resolve()
      await closeImageApp(app)
    }
  })

  test("focused OwnedConversation queues messages while busy and switches via clickable tabs and bidirectional F6", async () => {
    const held = Promise.withResolvers<void>()
    const s = await focusFixture("fullscreen", [
      { text: "Working design reply", hold: { chunks: 1, until: held.promise } },
      { text: "Queued design reply" },
    ])
    try {
      // Enter Design conversation and start a long turn.
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focused design")
      s.terminal.send("First design ask\r")
      await waitFor(
        () => s.owned.status !== "idle" && s.live().includes("First design ask"),
        "owned turn running",
      )

      // Sending while busy queues cleanly instead of rejecting!
      s.terminal.send("Second design ask\r")
      await waitFor(() => s.live().includes("queued › Second design ask"), "queued inside owned conversation")

      // Empty-editor Up recalls queued message inside OwnedConversation too.
      s.terminal.send("\x1b[A")
      await waitFor(
        () => s.live().includes("│ › Second design ask") && !s.live().includes("queued › Second design ask"),
        "recalled queued owned message",
      )
      s.terminal.send("!\r")
      await waitFor(() => s.live().includes("queued › Second design ask!"), "re-queued edited owned message")

      // Click "main idle" on the conversation bar to return to main!
      clickText(s, "main idle")
      await waitFor(
        () => !s.live().includes("main idle") && s.live().includes("[ main ]"),
        "clicked back to main and shows active conversation tab bar",
      )
      expect(s.live()).toContain("Design · fixture")

      // Press F6 on main -> jumps straight back into Design · fixture!
      s.terminal.send(F6)
      await waitFor(() => s.live().includes("main idle"), "bidirectional F6 back to Design")

      // Click main idle again, then click the [ ... Design · fixture ] tab to return via mouse!
      clickText(s, "main idle")
      await waitFor(() => s.live().includes("[ main ]"), "back to main")
      clickText(s, "Design · fixture")
      await waitFor(() => s.live().includes("main idle"), "clicked Design tab back into conversation")

      // Release first turn -> queued message automatically drains and completes!
      held.resolve()
      await waitFor(() => userTexts(s.owned).includes("Second design ask!"), "queued owned turn auto-drained")
      await waitFor(() => s.live().includes("Queued design reply"), "queued owned reply rendered")
    } finally {
      held.resolve()
      s.owned.abort()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
})

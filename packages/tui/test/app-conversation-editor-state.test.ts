import { expect, test } from "bun:test"
import { closeImageApp, inputImage, paste, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"
const UNDO = "\x1a"
const REDO = "\x1b[122;6u"
const YANK = "\x19"
const KILL = "\x15"
const folded = Array.from({ length: 10 }, (_, i) => `Private main row ${i}`).join("\n")
type Fixture = Awaited<ReturnType<typeof focusFixture>>

async function focus(s: Fixture) {
  s.terminal.send("/design\r")
  await waitFor(() => s.live().includes("main idle"), "owned focus")
}

async function main(s: Fixture) {
  s.terminal.send(F6)
  await waitFor(() => !s.live().includes("main idle"), "main focus")
}

async function sendMain(s: Fixture, input: string, expected: string) {
  s.terminal.send(`${input}\r`)
  await waitFor(() => userTexts(s.agent).length === 2, "main submit")
  await s.idle()
  expect(userTexts(s.agent)).toEqual(["Main history", expected])
  expect(s.agent.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
    [{ type: "text", text: "Main history" }],
    [{ type: "text", text: expected }],
  ])
}

async function sendOwned(s: Fixture, input: string, expected: string) {
  s.terminal.send(`${input}\r`)
  await waitFor(() => userTexts(s.owned).length === 2, "owned submit")
  await waitFor(() => s.owned.status === "idle", "owned idle")
  await s.ownedBus.flush()
  expect(userTexts(s.owned)).toEqual(["Design history", expected])
  expect(s.owned.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
    [{ type: "text", text: "Design history" }],
    [{ type: "text", text: expected }],
  ])
}

async function close(s: Fixture) {
  s.context()?.unfocusConversation?.()
  await s.conversation.release()
  await closeImageApp(s)
}

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: owned undo snapshots cannot enter main and owned drafts remain scoped`, async () => {
    const s = await focusFixture(mode)
    try {
      await focus(s)
      s.terminal.send(paste("Private owned draft"))
      await waitFor(() => s.live().includes("│ › Private owned draft"), "owned draft")
      await main(s)
      await sendMain(s, `${UNDO}Main safe`, "Main safe")
      expect(userTexts(s.owned)).toEqual(["Design history"])
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes("│ › Private owned draft"), "owned restored draft")
      await sendOwned(s, `${UNDO}${REDO}`, "Private owned draft")
      expect(userTexts(s.agent)).toEqual(["Main history", "Main safe"])
    } finally {
      await close(s)
    }
  })

  test(`${mode}: main folded paste undo snapshots cannot enter owned`, async () => {
    const s = await focusFixture(mode)
    try {
      await focus(s)
      await main(s)
      s.terminal.send(paste(folded))
      await waitFor(() => s.live().includes("[pasted 10 lines #1]"), "main folded paste")
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes("main idle"), "owned focus")
      await sendOwned(s, `${UNDO}Owned safe`, "Owned safe")
      expect(userTexts(s.agent)).toEqual(["Main history"])
      await main(s)
      await sendMain(s, `${UNDO}${REDO}`, folded)
      expect(userTexts(s.owned)).toEqual(["Design history", "Owned safe"])
    } finally {
      await close(s)
    }
  })

  for (const source of ["main", "owned"] as const) {
    test(`${mode}: pending ${source} paste redo cannot enter the other conversation or survive a boundary`, async () => {
      const s = await focusFixture(mode)
      try {
        await focus(s)
        if (source === "main") await main(s)
        s.terminal.send(paste(folded))
        await waitFor(() => s.live().includes("[pasted 10 lines #1]"), "folded paste")
        s.terminal.send(UNDO)
        await waitFor(() => !s.live().includes("[pasted 10 lines #1]"), "empty source draft")
        if (source === "main") {
          expect(s.context().focusConversation?.(s.conversation)).toBe(true)
          await waitFor(() => s.live().includes("main idle"), "owned focus")
          await sendOwned(s, `${REDO}Owned safe`, "Owned safe")
          await main(s)
          await sendMain(s, `${REDO}Main safe`, "Main safe")
        } else {
          await main(s)
          await sendMain(s, `${REDO}Main safe`, "Main safe")
          expect(s.context().focusConversation?.(s.conversation)).toBe(true)
          await waitFor(() => s.live().includes("main idle"), "owned focus")
          await sendOwned(s, `${REDO}Owned safe`, "Owned safe")
        }
        expect(userTexts(s.agent)).toEqual(["Main history", "Main safe"])
        expect(userTexts(s.owned)).toEqual(["Design history", "Owned safe"])
      } finally {
        await close(s)
      }
    })
  }

  test(`${mode}: undo cannot restore an owned image into main`, async () => {
    const s = await focusFixture(mode)
    try {
      await focus(s)
      s.terminal.send("\x16")
      await waitFor(() => s.live().includes("[image 1: photo.png"), "owned image")
      await main(s)
      await sendMain(s, `${UNDO}Main safe`, "Main safe")
      expect(userTexts(s.owned)).toEqual(["Design history"])
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes("[image 1: photo.png"), "owned image restored")
      s.terminal.send(`${UNDO}${REDO}\r`)
      await waitFor(
        () => s.owned.messages.filter((m) => m.role === "user").length === 2,
        "owned image submit",
      )
      await waitFor(() => s.owned.status === "idle", "owned idle")
      expect(s.owned.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
        [{ type: "text", text: "Design history" }],
        [{ type: "image", ...inputImage() }],
      ])
      expect(userTexts(s.agent)).toEqual(["Main history", "Main safe"])
    } finally {
      await close(s)
    }
  })

  for (const source of ["main", "owned"] as const) {
    test(`${mode}: ${source} kill-ring text cannot be yanked into the other conversation`, async () => {
      const s = await focusFixture(mode)
      try {
        await focus(s)
        if (source === "main") await main(s)
        s.terminal.send(`${paste(`Private ${source} kill`)}${KILL}marker`)
        await waitFor(() => s.live().includes("│ › marker"), "kill processed")
        s.terminal.send(UNDO)
        await waitFor(() => !s.live().includes("│ › marker"), "empty source draft")
        if (source === "main") {
          expect(s.context().focusConversation?.(s.conversation)).toBe(true)
          await waitFor(() => s.live().includes("main idle"), "owned focus")
          await sendOwned(s, `${YANK}Owned safe`, "Owned safe")
          await main(s)
          await sendMain(s, `${YANK}Main safe`, "Main safe")
        } else {
          await main(s)
          await sendMain(s, `${YANK}Main safe`, "Main safe")
          expect(s.context().focusConversation?.(s.conversation)).toBe(true)
          await waitFor(() => s.live().includes("main idle"), "owned focus")
          await sendOwned(s, `${YANK}Owned safe`, "Owned safe")
        }
        expect(userTexts(s.agent)).toEqual(["Main history", "Main safe"])
        expect(userTexts(s.owned)).toEqual(["Design history", "Owned safe"])
      } finally {
        await close(s)
      }
    })
  }
}

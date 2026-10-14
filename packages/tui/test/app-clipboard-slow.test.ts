import { expect, test } from "bun:test"
import type { ClipboardContent } from "../src/image-input.ts"
import { setup, waitFor } from "./app-harness.ts"

test("injected slow clipboard shows Reading clipboard… after about one second, then inserts result", async () => {
  let resolve!: (value: ClipboardContent) => void
  const s = await setup([], {
    clipboard: async () =>
      new Promise((r) => {
        resolve = r
      }),
  })
  try {
    s.terminal.send("\x16")
    await Bun.sleep(100)
    expect(s.live()).not.toContain("Reading clipboard…")
    await s.shows("Reading clipboard…")
    resolve({ type: "text", text: "clipboard-result" })
    await s.shows("clipboard-result")
    await waitFor(() => !s.live().includes("Reading clipboard…"), "clipboard note cleared", 500)
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("cancelling after the clipboard note appears clears it without inserting the result", async () => {
  let resolve!: (value: ClipboardContent) => void
  const s = await setup([], {
    clipboard: async () =>
      new Promise((r) => {
        resolve = r
      }),
  })
  try {
    s.terminal.send("\x16")
    await s.shows("Reading clipboard…")
    s.terminal.send("\x03")
    await waitFor(() => !s.live().includes("Reading clipboard…"), "cancelled clipboard note cleared", 500)
    resolve({ type: "text", text: "clipboard-cancelled-after-note" })
    await Bun.sleep(50)
    expect(s.live()).not.toContain("clipboard-cancelled-after-note")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("fast clipboard finishes without a delayed reading note", async () => {
  const s = await setup([], { clipboard: async () => ({ type: "text", text: "clipboard-fast" }) })
  try {
    s.terminal.send("\x16")
    await s.shows("clipboard-fast")
    await Bun.sleep(1100)
    expect(s.all()).not.toContain("Reading clipboard…")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("cancelling an injected slow clipboard prevents a late reading note/result", async () => {
  let resolve!: (value: ClipboardContent) => void
  const s = await setup([], {
    clipboard: async () =>
      new Promise((r) => {
        resolve = r
      }),
  })
  try {
    s.terminal.send("\x16")
    await Bun.sleep(50)
    s.terminal.send("\x03")
    await Bun.sleep(1100)
    resolve({ type: "text", text: "clipboard-cancelled" })
    await Bun.sleep(50)
    expect(s.all()).not.toContain("Reading clipboard…")
    expect(s.live()).not.toContain("clipboard-cancelled")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

import { expect, test } from "bun:test"
import { discardPendingPaste } from "../../tui-kit/src/input-paste-control.ts"
import { closeImageApp, setup } from "./app-harness.ts"

const BEGIN = "\x1b[200~"
const END = "\x1b[201~"

for (const split of [false, true]) {
  for (const assertion of ["abort", "late set", "acquisition"] as const) {
    test(`${split ? "split" : "incomplete"} bracketed paste fences suggestion ${assertion}`, async () => {
      const s = await setup([])
      const ui = s.host.ui.api("predict")
      try {
        const slot = ui.acquireInputSuggestionSlot()!
        expect(slot).toBeDefined()
        if (split) {
          s.terminal.send(BEGIN.slice(0, 4))
          expect(slot.signal.aborted).toBe(true)
          expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
          s.terminal.send(`${BEGIN.slice(4)}pending paste`)
        } else s.terminal.send(`${BEGIN}pending paste`)
        if (assertion === "abort") expect(slot.signal.aborted).toBe(true)
        if (assertion === "late set") {
          expect(slot.set("STALE PREDICTION")).toBe(false)
          expect(s.host.ui.inputSuggestions.text).toBeUndefined()
        }
        if (assertion === "acquisition") expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
        expect(s.mock.requests).toHaveLength(0)
      } finally {
        s.terminal.send(`${END}\x15`)
        await closeImageApp(s)
      }
    })
  }
}

for (const text of ["", "payload"]) {
  test(`paste timeout restores readiness without reviving the old slot (${text || "empty"})`, async () => {
    const s = await setup([])
    const ui = s.host.ui.api("predict")
    try {
      const old = ui.acquireInputSuggestionSlot()!
      s.terminal.send(`${BEGIN}${text}`)
      expect(old.signal.aborted).toBe(true)
      expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
      await Bun.sleep(1600)
      if (text) {
        expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
        s.terminal.send("\x15")
      }
      expect(ui.acquireInputSuggestionSlot()).toBeDefined()
      expect(old.set("STALE PREDICTION")).toBe(false)
      expect(s.mock.requests).toHaveLength(0)
    } finally {
      s.terminal.send(`${END}\x15`)
      await closeImageApp(s)
    }
  })
}

test("paste discard restores readiness while the discarded tail stays quarantined", async () => {
  const s = await setup([])
  const ui = s.host.ui.api("predict")
  try {
    const old = ui.acquireInputSuggestionSlot()!
    s.terminal.send(`${BEGIN}private paste`)
    expect(old.signal.aborted).toBe(true)
    expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
    discardPendingPaste(s.terminal)
    const fresh = ui.acquireInputSuggestionSlot()!
    expect(fresh).toBeDefined()
    s.terminal.send(`private tail${END}`)
    expect(fresh.signal.aborted).toBe(false)
    expect(fresh.set("Fresh prediction")).toBe(true)
    expect(old.set("STALE PREDICTION")).toBe(false)
    expect(s.host.ui.inputSuggestions.text).toBe("Fresh prediction")
    expect(s.mock.requests).toHaveLength(0)
  } finally {
    s.terminal.send(`${END}\x15`)
    await closeImageApp(s)
  }
})

for (const split of [false, true]) {
  test(`${split ? "split" : "complete"} empty bracketed paste invalidates the old slot`, async () => {
    const s = await setup([])
    const ui = s.host.ui.api("predict")
    try {
      const slot = ui.acquireInputSuggestionSlot()!
      if (split) {
        s.terminal.send(BEGIN)
        expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
        s.terminal.send(END.slice(0, 4))
        expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
        s.terminal.send(END.slice(4))
      } else s.terminal.send(`${BEGIN}${END}`)
      expect(slot.signal.aborted).toBe(true)
      expect(slot.set("STALE PREDICTION")).toBe(false)
      expect(ui.acquireInputSuggestionSlot()).toBeDefined()
      expect(s.host.ui.inputSuggestions.text).toBeUndefined()
      expect(s.mock.requests).toHaveLength(0)
    } finally {
      s.terminal.send(END)
      await closeImageApp(s)
    }
  })
}

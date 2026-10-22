import { expect, test } from "bun:test"
import type { MockStep } from "@amira/ai"
import type { Extension, InputSuggestionSlot } from "@amira/api"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

for (const order of ["before", "after"] as const) {
  for (const reason of ["done", "error", "aborted"] as const) {
    test(`extension loaded ${order} TUI acquires a usable slot during ${reason} turn.end`, async () => {
      let slot: InputSuggestionSlot | undefined
      let set: boolean | undefined
      let ended: string | undefined
      const extension: Extension = (api) => {
        api.on("turn.end", (event) => {
          slot = api.ui.acquireInputSuggestionSlot()
          set = slot?.set("Try the next step")
          ended = event.data.reason
        })
      }
      const hold = Promise.withResolvers<void>()
      const step: MockStep =
        reason === "error"
          ? { error: { message: "Mock failure" } }
          : { text: "Done", hold: { chunks: 0, until: hold.promise } }
      const s = await setup([step], { extensions: order === "before" ? [extension] : [] })
      try {
        if (order === "after") await s.host.load(extension, "late-suggestion")
        s.terminal.send("hello\r")
        if (reason !== "error") {
          await waitFor(() => s.mock.requests.length === 1, "running turn")
          expect(s.agent.busy).toBe(true)
          expect(s.host.ui.api("busy-test").acquireInputSuggestionSlot()).toBeUndefined()
        }
        if (reason === "aborted") s.agent.abort()
        hold.resolve()
        await waitFor(() => ended !== undefined, "extension turn.end")
        await s.idle()
        expect(ended).toBe(reason)
        expect(slot).toBeDefined()
        expect(set).toBe(true)
        expect(slot!.signal.aborted).toBe(false)
        await waitFor(() => s.live().includes("Try the next step"), "turn.end ghost text")
        expect(slot!.set("Still ready")).toBe(true)
        await waitFor(() => s.live().includes("Still ready"), "later ghost text")
        expect(s.mock.requests).toHaveLength(1)
      } finally {
        hold.resolve()
        await closeImageApp(s)
      }
    })
  }

  test(`queued follow-up blocks turn.end slots with extension loaded ${order} TUI`, async () => {
    const slots: (InputSuggestionSlot | undefined)[] = []
    const extension: Extension = (api) => {
      api.on("turn.end", () => {
        const slot = api.ui.acquireInputSuggestionSlot()
        slot?.set("No follow-up waiting")
        slots.push(slot)
      })
    }
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const s = await setup(
      [
        { text: "First reply", hold: { chunks: 0, until: first.promise } },
        { text: "Second reply", hold: { chunks: 0, until: second.promise } },
      ],
      { extensions: order === "before" ? [extension] : [] },
    )
    try {
      if (order === "after") await s.host.load(extension, "late-suggestion")
      s.terminal.send("first\r")
      await waitFor(() => s.mock.requests.length === 1, "first turn")
      s.terminal.send("follow-up\x11")
      first.resolve()
      await waitFor(() => s.mock.requests.length === 2 && slots.length === 1, "automatic follow-up")
      expect(slots[0]).toBeUndefined()
      expect(s.host.ui.api("busy-test").acquireInputSuggestionSlot()).toBeUndefined()
      expect(s.host.ui.inputSuggestions.text).toBeUndefined()
      expect(s.live()).not.toContain("No follow-up waiting")
      second.resolve()
      await waitFor(() => slots.length === 2, "follow-up turn.end")
      await s.idle()
      expect(slots[1]).toBeDefined()
      expect(slots[1]!.signal.aborted).toBe(false)
      await waitFor(() => s.live().includes("No follow-up waiting"), "follow-up ghost text")
      expect(s.mock.requests).toHaveLength(2)
    } finally {
      first.resolve()
      second.resolve()
      await closeImageApp(s)
    }
  })
}

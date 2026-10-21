import { expect, test } from "bun:test"
import type { UiApi } from "@amira/api"
import { PromptHistory } from "../src/prompt-history.ts"
import { closeImageApp, paste, setup, testCommands, waitFor } from "./app-harness.ts"

async function fixture(entries: string[] = []) {
  let ui!: UiApi
  const accepted: string[] = []
  const history = new PromptHistory()
  for (const entry of entries) history.add([entry])
  const s = await setup([], {
    promptHistory: history,
    commands: testCommands([]),
    extensions: [
      (api) => {
        ui = api.ui
        ui.onInputSuggestionAccepted((text) => accepted.push(text))
      },
    ],
  })
  s.terminal.send("\x12")
  await waitFor(() => s.live().includes("search history"), "active history search")
  return {
    s,
    accepted,
    async setHidden() {
      ui.setInputSuggestion("Unseen history suggestion")
      await s.bus.flush()
      await Bun.sleep(30)
      expect(s.live()).not.toContain("Unseen history suggestion")
    },
  }
}

test("Tab leaving empty history search never accepts a suggestion hidden when the key was pressed", async () => {
  const { s, accepted, setHidden } = await fixture()
  try {
    await setHidden()
    s.terminal.send("\t")
    await waitFor(() => !s.live().includes("search history"), "search closed by Tab")
    expect(accepted).toEqual([])
    expect(s.host.ui.inputSuggestions.text).toBeUndefined()
    expect(s.live()).not.toContain("Unseen history suggestion")
    expect(s.mock.requests).toHaveLength(0)
  } finally {
    await closeImageApp(s)
  }
})

for (const [name, input] of [
  ["typing", "remember"],
  ["paste", paste("remember")],
  ["history preview", "\x12"],
]) {
  test(`${name} within history search invalidates a late hidden suggestion`, async () => {
    const { s, accepted, setHidden } = await fixture(["remember previous prompt"])
    try {
      await setHidden()
      s.terminal.send(input!)
      await waitFor(() => s.live().includes("remember previous prompt"), "history preview")
      expect(s.host.ui.inputSuggestions.text).toBeUndefined()
      expect(accepted).toEqual([])
    } finally {
      await closeImageApp(s)
    }
  })
}

for (const cancel of ["\x03", "\x1b"]) {
  test(`history cancellation ${JSON.stringify(cancel)} discards a late suggestion before restoring the empty draft`, async () => {
    const { s, accepted, setHidden } = await fixture()
    try {
      await setHidden()
      s.terminal.send(cancel)
      await waitFor(() => !s.live().includes("search history"), "cancelled history search")
      expect(s.host.ui.inputSuggestions.text).toBeUndefined()
      expect(s.live()).not.toContain("Unseen history suggestion")
      s.terminal.send("\t")
      await Bun.sleep(30)
      expect(accepted).toEqual([])
      expect(s.mock.requests).toHaveLength(0)
    } finally {
      await closeImageApp(s)
    }
  })
}

test("Tab forwarded from history search still completes a recalled command instead of ghost text", async () => {
  const { s, accepted, setHidden } = await fixture(["/he"])
  try {
    s.terminal.send("\x12")
    await waitFor(() => s.live().includes("› /he"), "recalled command")
    await setHidden()
    s.terminal.send("\t")
    await waitFor(
      () => !s.live().includes("search history") && s.live().includes("› /help"),
      "command completed",
    )
    expect(s.host.ui.inputSuggestions.text).toBeUndefined()
    expect(accepted).toEqual([])
    expect(s.mock.requests).toHaveLength(0)
  } finally {
    await closeImageApp(s)
  }
})

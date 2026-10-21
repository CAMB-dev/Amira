import { expect, test } from "bun:test"
import type { UiControl } from "@amira/api"
import { Agent, createLocalAgentPort } from "@amira/core"
import { PromptHistory } from "../src/prompt-history.ts"
import { closeImageApp, paste, setup, testCommands, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

for (const [name, input] of [
  ["type-delete in one input chunk", "x\x7f"],
  ["paste", paste("pasted")],
  ["history", "\x1b[A"],
  ["history search", "\x12"],
  ["undo", "\x1a"],
  ["submit", "\r"],
  ["queue", "\x11"],
] as const) {
  test(`local suggestion slots abort synchronously on ${name}`, async () => {
    const history = new PromptHistory()
    history.add(["old prompt"])
    const s = await setup([], { promptHistory: history })
    const ui = s.host.ui.api("slot-test")
    try {
      const slot = ui.acquireInputSuggestionSlot()!
      expect(slot).toBeDefined()
      s.terminal.send(input)
      expect(slot.signal.aborted).toBe(true)
      expect(slot.set("Late stale result")).toBe(false)
      expect(s.mock.requests).toHaveLength(0)
      if (name === "type-delete in one input chunk") {
        expect(ui.acquireInputSuggestionSlot()).toBeDefined()
      }
      if (name === "paste" || name === "history" || name === "history search") {
        expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
      }
    } finally {
      s.terminal.send("\x1b\x15")
      await Bun.sleep(30)
      await closeImageApp(s)
    }
  })
}

test("completion and history own readiness until their drafts and lists are reset", async () => {
  const s = await setup([], { commands: testCommands([]), files: ["code.ts"] })
  const ui = s.host.ui.api("slot-test")
  try {
    for (const text of ["/he", "@co"]) {
      const slot = ui.acquireInputSuggestionSlot()!
      s.terminal.send(text)
      expect(slot.signal.aborted).toBe(true)
      expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
      s.terminal.send("\t")
      expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
      s.terminal.send("\x15")
      expect(ui.acquireInputSuggestionSlot()).toBeDefined()
    }
  } finally {
    await closeImageApp(s)
  }
})

test("pending clipboard reads deny slots before the result and abort earlier work", async () => {
  const clipboard = Promise.withResolvers<{ type: "text"; text: string }>()
  const s = await setup([], { clipboard: () => clipboard.promise })
  const ui = s.host.ui.api("slot-test")
  try {
    const slot = ui.acquireInputSuggestionSlot()!
    s.terminal.send("\x16")
    expect(slot.signal.aborted).toBe(true)
    expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
    clipboard.resolve({ type: "text", text: "" })
    await waitFor(() => ui.acquireInputSuggestionSlot() !== undefined, "clipboard settled")
  } finally {
    clipboard.resolve({ type: "text", text: "" })
    await closeImageApp(s)
  }
})

for (const kind of ["dialog", "secret", "form", "approval"] as const) {
  test(`${kind} aborts slots and blocks acquisition without clearing a hidden legacy suggestion`, async () => {
    const s = await setup([])
    const ui = s.host.ui.api("slot-test")
    try {
      const slot = ui.acquireInputSuggestionSlot()!
      ui.setInputSuggestion("Legacy hidden suggestion")
      const answer =
        kind === "form"
          ? ui.form({ title: "Slot form", fields: [{ id: "name", type: "text", label: "Name" }] })
          : kind === "approval"
            ? s.host.ui.api("approval").confirm("Slot approval")
            : ui.input("Slot dialog", { secret: kind === "secret" })
      expect(slot.signal.aborted).toBe(true)
      expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
      await s.bus.flush()
      expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
      expect(s.host.ui.inputSuggestions.text).toBe("Legacy hidden suggestion")
      s.terminal.send("\x1b")
      await answer
      await s.bus.flush()
      await waitFor(() => ui.acquireInputSuggestionSlot() !== undefined, "request closed")
    } finally {
      s.host.ui.cancelAll()
      await closeImageApp(s)
    }
  })
}

test("transcript keyboard capture blocks slots until find releases the editor", async () => {
  const s = await setup([])
  const ui = s.host.ui.api("slot-test")
  try {
    const slot = ui.acquireInputSuggestionSlot()!
    s.terminal.send("\x06")
    expect(slot.signal.aborted).toBe(true)
    expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
    s.terminal.send("\x1b")
    await waitFor(() => ui.acquireInputSuggestionSlot() !== undefined, "find closed")
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(50)
    await closeImageApp(s)
  }
})

test("terminal focus loss, regain and detach fence slots without requiring a frame", async () => {
  const s = await setup([])
  const ui = s.host.ui.api("slot-test")
  let closed = false
  try {
    const slot = ui.acquireInputSuggestionSlot()!
    s.terminal.send("\x1b[O")
    expect(slot.signal.aborted).toBe(true)
    expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
    s.terminal.send("\x1b[I")
    const fresh = ui.acquireInputSuggestionSlot()!
    expect(fresh).toBeDefined()
    await closeImageApp(s)
    closed = true
    expect(fresh.signal.aborted).toBe(true)
    expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
  } finally {
    if (!closed) await closeImageApp(s)
  }
})

test("agent busy state and committed session switches abort slots and recover readiness", async () => {
  const hold = Promise.withResolvers<void>()
  const s = await setup([{ text: "done", hold: { chunks: 0, until: hold.promise } }], {
    commands: testCommands([]),
  })
  const ui = s.host.ui.api("slot-test")
  try {
    const slot = ui.acquireInputSuggestionSlot()!
    const turn = s.agent.prompt("external prompt")
    await waitFor(() => s.agent.busy, "agent busy")
    expect(slot.signal.aborted).toBe(true)
    expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
    hold.resolve()
    await turn
    await s.idle()
    const fresh = ui.acquireInputSuggestionSlot()!
    expect(fresh).toBeDefined()
    const next = new Agent({ ai: s.ai, model: s.agent.model, cwd: s.agent.cwd, bus: s.bus })
    s.commands!.switchTo(next)
    expect(fresh.signal.aborted).toBe(true)
    expect(ui.acquireInputSuggestionSlot()).toBeDefined()
  } finally {
    hold.resolve()
    await closeImageApp(s)
  }
})

test("owned-conversation focus denies local slots until the main composer returns", async () => {
  const s = await focusFixture("fullscreen", [])
  const ui = s.host.ui.api("slot-test")
  try {
    s.terminal.send("/design\r")
    await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
    expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
    s.context().unfocusConversation?.()
    await waitFor(() => ui.acquireInputSuggestionSlot() !== undefined, "main composer ready")
    const slot = ui.acquireInputSuggestionSlot()!
    expect(slot).toBeDefined()
    s.context().focusConversation?.(s.conversation)
    expect(slot.signal.aborted).toBe(true)
    expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
  } finally {
    s.context()?.unfocusConversation?.()
    await s.conversation.release()
    await closeImageApp(s)
  }
})

for (const placement of ["dock", "fullscreen"] as const) {
  test(`${placement} extension views block slots even when their composer has focus`, async () => {
    let control!: UiControl
    const s = await focusFixture("fullscreen", [], undefined, {
      extensions: [
        (api) => {
          api.registerView({
            kind: "slot-view",
            title: () => "Slot view",
            render: () => [],
            onOpen: (_data, next) => {
              control = next
            },
          })
        },
      ],
    })
    const ui = s.host.ui.api("slot-test")
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
      s.context().unfocusConversation?.()
      await waitFor(() => ui.acquireInputSuggestionSlot() !== undefined, "main composer ready")
      const slot = ui.acquireInputSuggestionSlot()!
      expect(s.context().openView?.({ kind: "slot-view", placement })).toBe(true)
      expect(slot.signal.aborted).toBe(true)
      expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
      if (placement === "fullscreen") {
        s.terminal.send("\t")
        expect(ui.acquireInputSuggestionSlot()).toBeUndefined()
      }
      control.close()
      expect(ui.acquireInputSuggestionSlot()).toBeDefined()
    } finally {
      control?.close()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}

for (const mode of ["remote", "child"] as const) {
  test(`${mode} apps never attach suggestion slots even when given local UI requests`, async () => {
    const s = await setup([], {
      ...(mode === "remote"
        ? { remote: true, frontend: (agent) => createLocalAgentPort({ agent }) }
        : { parentSessionId: "parent-session" }),
    })
    try {
      expect(s.host.ui.api("slot-test").acquireInputSuggestionSlot()).toBeUndefined()
    } finally {
      await closeImageApp(s)
    }
  })
}

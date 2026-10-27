import { expect, test } from "bun:test"
import { type AskQuestion, defineTool, textResult } from "@amira/api"
import { EventBus, UiRequests } from "@amira/core"
import { key, Spinner, stripAnsi } from "@amira/tui-kit"
import { askUserPresenter } from "../../../extensions/builtin-tools/src/ask-user.ts"
import { plain } from "../../tui-kit/test/context.ts"
import { createTurnActivity } from "../src/app/activity.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { type BlockEnv, ToolBlock } from "../src/blocks.ts"
import { Dialog } from "../src/dialog.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"
import type { TranscriptView } from "../src/view.ts"
import { setup, waitFor } from "./app-harness.ts"

const questions: AskQuestion[] = [
  { question: "Which approach?", options: [{ label: "Patch" }, { label: "Rewrite" }] },
  { question: "Include tests?", options: [{ label: "Yes" }, { label: "No" }] },
]

for (const queued of [false, true]) {
  test(`ask activity hides only for the visible ask and returns after dismissal (queued=${queued})`, async () => {
    const s = await setup(
      [{ toolCalls: [{ name: "ask_user", args: { questions } }] }, { text: "Continuing." }],
      { presenters: true, cols: 100, rows: 35 },
    )
    const release = Promise.withResolvers<void>()
    let answered = false
    let cover: Promise<unknown> | undefined
    s.agent.tools.register(
      defineTool({
        name: "ask_user",
        description: "",
        parameters: {},
        execute: async () => {
          if (queued) cover = s.host.ui.api().confirm("A different dialog")
          await s.host.ui.api().ask(questions)
          answered = true
          await release.promise
          return textResult("Declined")
        },
      }),
      "test",
    )
    try {
      s.terminal.send("go\r")
      await waitFor(() => s.host.ui.pending.some((request) => request.kind === "ask"), "pending ask")
      if (queued) {
        await waitFor(
          () =>
            s.live().includes("Asking Which approach? (+1 more)") && s.live().includes("A different dialog"),
          "queued ask activity",
        )
        // The covering confirm is the waiting state itself, as the ask is.
        expect(s.live()).not.toContain("Waiting for you…")
        s.terminal.send("\x1b[27u")
        await cover
      }
      await waitFor(() => s.live().includes("Patch"), "visible ask")
      expect(s.live()).toContain("Which approach?")
      expect(s.live()).not.toContain("Asking Which approach?")
      expect(s.live()).not.toContain("Waiting for you…")

      s.terminal.send("\x1b[27u")
      await waitFor(
        () => answered && s.live().includes("Asking Which approach? (+1 more)"),
        "restored ask activity",
      )
      expect(s.live()).toContain("1 tool running…")
      expect(s.live()).not.toContain("Waiting for you…")
      release.resolve()
      await s.shows("Continuing.")
      await s.idle()
      expect(s.all()).toContain("Asked Which approach? (+1 more)")
      expect(s.live()).not.toContain("1 tool running…")
    } finally {
      release.resolve()
      s.host.ui.cancelAll()
      s.agent.abort()
      await s.idle()
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })
}

function overlayFixture(commandRunning = () => false) {
  const ui = new UiRequests(new EventBus())
  const view = {
    requestRender: () => {},
    openOverlay: () => {},
    closeOverlay: () => {},
    renderOverlay: () => {},
    requestOverlayRender: () => {},
  } as TranscriptView
  const manager = new OverlayManager({
    ui,
    keys: defaultKeybindings(),
    theme: plain.theme,
    env: {},
    reaches: () => true,
    view: () => view,
    emitWaiting: () => {},
    working: () => true,
    interrupt: () => {},
    quitting: () => false,
    editorEmpty: () => true,
    searchActive: () => false,
    searchHint: () => undefined,
    inputFocused: () => {},
    renderInput: () => [],
    commandActivity: () => ({ animationActive: commandRunning(), tickAnimation: () => {} }),
  })
  return { ui, manager }
}

test("covering an open ask restores both rows until the question is foreground again", async () => {
  const { ui, manager } = overlayFixture()
  const answer = ui.api().ask(questions)
  const activity = createTurnActivity()
  const block = new ToolBlock("ask", "ask_user", { questions }, "session")
  block.startedAt = 1000
  const other = new ToolBlock("read", "read", { path: "file.ts" }, "session")
  other.startedAt = 1000
  const pane = new TranscriptPane()
  pane.add(block)
  pane.add(other)
  const env = (): BlockEnv => ({
    theme: plain.theme,
    width: 100,
    now: 1000,
    spinner: "⠋",
    detail: "summary",
    presenters: { get: (name) => (name === "ask_user" ? askUserPresenter : undefined) },
    hyperlinks: false,
    nodes: new Map(),
    askDialogVisible: manager.askDialogVisible,
  })
  const rows = () => pane.render(env(), 10).map(stripAnsi).join("\n")
  const status = () =>
    activity.render(100, plain, {
      running: ["ask_user", "read"],
      waiting: manager.dialogs.length > 0,
      dialogVisible: manager.waitingDialogVisible,
      spinner: new Spinner(),
    })
  activity.beginSend()
  try {
    manager.onUiRequest(ui.pending[0]!)
    expect(manager.askDialogVisible).toBe(true)
    expect(rows()).not.toContain("Asking")
    expect(rows()).toContain("read file.ts")
    expect(status()).toEqual([])

    manager.openKeyReference()
    expect(manager.askDialogVisible).toBe(false)
    expect(rows()).toContain("Asking Which approach? (+1 more)")
    expect(status()[0]).toContain("Waiting for you…")
    manager.handleInput(key("escape"))
    expect(manager.askDialogVisible).toBe(true)
    expect(rows()).not.toContain("Asking")
    expect(status()).toEqual([])

    manager.detachConversation()
    expect(manager.askDialogVisible).toBe(false)
    expect(rows()).toContain("Asking Which approach? (+1 more)")
    expect(status()[0]).toContain("2 tools running…")
    manager.onUiRequest(ui.pending[0]!, { replay: true })
    expect(manager.askDialogVisible).toBe(true)
    expect(rows()).not.toContain("Asking")
    expect(status()).toEqual([])

    block.end = { result: textResult("Completed") }
    block.touch()
    expect(rows()).toContain("Asked Which approach? (+1 more)")
  } finally {
    manager.dispose()
    ui.cancelAll()
    await answer
  }
})

test("extension confirm and select dialogs hide the waiting row but not the ask_user row", async () => {
  const { ui, manager } = overlayFixture()
  const activity = createTurnActivity()
  const status = () =>
    activity.render(100, plain, {
      running: [],
      waiting: manager.dialogs.length > 0,
      dialogVisible: manager.waitingDialogVisible,
      spinner: new Spinner(),
    })
  const confirmed = ui.api().confirm("Start the swarm?", "3 members", { tone: "warning" })
  const selected = ui.api().select("Pick a plan", ["fast", "careful"])
  activity.beginSend()
  try {
    for (const request of ui.pending) manager.onUiRequest(request)
    expect(manager.dialogs[0]?.request.kind).toBe("confirm")
    expect(manager.waitingDialogVisible).toBe(true)
    // Only a question or an approval hides ask_user's own row.
    expect(manager.askDialogVisible).toBe(false)
    expect(status()).toEqual([])
    const requestId = manager.dialogs[0]!.request.requestId
    ui.cancel(requestId)
    manager.onUiResolved({ requestId, cancelled: true })
    expect(manager.dialogs[0]?.request.kind).toBe("select")
    expect(status()).toEqual([])
    manager.openKeyReference()
    expect(manager.waitingDialogVisible).toBe(false)
    expect(status()[0]).toContain("Waiting for you…")
  } finally {
    manager.dispose()
    ui.cancelAll()
    await Promise.all([confirmed, selected])
  }
})

test("a local picker opened during a working turn keeps the turn's activity row", async () => {
  const { ui, manager } = overlayFixture()
  const activity = createTurnActivity()
  const status = () =>
    activity.render(100, plain, {
      running: [],
      waiting: manager.turnWaiting,
      dialogVisible: manager.waitingDialogVisible,
      spinner: new Spinner(),
    })
  activity.beginSend()
  const picker = new Dialog(
    { kind: "select", requestId: "local-theme", title: "Choose a theme", options: ["amira"] },
    () => {},
  )
  const close = manager.openLocalDialog(picker)
  try {
    expect(manager.dialogs[0]).toBe(picker)
    expect(manager.turnWaiting).toBe(false)
    expect(manager.waitingDialogVisible).toBe(false)
    expect(status()).toHaveLength(1)
    expect(status()[0]).not.toContain("Waiting for you")
    // A tool's confirm queued behind the picker is what the turn waits on; the row says so.
    const confirmed = ui.api().confirm("Start the swarm?")
    manager.onUiRequest(ui.pending[0]!)
    expect(manager.dialogs[0]).toBe(picker)
    expect(status()[0]).toContain("Waiting for you…")
    close()
    expect(manager.dialogs[0]?.request.kind).toBe("confirm")
    expect(manager.waitingDialogVisible).toBe(true)
    expect(status()).toEqual([])
    ui.cancelAll()
    await confirmed
  } finally {
    close()
    manager.dispose()
  }
})

test("a slash command's select during a working turn keeps the row; its ask still replaces it", async () => {
  let commandRunning = true
  const { ui, manager } = overlayFixture(() => commandRunning)
  const activity = createTurnActivity()
  const status = () =>
    activity.render(100, plain, {
      running: [],
      waiting: manager.turnWaiting,
      dialogVisible: manager.waitingDialogVisible,
      spinner: new Spinner(),
    })
  activity.beginSend()
  // /model asks through ui.select while the reply streams.
  const chosen = ui.api().select("Choose a model", ["ui-walk/main"])
  const answer = ui.api().ask(questions)
  try {
    manager.onUiRequest(ui.pending[0]!)
    commandRunning = false
    expect(manager.dialogs[0]?.request.kind).toBe("select")
    expect(manager.turnWaiting).toBe(false)
    expect(manager.waitingDialogVisible).toBe(false)
    expect(status()).toHaveLength(1)
    expect(status()[0]).not.toContain("Waiting for you")
    // A question is always the turn's wait, even when it arrives during a command.
    commandRunning = true
    manager.onUiRequest(ui.pending[1]!)
    const requestId = manager.dialogs[0]!.request.requestId
    ui.cancel(requestId)
    manager.onUiResolved({ requestId, cancelled: true })
    expect(manager.dialogs[0]?.request.kind).toBe("ask")
    expect(manager.waitingDialogVisible).toBe(true)
    expect(status()).toEqual([])
  } finally {
    manager.dispose()
    ui.cancelAll()
    await Promise.all([chosen, answer])
  }
})

test("an ask queued behind a fullscreen form does not suppress activity", async () => {
  const { ui, manager } = overlayFixture()
  const form = ui.api().form({ title: "Covering form", fields: [] })
  const answer = ui.api().ask(questions)
  try {
    for (const request of ui.pending) manager.onUiRequest(request)
    expect(manager.hasFullscreen).toBe(true)
    expect(manager.dialogs[0]?.request.kind).toBe("ask")
    expect(manager.askDialogVisible).toBe(false)
    const requestId = ui.pending.find((request) => request.kind === "form")!.requestId
    ui.cancel(requestId)
    manager.onUiResolved({ requestId, cancelled: true })
    expect(manager.hasFullscreen).toBe(false)
    expect(manager.askDialogVisible).toBe(true)
  } finally {
    manager.dispose()
    ui.cancelAll()
    await Promise.all([form, answer])
  }
})

test("visible asks suppress only the waiting status, not compaction or retry activity", () => {
  const activity = createTurnActivity()
  const options = { running: ["ask_user"], waiting: true, dialogVisible: true, spinner: new Spinner() }
  activity.beginSend()
  expect(activity.render(100, plain, options)).toEqual([])
  expect(activity.shimmerVisible).toBe(false)
  activity.startCompaction(false)
  expect(activity.render(100, plain, options)[0]).toContain("Compacting the conversation…")
  activity.endCompaction()
  activity.setRetry({ attempt: 1, maxRetries: 3, kind: "rate", at: Date.now() + 60_000 })
  expect(activity.render(100, plain, options)[0]).toContain("Rate · retrying in 60s")
  activity.setRetry(undefined)
  expect(activity.render(100, plain, options)).toEqual([])
  expect(activity.render(100, plain, { ...options, dialogVisible: false })[0]).toContain("Waiting for you…")
  activity.turnEnded()
  expect(activity.render(100, plain, { ...options, waiting: false, dialogVisible: false })).toEqual([])
})

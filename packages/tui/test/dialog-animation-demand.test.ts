import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import type { AgentStatusState } from "@amira/api"
import { key, Spinner, textKey } from "@amira/tui-kit"
import { plain as ctx } from "../../tui-kit/test/context.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { Dialog } from "../src/dialog.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import type { TranscriptView } from "../src/view.ts"

beforeEach(() => void jest.useFakeTimers())
afterEach(() => void jest.useRealTimers())

function setup() {
  let requests = 0
  let ticks = 0
  let active = false
  const draw = () => {
    if (manager.hasFullscreen) manager.render(80, ctx)
    else manager.dialogs[0]?.render(80, ctx)
    manager.syncAnimation()
  }
  const request = () => {
    requests++
    draw()
  }
  const manager = new OverlayManager({
    keys: defaultKeybindings(),
    theme: ctx.theme,
    mode: "fullscreen",
    env: {},
    reaches: () => true,
    view: () =>
      ({
        requestRender: request,
        requestOverlayRender: request,
        renderOverlay: draw,
        openOverlay: () => {},
        closeOverlay: request,
      }) as unknown as TranscriptView,
    emitWaiting: () => {},
    working: () => false,
    interrupt: () => {},
    quitting: () => false,
    editorEmpty: () => true,
    searchActive: () => false,
    searchHint: () => undefined,
    inputFocused: () => {},
    renderInput: () => [],
    commandActivity: () => ({ animationActive: active, tickAnimation: () => ticks++ }),
  })
  const dialog = new Dialog(
    { kind: "select", requestId: "local", title: "Agents", options: ["child"], optionStatuses: ["idle"] },
    () => {},
  )
  return {
    manager,
    dialog,
    draw,
    requests: () => requests,
    ticks: () => ticks,
    command: (running: boolean) => {
      active = running
      manager.syncAnimation()
    },
  }
}

for (const state of ["queued", "idle", "paused", "done", "failed", "stopped"] as const) {
  test(`${state}: a visible dialog uses no clock; transitions to working restart it`, () => {
    const s = setup()
    const close = s.manager.openLocalDialog(s.dialog)
    const update = (status: AgentStatusState) => {
      s.dialog.update({ ...s.dialog.request, kind: "select", options: ["child"], optionStatuses: [status] })
      s.draw()
    }
    try {
      update(state)
      expect(jest.getTimerCount()).toBe(0)
      update("working")
      expect(jest.getTimerCount()).toBe(1)
      const requests = s.requests()
      jest.advanceTimersByTime(Spinner.INTERVAL_MS)
      expect(s.requests()).toBe(requests + 1)
      update(state)
      expect(jest.getTimerCount()).toBe(0)
      const stopped = s.requests()
      jest.advanceTimersByTime(1200)
      expect(s.requests()).toBe(stopped)
    } finally {
      close()
      s.manager.dispose()
    }
  })
}

test("visible commands and working dialogs share a clock; covering and zero budget stop it", () => {
  const s = setup()
  try {
    s.command(true)
    expect(jest.getTimerCount()).toBe(1)
    jest.advanceTimersByTime(Spinner.INTERVAL_MS)
    expect(s.ticks()).toBe(1)
    const close = s.manager.openLocalDialog(s.dialog)
    expect(jest.getTimerCount()).toBe(0)
    s.dialog.update({
      kind: "select",
      requestId: "local",
      title: "Agents",
      options: ["child"],
      optionStatuses: ["working"],
    })
    s.draw()
    expect(jest.getTimerCount()).toBe(1)
    jest.advanceTimersByTime(Spinner.INTERVAL_MS)
    expect(s.ticks()).toBe(1) // A waiting command's clock is not advanced by its picker.
    s.manager.syncAnimation(false)
    expect(jest.getTimerCount()).toBe(0)
    s.manager.syncAnimation(true)
    expect(jest.getTimerCount()).toBe(1)
    s.manager.openKeyReference()
    expect(jest.getTimerCount()).toBe(0)
    s.manager.handleInput(key("escape"))
    expect(jest.getTimerCount()).toBe(1)
    close()
    expect(jest.getTimerCount()).toBe(1)
    s.command(false)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    s.manager.dispose()
  }
})

test("filtered, scrolled-away and one-row working options never request animation", () => {
  const options = Array.from({ length: 12 }, (_, index) => (index === 11 ? "busy" : `idle-${index}`))
  const dialog = new Dialog(
    {
      kind: "select",
      requestId: "r",
      title: "Agents",
      options,
      optionStatuses: options.map((_, index) => (index === 11 ? "working" : "idle")),
    },
    () => {},
  )
  dialog.render(80, ctx)
  expect(dialog.refreshIntervalMs).toBeUndefined()
  for (let i = 0; i < 11; i++) dialog.handleInput(key("down"))
  dialog.render(80, ctx)
  expect(dialog.refreshIntervalMs).toBe(Spinner.INTERVAL_MS)
  for (const char of "idle") dialog.handleInput(textKey(char))
  dialog.render(80, ctx)
  expect(dialog.refreshIntervalMs).toBeUndefined()
  for (let i = 0; i < 4; i++) dialog.handleInput(key("backspace"))
  dialog.handleInput(key("up"))
  dialog.render(80, ctx)
  expect(dialog.refreshIntervalMs).toBe(Spinner.INTERVAL_MS)
  dialog.maxRows = 1
  dialog.render(80, ctx)
  expect(dialog.refreshIntervalMs).toBeUndefined()
})

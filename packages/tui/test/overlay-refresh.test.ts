import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import type { AgentStatusState, UiControl, ViewDefinition } from "@amira/api"
import { resolveShimmer } from "@amira/host"
import { defaultTheme, key, type RenderContext, Spinner, type Theme } from "@amira/tui-kit"
import { plain as ctx } from "../../tui-kit/test/context.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { configureShimmer, SHIMMER_INTERVAL_MS } from "../src/app/shimmer.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import type { TranscriptView } from "../src/view.ts"
import { ELAPSED_INTERVAL_MS } from "../src/view-animation.ts"

beforeEach(() => void jest.useFakeTimers())
afterEach(() => void jest.useRealTimers())

function setup(placement: "fullscreen" | "dock", definition: ViewDefinition, renderCtx: RenderContext = ctx) {
  let requests = 0
  let rows: string[] = []
  let available = 24
  const draw = () => {
    rows =
      placement === "dock" && !manager.hasFullscreen
        ? manager.renderDock(80, renderCtx, available)
        : manager.render(80, renderCtx)
  }
  const request = () => {
    requests++
    draw()
  }
  const view = {
    requestRender: request,
    requestOverlayRender: request,
    renderOverlay: draw,
    openOverlay: () => {},
    closeOverlay: () => {},
  } as TranscriptView
  const manager = new OverlayManager({
    keys: defaultKeybindings(),
    theme: ctx.theme,
    env: {},
    views: { get: () => definition },
    reaches: () => true,
    view: () => view,
    emitWaiting: () => {},
    working: () => false,
    interrupt: () => {},
    quitting: () => false,
    editorEmpty: () => true,
    searchActive: () => false,
    searchHint: () => undefined,
    inputFocused: () => {},
    renderInput: () => [],
  })
  const open = (data?: unknown) => manager.openView({ kind: definition.kind, placement, data })
  open()
  return {
    manager,
    open,
    requests: () => requests,
    rows: () => rows,
    resize: (room: number) => {
      available = room
      draw()
    },
  }
}

for (const placement of ["fullscreen", "dock"] as const) {
  test(`${placement}: working badges stop all idle redraw requests after completion`, () => {
    let state: AgentStatusState = "working"
    const s = setup(placement, {
      kind: "badges",
      title: () => "Agents",
      render: (_data, opts) => [{ kind: "segments", parts: opts.statusBadge!(state) }],
    })
    try {
      const workingRequests = s.requests()
      jest.advanceTimersByTime(Spinner.INTERVAL_MS)
      expect(s.requests()).toBeGreaterThan(workingRequests)
      state = "done"
      s.manager.onEvent({
        type: "turn.end",
        data: { reason: "done", steps: 1 },
        sessionId: "test",
        seq: 1,
        ts: Date.now(),
      })
      expect(s.rows().join("\n")).toContain("done")
      const doneRequests = s.requests()
      jest.advanceTimersByTime(1200)
      expect(s.requests()).toBe(doneRequests)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      s.manager.dispose()
    }
  })

  test(`${placement}: explicit timed content refreshes at the shortest requested interval and then stops`, () => {
    let timed = true
    const s = setup(placement, {
      kind: "clock",
      title: (_data, opts) => {
        if (timed) opts.requestRefresh!(1000)
        return "Clock"
      },
      render: (_data, opts) => {
        if (timed) opts.requestRefresh!(250)
        return [{ kind: "text", text: String(opts.now) }]
      },
    })
    try {
      const first = s.rows().join("\n")
      const requests = s.requests()
      jest.advanceTimersByTime(249)
      expect(s.requests()).toBe(requests)
      jest.advanceTimersByTime(1)
      expect(s.requests()).toBe(requests + 1)
      expect(s.rows().join("\n")).not.toBe(first)
      timed = false
      s.open()
      const stopped = s.requests()
      jest.advanceTimersByTime(1200)
      expect(s.requests()).toBe(stopped)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      s.manager.dispose()
    }
  })

  test(`${placement}: static data replacements and lifecycle requests redraw without polling`, () => {
    let control!: UiControl
    let suffix = ""
    const calls: string[] = []
    const s = setup(placement, {
      kind: "static",
      onOpen: (_data, view) => {
        control = view
        calls.push("open")
      },
      onClose: () => calls.push("close"),
      title: () => "Static",
      render: (data) => [{ kind: "text", text: `${data ?? "first"}${suffix}` }],
    })
    try {
      expect(s.rows().join("\n")).toContain("first")
      s.open("replacement")
      expect(s.rows().join("\n")).toContain("replacement")
      suffix = " updated"
      const requests = s.requests()
      control.requestRender()
      expect(s.requests()).toBe(requests + 1)
      expect(s.rows().join("\n")).toContain("replacement updated")
      expect(calls).toEqual(["open"])
      const idle = s.requests()
      jest.advanceTimersByTime(1200)
      expect(s.requests()).toBe(idle)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      s.manager.dispose()
    }
    expect(calls).toEqual(["open", "close"])
  })

  test(`${placement}: declarative widgets request timed redraws only while needed`, () => {
    let timed = true
    const s = setup(placement, {
      kind: "widget-clock",
      title: () => "Clock",
      ui: (_data, opts) => {
        if (timed) opts.requestRefresh!(300)
        return { type: "text", lines: [{ kind: "text", text: String(opts.now) }] }
      },
    })
    try {
      const requests = s.requests()
      jest.advanceTimersByTime(300)
      expect(s.requests()).toBe(requests + 1)
      timed = false
      s.open()
      const idle = s.requests()
      jest.advanceTimersByTime(1200)
      expect(s.requests()).toBe(idle)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      s.manager.dispose()
    }
  })

  test(`${placement}: padded badges preserve automatic spinner cadence over slower explicit refreshes`, () => {
    const s = setup(placement, {
      kind: "padded-badges",
      title: () => "Agents",
      render: (_data, opts) => {
        opts.requestRefresh!(1000)
        return [
          { kind: "segments", parts: opts.statusBadge!("working", { pad: true }) },
          { kind: "segments", parts: opts.statusBadge!("done", { pad: true }) },
        ]
      },
    })
    try {
      expect(s.rows().join("\n")).toContain("done   ")
      const requests = s.requests()
      jest.advanceTimersByTime(Spinner.INTERVAL_MS)
      expect(s.requests()).toBe(requests + 1)
    } finally {
      s.manager.dispose()
    }
    expect(jest.getTimerCount()).toBe(0)
  })

  test(`${placement}: invalid refresh intervals do not schedule timers`, () => {
    const s = setup(placement, {
      kind: "invalid-refresh",
      title: () => "Static",
      render: (_data, opts) => {
        for (const interval of [0, -1, NaN, Infinity]) opts.requestRefresh!(interval)
        return []
      },
    })
    try {
      const requests = s.requests()
      jest.advanceTimersByTime(1200)
      expect(s.requests()).toBe(requests)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      s.manager.dispose()
    }
  })
}

test("key reference stays static without redraw polling", () => {
  const s = setup("fullscreen", { kind: "static", title: () => "Static", render: () => [] })
  try {
    s.manager.openKeyReference()
    const requests = s.requests()
    jest.advanceTimersByTime(1200)
    expect(s.requests()).toBe(requests)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    s.manager.dispose()
  }
})

test("a covered dock has no timer and resumes visible demand on uncover", () => {
  let state: AgentStatusState = "working"
  const s = setup("dock", {
    kind: "covered",
    title: () => "Agents",
    render: (_data, opts) => [{ kind: "segments", parts: opts.statusBadge!(state) }],
  })
  try {
    expect(jest.getTimerCount()).toBe(1)
    s.manager.openKeyReference()
    expect(jest.getTimerCount()).toBe(0)
    const requests = s.requests()
    jest.advanceTimersByTime(1200)
    expect(s.requests()).toBe(requests)
    s.manager.handleInput(key("escape"))
    s.resize(24)
    expect(jest.getTimerCount()).toBe(1)
    state = "done"
    s.open()
    expect(jest.getTimerCount()).toBe(0)
    s.manager.openKeyReference()
    state = "working"
    s.manager.handleInput(key("escape"))
    s.resize(24)
    expect(jest.getTimerCount()).toBe(1)
  } finally {
    s.manager.dispose()
  }
})

test("a zero-height dock sleeps and recomputes demand when space returns", () => {
  let state: AgentStatusState = "working"
  const s = setup("dock", {
    kind: "small",
    title: () => "Agents",
    render: (_data, opts) => [{ kind: "segments", parts: opts.statusBadge!(state) }],
  })
  try {
    s.resize(0)
    expect(s.rows()).toEqual([])
    expect(jest.getTimerCount()).toBe(0)
    const requests = s.requests()
    jest.advanceTimersByTime(1200)
    expect(s.requests()).toBe(requests)
    state = "done"
    s.resize(24)
    expect(s.rows().join("\n")).toContain("done")
    expect(jest.getTimerCount()).toBe(0)
    s.resize(0)
    state = "working"
    s.resize(24)
    expect(jest.getTimerCount()).toBe(1)
  } finally {
    s.manager.dispose()
  }
})

test("extension settings overlay animates while previewing or saving and stops once idle", async () => {
  let resolvePreview!: (result: { lines: { kind: "text"; text: string }[] }) => void
  let requests = 0
  const draw = () => {
    manager.render(80, ctx)
  }
  const request = () => {
    requests++
    draw()
  }
  const view = {
    requestRender: request,
    requestOverlayRender: request,
    renderOverlay: draw,
    openOverlay: () => {},
    closeOverlay: () => {},
  } as TranscriptView
  const manager = new OverlayManager({
    keys: defaultKeybindings(),
    theme: ctx.theme,
    env: {},
    requests: {
      requestState: () => "pending",
      respond: () => ({ status: "accepted" }),
      form: () => {
        throw new Error("unused")
      },
      settings: (request) => ({
        request,
        preview: () =>
          new Promise((resolve) => {
            resolvePreview = resolve
          }),
        submit: async () => ({ status: "accepted" }),
        cancel: () => ({ status: "cancelled" }),
      }),
    },
    reaches: () => true,
    view: () => view,
    emitWaiting: () => {},
    working: () => false,
    interrupt: () => {},
    quitting: () => false,
    editorEmpty: () => true,
    searchActive: () => false,
    searchHint: () => undefined,
    inputFocused: () => {},
    renderInput: () => [],
  })
  try {
    manager.onUiRequest({
      kind: "extension-settings",
      requestId: "req-settings",
      name: "sample",
      title: "Sample settings",
      fields: [{ key: "flag", type: "toggle", label: "Flag", default: true }],
      values: { flag: true },
      scope: "user",
    })
    expect(jest.getTimerCount()).toBe(1)
    const before = requests
    jest.advanceTimersByTime(Spinner.INTERVAL_MS)
    expect(requests).toBeGreaterThan(before)
    await Promise.resolve()
    resolvePreview({ lines: [{ kind: "text", text: "done" }] })
    for (let i = 0; i < 4; i++) await Promise.resolve()
    draw()
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    manager.dispose()
  }
})

function dockShimmerTheme(): Theme {
  const tokens: Record<string, (s: string) => string> = {
    codeBg: (s: string) => `\x1b[48;5;236m${s}\x1b[49m`,
    surfaceMuted: (s: string) => `\x1b[38;5;245m${s}\x1b[39m`,
  }
  for (let i = 0; i < 16; i++) {
    for (let f = 1; f <= 8; f++) {
      tokens[`shimmer${i}Fade${f}`] = (s: string) => `\x1b[38;5;${16 + i * 8 + f}m${s}\x1b[39m`
    }
  }
  return { ...defaultTheme, ...tokens }
}

test("dock declarative spinner + shimmer inherits theme shimmer config and stops when idle", () => {
  let working = true
  const startedAt = Date.now()
  const definition: ViewDefinition = {
    kind: "btw-dock",
    title: () => "btw: question",
    render: () =>
      working
        ? [
            {
              kind: "segments",
              parts: [
                { kind: "spinner" },
                { kind: "text", text: " " },
                { kind: "shimmer", text: "Thinking…", startedAt },
                { kind: "dim", text: " · " },
                { kind: "elapsed", since: startedAt, tone: "dim" },
              ],
            },
          ]
        : [{ kind: "text", text: "Done" }],
  }

  // With shimmer enabled, dock ticks at 33ms.
  const onTheme = dockShimmerTheme()
  configureShimmer(onTheme, resolveShimmer("soft"))
  const active = setup("dock", definition, { ...ctx, theme: onTheme, color: true })
  try {
    const before = active.requests()
    jest.advanceTimersByTime(SHIMMER_INTERVAL_MS)
    expect(active.requests()).toBe(before + 1)
    working = false
    active.open()
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    active.manager.dispose()
  }

  // With shimmer disabled on the base theme, the derived dock surface theme inherits "off"
  // and ticks only at the 80ms spinner cadence.
  working = true
  const offTheme = dockShimmerTheme()
  configureShimmer(offTheme, resolveShimmer("off"))
  const off = setup("dock", definition, { ...ctx, theme: offTheme, color: true })
  try {
    const before = off.requests()
    jest.advanceTimersByTime(SHIMMER_INTERVAL_MS)
    expect(off.requests()).toBe(before)
    jest.advanceTimersByTime(Spinner.INTERVAL_MS - SHIMMER_INTERVAL_MS)
    expect(off.requests()).toBe(before + 1)
  } finally {
    off.manager.dispose()
  }
})

test("declarative elapsed-only views tick at 1000ms and stop when removed", () => {
  let active = true
  const since = Date.now()
  const s = setup("dock", {
    kind: "elapsed",
    title: () => "Timer",
    render: () => (active ? [{ kind: "segments", parts: [{ kind: "elapsed", since }] }] : []),
  })
  try {
    const before = s.requests()
    jest.advanceTimersByTime(ELAPSED_INTERVAL_MS - 1)
    expect(s.requests()).toBe(before)
    jest.advanceTimersByTime(1)
    expect(s.requests()).toBe(before + 1)
    active = false
    s.open()
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    s.manager.dispose()
  }
})

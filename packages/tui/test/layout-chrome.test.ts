import { expect, spyOn, test } from "bun:test"
import { textResult } from "@amira/api"
import { bold, createTheme, defaultTheme, Editor, Spinner, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { createTurnActivity } from "../src/app/activity.ts"
import { activityRow, shimmerLabel } from "../src/app/activity-row.ts"
import { reasoningLines, timestampRow, userLines } from "../src/format.ts"
import { contextStyle, headerLine } from "../src/header.ts"
import { InputBox } from "../src/input-box.ts"
import { finishedToolLines } from "../src/tool-view.ts"

const info = {
  cwd: "~/dev/Amira",
  branch: "main",
  dirty: true,
  title: "remember last model",
  cost: "$0.42",
  used: 124_000,
  limit: 200_000,
}

test("header aligns workspace/title and cost/context at opposite edges", () => {
  const row = headerLine(info, 100, plain)
  expect(row).toBe(` ⎇ main*  ~/dev/Amira  ·  remember last model${" ".repeat(35)}$0.42 │ 124k / 200k `)
  expect(visibleWidth(row)).toBe(100)
})

test("narrow headers drop title, then shorten cwd, with context the last survivor", () => {
  expect(headerLine(info, 60, plain)).not.toContain(info.title)
  expect(headerLine(info, 60, plain)).toContain(info.cwd)
  expect(headerLine(info, 40, plain)).not.toContain(info.cwd)
  expect(headerLine(info, 40, plain)).toContain("124k / 200k")
  for (let width = 1; width <= 100; width++) {
    expect(visibleWidth(headerLine(info, width, plain))).toBeLessThanOrEqual(width)
    if (width >= 12) expect(headerLine(info, width, plain)).toContain("124k / 200k")
  }
})

test("context thresholds use fg2, warning, bold warning, then error", () => {
  const ctx = { ...plain, theme: defaultTheme }
  for (const [share, style] of [
    [0, defaultTheme.fg2],
    [0.499, defaultTheme.fg2],
    [0.5, defaultTheme.warning],
    [0.749, defaultTheme.warning],
    [0.75, (s: string) => bold(defaultTheme.warning(s))],
    [0.949, (s: string) => bold(defaultTheme.warning(s))],
    [0.95, defaultTheme.error],
  ] as const) {
    expect(contextStyle(ctx, share * 1000, 1000)("used")).toBe(style("used"))
  }
})

const status = {
  label: "responding",
  spinner: "⠋",
  stepMs: 4100,
  turnMs: 80_000,
  tokens: 12_400,
  rate: 186,
  stop: "esc stop",
  animationMs: 0,
}

test("turn status is one row with capitalized ellipsis label and right-aligned stats", () => {
  const row = activityRow(status, 100, plain)
  expect(row).toContain(" ⠋ Responding… 4.1s")
  expect(row.endsWith("1m20s · ⇣12.4k · ~186 tok/s   esc stop ")).toBe(true)
  expect(visibleWidth(row)).toBe(100)
  for (const width of [1, 12, 24, 40, 80])
    expect(visibleWidth(activityRow(status, width, plain))).toBeLessThanOrEqual(width)
  expect(activityRow({ ...status, label: "2 tools running" }, 100, plain)).toContain("2 tools running…")
})

test("activity switches to Responding while text streams and disappears at turn end", () => {
  const activity = createTurnActivity()
  const options = { running: [], waiting: false, spinner: new Spinner() }
  activity.beginSend()
  activity.messageStarted()
  activity.textDelta("hello", () => {})
  expect(activity.render(100, plain, options)).toHaveLength(1)
  expect(activity.render(100, plain, options)[0]).toContain("Responding…")
  expect(activity.render(100, plain, { ...options, waiting: true })[0]).toContain("Waiting for you…")
  activity.turnEnded()
  expect(activity.render(100, plain, options)).toEqual([])
})

test("shimmer moves across the label with exact theme stops at either end", () => {
  const theme = createTheme({ theme: "dark", colorDepth: "truecolor", env: {} })
  const ctx = { ...plain, theme, color: true }
  const label = "Responding…"
  const start = (1800 * 3) / (label.length + 6)
  const end = (1800 * (label.length + 2)) / (label.length + 6)
  const first = shimmerLabel(label, ctx, start)
  const last = shimmerLabel(label, ctx, end)
  expect(first).toContain(theme.shimmer("R"))
  expect(last).toContain(theme.shimmerEnd!("…"))
  expect(first).not.toBe(last)
  expect(stripAnsi(first)).toBe(label)
  expect(stripAnsi(last)).toBe(label)
  expect(visibleWidth(first)).toBe(label.length)
  expect(theme.shimmer("R")).toBe("\x1b[38;2;188;220;246mR\x1b[39m")
  expect(theme.shimmerEnd!("…")).toBe("\x1b[38;2;198;241;244m…\x1b[39m")
  const light = createTheme({ theme: "light", colorDepth: "truecolor", env: {} })
  expect(light.shimmer("R")).toBe("\x1b[38;2;18;63;106mR\x1b[39m")
  expect(light.shimmerEnd!("…")).toBe("\x1b[38;2;11;79;85m…\x1b[39m")
})

test("depth 256 quantizes shimmer; 16, terminal and NO_COLOR do not animate", () => {
  const theme = createTheme({ theme: "dark", colorDepth: "256", env: {} })
  const ctx = { ...plain, theme, color: true }
  expect(shimmerLabel("Responding…", ctx, 400)).toContain("\x1b[38;5;")
  for (const options of [{ colorDepth: "16" }, { theme: "terminal" }, { env: { NO_COLOR: "1" } }] as const) {
    const theme = createTheme({ theme: "dark", colorDepth: "truecolor", env: {}, ...options })
    const ctx = { ...plain, theme, color: true }
    expect(shimmerLabel("Responding…", ctx, 400)).toBe(theme.muted("Responding…"))
    expect(shimmerLabel("Responding…", ctx, 1400)).toBe(theme.muted("Responding…"))
  }
})

test("input bottom label is right aligned inside the rounded border", () => {
  const box = new InputBox(new Editor({ prompt: "› " }), () => [
    { id: "model", text: "claude-opus-5-5 (high) · ask", align: "right", tone: "accent", priority: 40 },
  ])
  const rows = box.render(80, plain)
  expect(rows[0]).toBe(`╭${"─".repeat(78)}╮`)
  expect(rows[2]).toBe(`╰─${"─".repeat(46)} claude-opus-5-5 (high) · ask ─╯`)
  expect(rows.every((row) => visibleWidth(row) === 80)).toBe(true)
})

test("activity rate uses the message clock, not the newly reset activity clock", () => {
  let now = 1000
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    const activity = createTurnActivity()
    const options = { running: [], waiting: false, spinner: new Spinner() }
    activity.beginSend()
    activity.messageStarted()
    activity.thinkingDelta("x".repeat(400), () => {})
    activity.render(100, plain, options)
    now += 5000
    activity.textDelta("text", () => {})
    expect(activity.render(100, plain, options)[0]).toContain("~20 tok/s")
  } finally {
    clock.mockRestore()
  }
})

test.each([100, 50])("a composed batch2 frame at %i columns keeps the chosen layout", (width) => {
  const at = new Date(2026, 9, 10, 20, 19).getTime()
  const box = new InputBox(new Editor({ prompt: "› ", placeholder: "Message Amira" }), () => [
    { id: "model", text: "claude-opus-5-5 (high) · ask", align: "right", tone: "accent", priority: 40 },
  ])
  const frame = [
    headerLine(info, width, plain),
    "",
    ...userLines(
      { ...plain.theme, userBg: (text) => text },
      {
        role: "user",
        content: [{ type: "text", text: "The status bar feels cramped, can you make it clearer?" }],
      },
      width,
      at,
    ),
    "",
    ...reasoningLines(
      plain.theme,
      "Move context into the header.",
      { durationMs: 4200, timestamp: at },
      width,
    ),
    "",
    timestampRow("  # Status bar layout", plain.theme, width, at),
    "  The header now carries context and cost.",
    "",
    ...finishedToolLines(
      plain.theme,
      undefined,
      { name: "Edited", args: { path: "packages/tui/src/status-bar.ts" }, result: textResult("+12 / -3") },
      "summary",
      width,
    ),
    ...finishedToolLines(
      plain.theme,
      undefined,
      { name: "Ran", args: { command: "bun test packages/tui" }, result: textResult("✓ 412 pass · 3.1s") },
      "summary",
      width,
      { last: true },
    ),
    "",
    activityRow(status, width, plain),
    ...box.render(width, plain),
  ]
  expect(frame.map(stripAnsi).join("\n")).toMatchSnapshot()
})

test("current step clocks restart for repeated compactions and retry attempts", () => {
  let now = 1000
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const options = { running: [], waiting: false, spinner: new Spinner() }
  try {
    const activity = createTurnActivity()
    activity.startCompaction(false)
    activity.render(100, plain, options)
    now += 5000
    expect(activity.render(100, plain, options)[0]).toContain("Compacting the conversation… 5.0s")
    activity.endCompaction()
    activity.startCompaction(false)
    expect(activity.render(100, plain, options)[0]).toContain("Compacting the conversation… 0s")
    activity.endCompaction()
    activity.beginSend()
    const retry = () => ({ attempt: 1, maxRetries: 3, kind: "rate", at: now + 6000 })
    activity.setRetry(retry())
    activity.render(100, plain, options)
    now += 1000
    expect(activity.render(100, plain, options)[0]).toContain("Retrying in 5s (1/3) · rate… 1.0s")
    activity.setRetry({ ...retry(), attempt: 2 })
    expect(activity.render(100, plain, options)[0]).toContain("Retrying in 6s (2/3) · rate… 0s")
  } finally {
    clock.mockRestore()
  }
})

test("stream redraws do not animate faster than spinner frames", () => {
  let now = 1000
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    const ctx = {
      ...plain,
      theme: createTheme({ theme: "dark", colorDepth: "truecolor", env: {} }),
      color: true,
    }
    const activity = createTurnActivity()
    const spinner = new Spinner()
    const options = { running: [], waiting: false, spinner }
    activity.beginSend()
    activity.messageStarted()
    activity.textDelta("text", () => {})
    const label = () => {
      const row = activity.render(100, ctx, options)[0]!
      return row.slice(` ${ctx.theme.accent(spinner.glyph)} `.length).split(ctx.theme.muted("0s"))[0]
    }
    const first = label()
    now += 40
    expect(label()).toBe(first)
    now += 40
    spinner.tick()
    const next = label()
    expect(next).not.toBe(first)
    now += 40
    expect(label()).toBe(next)
  } finally {
    clock.mockRestore()
  }
})

test("narrow status drops the step clock, then rate and tokens before cutting its label", () => {
  const fifty = activityRow(status, 50, plain)
  expect(fifty).toContain(" ⠋ Responding…")
  expect(fifty).not.toContain("4.1s")
  expect(fifty).not.toContain("tok/s")
  expect(fifty).toContain("⇣12.4k")
  expect(fifty).toEndWith("1m20s · ⇣12.4k   esc stop ")
  const forty = activityRow(status, 40, plain)
  expect(forty).toContain(" ⠋ Responding…")
  expect(forty).not.toContain("4.1s")
  expect(forty).not.toContain("⇣")
  expect(forty).toEndWith("1m20s   esc stop ")
  for (const width of [40, 50]) expect(visibleWidth(activityRow(status, width, plain))).toBe(width)
})

test("status truncates the bare label before adding exactly one ellipsis", () => {
  for (let width = 1; width <= 100; width++) {
    const row = activityRow(
      { ...status, label: "retrying in 6s (2/3) · provider is rate limiting…" },
      width,
      plain,
    )
    expect(row).not.toContain("……")
    expect(visibleWidth(row)).toBeLessThanOrEqual(width)
  }
})

test("zero token and rate stats stay hidden independently until positive", () => {
  const empty = activityRow({ ...status, tokens: 0, rate: 0 }, 100, plain)
  expect(empty).not.toContain("⇣")
  expect(empty).not.toContain("tok/s")
  const tokens = activityRow({ ...status, tokens: 1200, rate: 0 }, 100, plain)
  expect(tokens).toContain("⇣1.2k")
  expect(tokens).not.toContain("tok/s")
  const rate = activityRow({ ...status, tokens: 0, rate: 2 }, 100, plain)
  expect(rate).not.toContain("⇣")
  expect(rate).toContain("~2 tok/s")
  expect(activityRow({ ...status, rate: 0.4 }, 100, plain)).not.toContain("~0 tok/s")
})

import { expect, spyOn, test } from "bun:test"
import { resolveShimmer } from "@amira/core"
import { createTheme, FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { createTurnActivity } from "../src/app/activity.ts"
import { configureShimmer } from "../src/app/shimmer.ts"
import { createShimmerClock } from "../src/app/shimmer-clock.ts"

for (const preview of [false, true]) {
  test(`elapsed shimmer advances without spinner ticks (preview ${preview})`, () => {
    let now = 1000
    const time = spyOn(Date, "now").mockImplementation(() => now)
    try {
      const activity = createTurnActivity()
      const ctx = { ...plain, color: true, theme: createTheme({ env: {}, colorDepth: "truecolor" }) }
      const spinner = new Spinner()
      const options = { preview, spinner, waiting: false, running: [] }
      if (!preview) activity.beginSend()
      else activity.render(100, ctx, options)
      now += 400
      const first = activity.render(100, ctx, options)
      now += 33
      const second = activity.render(100, ctx, options)
      expect(second).not.toEqual(first)
      expect(spinner.glyph).toBe("⠋")
    } finally {
      time.mockRestore()
    }
  })
}

test("terminals without suspend retain that capability absence", () => {
  const terminal: { suspend?: () => () => void } = {}
  const clock = createShimmerClock({
    terminal,
    active: () => false,
    covered: () => false,
    requestRender: () => {},
  })
  expect(terminal.suspend).toBeUndefined()
  clock.dispose()
  expect(terminal.suspend).toBeUndefined()
})

test("33 ms clock runs only visible focused colored motion; actual suspend/exit stops it", () => {
  const terminal = new FakeTerminal()
  const originalSuspend = terminal.suspend
  let active = false
  let covered = false
  let scheduled: (() => void) | undefined
  let renders = 0
  const ctx = { ...plain, color: true, theme: createTheme({ env: {}, colorDepth: "truecolor" }) }
  const clock = createShimmerClock({
    terminal,
    active: () => active,
    covered: () => covered,
    requestRender: () => renders++,
    schedule(tick, ms) {
      expect(ms).toBe(33)
      scheduled = tick
      return 1
    },
    cancel() {
      scheduled = undefined
    },
  })
  clock.visibility(true, ctx)
  expect(scheduled).toBeUndefined()
  active = true
  clock.sync()
  scheduled!()
  expect(renders).toBe(1)
  clock.focus(false)
  expect(scheduled).toBeUndefined()
  clock.focus(true)
  expect(scheduled).toBeDefined()
  covered = true
  clock.sync()
  expect(scheduled).toBeUndefined()
  covered = false
  clock.sync()
  const resume = terminal.suspend()
  expect(scheduled).toBeUndefined()
  resume()
  expect(scheduled).toBeDefined()
  clock.visibility(false, ctx)
  expect(scheduled).toBeUndefined()
  clock.visibility(true, { ...ctx, color: false })
  expect(scheduled).toBeUndefined()
  configureShimmer(ctx.theme, resolveShimmer(undefined, "off"))
  clock.visibility(true, ctx)
  expect(scheduled).toBeUndefined()
  configureShimmer(ctx.theme, resolveShimmer())
  clock.sync()
  expect(scheduled).toBeDefined()
  active = false
  clock.sync()
  expect(scheduled).toBeUndefined()
  active = true
  clock.sync()
  clock.dispose()
  expect(scheduled).toBeUndefined()
  expect(terminal.suspend).toBe(originalSuspend)
})

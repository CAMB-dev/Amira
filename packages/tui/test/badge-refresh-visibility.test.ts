import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { key } from "@amira/tui-kit"
import { animationProbe, visibilityHarness } from "./animation-visibility-harness.ts"

beforeEach(() => void jest.useFakeTimers())
afterEach(() => void jest.useRealTimers())

for (const mode of ["fullscreen"] as const) {
  for (const placement of ["fullscreen", "dock"] as const) {
    test(`${mode} ${placement}: clipping a working badge retains only explicit refresh demand`, () => {
      const probe = animationProbe()
      const s = visibilityHarness(mode, {
        kind: "mixed",
        title: () => "Agents",
        follow: false,
        render: (_data, opts) => {
          opts.requestRefresh!(1000)
          return [
            ...Array.from({ length: 30 }, (_, i) => ({ kind: "text" as const, text: `Static row ${i}` })),
            { kind: "segments", parts: opts.statusBadge!("working") },
          ]
        },
      })
      const scroll = (name: "home" | "end") => {
        expect(
          placement === "dock"
            ? s.manager.dock!.viewer.handleInput(key(name))
            : s.manager.handleInput(key(name)),
        ).toBe(true)
        s.view.requestRender()
        jest.advanceTimersByTime(160)
      }
      const measure = (expected: number) => {
        expect(probe.sample().intervals).toBe(1)
        const before = probe.sample()
        jest.advanceTimersByTime(1200)
        expect(probe.sample().wakes - before.wakes).toBe(expected)
        expect(probe.sample().requests - before.requests).toBe(expected)
      }
      try {
        s.manager.openView({ kind: "mixed", placement, maxHeight: 8 })
        jest.advanceTimersByTime(160)
        scroll("end")
        expect(s.screen()).toContain("working")
        measure(15)
        scroll("home")
        expect(s.screen()).not.toContain("working")
        measure(1)
        scroll("end")
        expect(s.screen()).toContain("working")
        measure(15)
      } finally {
        s.dispose()
        probe.restore()
      }
    })
  }
}

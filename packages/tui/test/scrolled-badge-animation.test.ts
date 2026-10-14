import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import type { AgentStatusState, ViewLine } from "@amira/api"
import { key } from "@amira/tui-kit"
import { animationProbe, visibilityHarness } from "./animation-visibility-harness.ts"

beforeEach(() => void jest.useFakeTimers())
afterEach(() => void jest.useRealTimers())

for (const mode of ["inline", "fullscreen"] as const) {
  for (const placement of ["fullscreen", "dock"] as const) {
    for (const widgets of [false, true]) {
      test(`${mode} ${placement} ${widgets ? "widgets" : "lines"}: only visible badges request animation`, () => {
        const probe = animationProbe()
        let state: AgentStatusState = "working"
        const rows = (badge: ViewLine): ViewLine[] => [
          ...Array.from({ length: 30 }, (_, i): ViewLine => ({ kind: "text", text: `Static row ${i}` })),
          badge,
        ]
        const s = visibilityHarness(mode, {
          kind: "scrolled-badge",
          title: () => "Agents",
          follow: false,
          ...(widgets
            ? {
                ui: (_data, opts) => ({
                  type: "text" as const,
                  id: "body",
                  lines: rows({ kind: "segments", parts: opts.statusBadge!(state) }),
                }),
              }
            : {
                render: (_data, opts) => rows({ kind: "segments", parts: opts.statusBadge!(state) }),
              }),
        })
        const scroll = (name: "home" | "end") => {
          const event = key(name)
          expect(
            placement === "dock" ? s.manager.dock!.viewer.handleInput(event) : s.manager.handleInput(event),
          ).toBe(true)
          s.view.requestRender()
          jest.advanceTimersByTime(160)
        }
        try {
          s.manager.openView({ kind: "scrolled-badge", placement, maxHeight: 8 })
          jest.advanceTimersByTime(160)
          scroll("home")
          expect(s.screen()).toContain("Static row 0")
          expect(s.screen()).not.toContain("working")
          const hidden = probe.sample()
          const writes = s.writes()
          jest.advanceTimersByTime(1200)
          expect(probe.sample()).toEqual({ ...hidden, intervals: 0 })
          expect(s.writes()).toBe(writes)

          scroll("end")
          expect(s.screen()).toContain("working")
          expect(probe.sample().intervals).toBe(1)
          const visible = probe.sample()
          jest.advanceTimersByTime(1200)
          expect(probe.sample().wakes - visible.wakes).toBe(15)
          expect(probe.sample().requests - visible.requests).toBe(15)

          scroll("home")
          expect(s.screen()).not.toContain("working")
          const clipped = probe.sample()
          jest.advanceTimersByTime(1200)
          expect(probe.sample()).toEqual({ ...clipped, intervals: 0 })

          scroll("end")
          expect(probe.sample().intervals).toBe(1)
          state = "done"
          s.view.requestRender()
          jest.advanceTimersByTime(160)
          expect(s.screen()).toContain("done")
          const done = probe.sample()
          jest.advanceTimersByTime(1200)
          expect(probe.sample()).toEqual({ ...done, intervals: 0 })
        } finally {
          s.dispose()
          probe.restore()
        }
      })
    }
  }
}

import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { emptyUsage } from "@amira/api"
import { EventBus } from "@amira/core"
import { key } from "@amira/tui-kit"
import { animationProbe, visibilityHarness } from "./animation-visibility-harness.ts"

beforeEach(() => void jest.useFakeTimers())
afterEach(() => void jest.useRealTimers())

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: hidden transcript children have no intervals, wakes or redraw requests`, () => {
    const probe = animationProbe()
    const s = visibilityHarness(mode, {
      kind: "static",
      title: () => "Static overlay",
      render: () => [{ kind: "text", text: "Only static content" }],
    })
    const bus = new EventBus()
    const start = (id: string) =>
      s.view.subagentEvent(
        bus.emit(
          "subagent.start",
          {
            childSessionId: id,
            title: id,
            prompt: "work",
            model: { provider: "mock", model: "m1" },
            depth: 1,
            cwd: "/work",
            context: "fresh",
            queued: false,
          },
          { sessionId: "main" },
        ),
      )
    try {
      start("Visible child")
      s.view.requestRender()
      jest.advanceTimersByTime(160)
      expect(s.screen()).toContain("working Visible child")
      expect(probe.sample().intervals).toBe(1)
      const visible = probe.sample()
      jest.advanceTimersByTime(1200)
      expect(probe.sample().wakes - visible.wakes).toBe(15)
      expect(probe.sample().requests - visible.requests).toBe(15)

      s.manager.openView({ kind: "static" })
      jest.advanceTimersByTime(160)
      expect(s.screen()).toContain("Only static content")
      expect(s.screen()).not.toContain("Visible child")
      const hidden = probe.sample()
      const writes = s.writes()
      jest.advanceTimersByTime(1200)
      expect(probe.sample()).toEqual({ ...hidden, intervals: 0 })
      expect(s.writes()).toBe(writes)

      // New child events cannot restart a hidden transcript's scheduler.
      start("Hidden child")
      s.view.requestRender()
      jest.advanceTimersByTime(160)
      const updated = probe.sample()
      jest.advanceTimersByTime(1200)
      expect(probe.sample()).toEqual({ ...updated, intervals: 0 })

      s.manager.handleInput(key("escape"))
      jest.advanceTimersByTime(160)
      expect(s.screen()).toContain("working Hidden child")
      expect(probe.sample().intervals).toBe(1)
      const restored = probe.sample()
      jest.advanceTimersByTime(1200)
      expect(probe.sample().wakes - restored.wakes).toBe(15)
      expect(probe.sample().requests - restored.requests).toBe(15)

      // Completion while covered must not revive demand when uncovered.
      s.manager.openView({ kind: "static" })
      for (const id of ["Visible child", "Hidden child"]) {
        s.view.subagentEvent(
          bus.emit(
            "subagent.end",
            { childSessionId: id, status: "done", usage: emptyUsage(), durationMs: 0 },
            { sessionId: "main" },
          ),
        )
      }
      s.manager.handleInput(key("escape"))
      jest.advanceTimersByTime(160)
      const done = probe.sample()
      jest.advanceTimersByTime(1200)
      expect(probe.sample()).toEqual({ ...done, intervals: 0 })
    } finally {
      s.dispose()
      probe.restore()
    }
  })
}

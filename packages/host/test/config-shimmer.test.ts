import { expect, test } from "bun:test"
import { validateSettings } from "../src/config/schema.ts"
import { normalizeShimmer } from "../src/shimmer.ts"

test("settings schema preserves shimmer for fallback notices rather than rejecting the file", () => {
  for (const shimmer of [
    "pulse",
    { width: 3 },
    { preset: "sweep", edge: "linear" },
    null,
    "unknown",
    { width: "bad" },
  ]) {
    const result = validateSettings({ tui: { shimmer } }, "test-settings.json")
    const loaded: unknown = result.settings.tui?.shimmer
    expect(loaded).toEqual(shimmer)
    expect(result.warnings).toEqual([])
  }
})

test("numeric shimmer settings clamp through shared normalization after loading", () => {
  const { settings } = validateSettings({ tui: { shimmer: { width: 100, period: 1 } } }, "test-settings.json")
  const notices: string[] = []
  expect(normalizeShimmer(settings.tui?.shimmer, (text) => notices.push(text))).toEqual({
    width: 20,
    period: 400,
  })
  expect(notices).toHaveLength(1)
})

import { expect, test } from "bun:test"
import { validateSettings } from "@amira/core"
import { contextFromSettings } from "../src/session.ts"

test("settings context: checked, then handed to the agent with megabytes as bytes", () => {
  const raw = {
    context: {
      outputs: { saveAbove: 20_000, previewChars: 30_000, quotaMB: 64 },
      dedupeReads: false,
      aging: {
        enabled: true,
        start: 0.75,
        target: 0.5,
        minSavedTokens: 4000,
        keepTurns: 3,
        keepSteps: 4,
        afterTurns: 0,
      },
    },
  }
  const { settings, warnings } = validateSettings(raw, "settings.json")
  expect(warnings).toEqual([])
  expect(contextFromSettings(settings.context)).toEqual({
    saveAbove: 20_000,
    // A preview never longer than what is saved.
    previewChars: 20_000,
    quotaBytes: 64 * 1024 * 1024,
    dedupeReads: false,
    aging: {
      enabled: true,
      start: 0.75,
      target: 0.5,
      minSavedTokens: 4000,
      keepTurns: 3,
      keepSteps: 4,
      afterTurns: 0,
    },
  })
  expect(contextFromSettings(undefined)).toBeUndefined()
  expect(contextFromSettings({})).toBeUndefined()
  expect(() => validateSettings({ context: { aging: { start: 1.5 } } }, "s.json")).toThrow(
    '"context.aging.start" must be a number between 0 and 1',
  )
  expect(() => validateSettings({ context: { outputs: { saveAbove: 10 } } }, "s.json")).toThrow(
    "context.outputs.saveAbove",
  )
  expect(validateSettings({ context: { nope: 1 } }, "s.json").warnings.join()).toContain("context.nope")
})

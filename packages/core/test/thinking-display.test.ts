import { expect, test } from "bun:test"
import { providersFromSettings } from "../src/config/providers.ts"
import { validateSettings } from "../src/config/schema.ts"

test.each(["summarized", "omitted"] as const)(
  "validates thinking display %s at each scope",
  (thinkingDisplay) => {
    const input = {
      providers: {
        anthropic: {
          dialect: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          compat: { thinking: "adaptive" as const, thinkingDisplay },
          defaultModel: { compat: { thinkingDisplay } },
          models: [{ id: "claude-opus-5-5", compat: { thinkingDisplay } }],
        },
      },
    }
    const result = validateSettings(input, "settings.json")
    expect(result).toEqual({ settings: input, warnings: [] })
    expect(providersFromSettings(result.settings.providers)[0]?.models?.[0]?.compat).toEqual({
      thinkingDisplay,
    })
  },
)

test.each(["updates", "invalid", "", null, false, 42])(
  "rejects unsupported thinking display %j",
  (thinkingDisplay) => {
    const compat = { thinkingDisplay }
    for (const provider of [{ compat }, { defaultModel: { compat } }, { models: [{ id: "m", compat }] }]) {
      expect(() => validateSettings({ providers: { p: provider } }, "settings.json")).toThrow(
        'must be one of "summarized", "omitted"',
      )
    }
  },
)

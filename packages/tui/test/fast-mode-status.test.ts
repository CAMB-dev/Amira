import { expect, test } from "bun:test"
import { ThemeRegistry } from "@amira/core"
import { visibleWidth } from "@amira/tui-kit"
import { setup, waitFor } from "./app-harness.ts"

const marker = /\bfast\b/

test.each([
  ["inline", "anthropic-messages"],
  ["fullscreen", "anthropic-messages"],
  ["inline", "openai-responses"],
  ["fullscreen", "openai-responses"],
] as const)(
  "%s bottom status shows the ASCII fast marker for %s only while fast mode is applied",
  async (mode, dialect) => {
    const s = await setup([], {
      cols: 80,
      settings: { mode },
      prepare: async (agent) => {
        agent.model = {
          ...agent.model,
          dialect,
          fast:
            dialect === "anthropic-messages"
              ? { kind: "anthropic-speed" }
              : { kind: "service-tier", value: "priority" },
        }
        agent.fastMode = true
      },
    })
    try {
      await waitFor(() => marker.test(s.live()), "fast status marker")
      const status = s.screen.lines.find((line) => marker.test(line))!
      expect(status).toContain("m1")
      expect(status).toContain("auto")
      expect(status.trimEnd()).toEndWith("fast")
      expect(visibleWidth(status)).toBeLessThanOrEqual(80)

      s.agent.fastMode = false
      s.terminal.send("a")
      await waitFor(() => !marker.test(s.live()), "disabled marker")
      s.agent.fastMode = true
      s.terminal.send("b")
      await waitFor(() => marker.test(s.live()), "enabled marker")
      const supported = s.agent.model
      s.agent.model = { ...supported, fast: false }
      s.terminal.send("c")
      await waitFor(() => !marker.test(s.live()), "unsupported model marker omitted")
      expect(s.agent.fastMode).toBe(true)
      s.agent.model = { ...supported, dialect: "mock" }
      s.terminal.send("d")
      await Bun.sleep(40)
      expect(marker.test(s.live())).toBe(false)
    } finally {
      s.terminal.send("\x03\x03")
      expect(await s.exited).toBe(0)
    }
  },
)

test("the fast marker uses the theme accent and fits narrow status lines", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "fast-test", dark: { accent: "#010203" } }, "user")
  const s = await setup([], {
    cols: 40,
    themes,
    settings: { mode: "fullscreen", theme: "fast-test", colorDepth: "truecolor" },
    prepare: async (agent) => {
      agent.model = {
        ...agent.model,
        dialect: "anthropic-messages",
        fast: { kind: "anthropic-speed" },
      }
      agent.fastMode = true
    },
  })
  try {
    await waitFor(() => marker.test(s.live()), "themed marker")
    expect(s.terminal.output).toContain("\x1b[38;2;1;2;3mfast")
    for (const width of [24, 16, 8]) {
      s.screen.resize(width, 20)
      s.terminal.setSize(width, 20)
      await Bun.sleep(40)
      expect(s.screen.lines.every((line) => visibleWidth(line) <= width)).toBe(true)
    }
  } finally {
    s.terminal.send("\x03\x03")
    expect(await s.exited).toBe(0)
  }
})

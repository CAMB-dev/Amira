import { expect, test } from "bun:test"
import { monoTheme, stripAnsi } from "@amira/tui-kit"
import { interactiveBanner } from "../src/app/terminal.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"

test("interactive terminal banner uses the configured separator", () => {
  const before = { ...glyphs }
  try {
    setGlyphs({ separator: "|" })
    expect(stripAnsi(interactiveBanner(monoTheme, { provider: "mock", id: "m1" }, "/work"))).toBe(
      "Amira | mock/m1 | /work",
    )
  } finally {
    setGlyphs(before)
  }
})

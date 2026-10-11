import { expect, test } from "bun:test"
import { marginFrame, zeroMargins } from "./margins-fixture.ts"

for (const fullscreen of [true, false]) {
  for (const columns of [100, 70]) {
    test(`zero margins preserve ${fullscreen ? "fullscreen" : "inline"} ANSI and scrollback at ${columns}x30`, () => {
      expect(marginFrame(fullscreen, columns, 30, zeroMargins)).toMatchSnapshot()
    })
  }
}

// Snapshot update: intact typing borders and a separate status row shift the transcript viewport.
import { expect, test } from "bun:test"
import { marginFrame, zeroMargins } from "./margins-fixture.ts"

// Intentional ANSI snapshots: shared grid, reading fills, typing borders, reference roles and ›/·.
for (const fullscreen of [true]) {
  for (const columns of [100, 70]) {
    test(`polished zero-margin fullscreen ANSI and scrollback at ${columns}x30`, () => {
      expect(marginFrame(fullscreen, columns, 30, zeroMargins)).toMatchSnapshot()
    })
  }
}

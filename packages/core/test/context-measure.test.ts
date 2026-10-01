import { expect, test } from "bun:test"
import { measure } from "../../../scripts/context-measure.ts"

// The offline measurement (A4) at a small scale: the projection carries less than the whole
// session, without breaking pairing or changing what earlier requests sent.
test("context management shrinks a long session's requests and keeps them consistent", async () => {
  const [result] = await measure({ scenarios: ["long-session"], variants: ["before", "after"], scale: 0.1 })
  const before = result!.variants.find((v) => v.variant === "before")!
  const after = result!.variants.find((v) => v.variant === "after")!
  expect(after.area).toBeLessThan(before.area)
  expect(after.artifacts).toBeGreaterThan(0)
  for (const v of [before, after]) {
    expect(v.pairingErrors).toBe(0)
    expect(v.unexpectedChanges).toBe(0)
  }
})

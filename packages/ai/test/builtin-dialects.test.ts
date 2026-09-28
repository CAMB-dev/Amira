import { expect, test } from "bun:test"
import { BUILTIN_DIALECTS } from "../src/index.ts"

test("registers the responses and gemini dialects", () => {
  const ids = BUILTIN_DIALECTS.map((d) => d.id)
  expect(ids).toContain("openai-responses")
  expect(ids).toContain("google-gemini")
})

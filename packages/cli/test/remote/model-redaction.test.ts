import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { StreamEvent } from "@amira/ai"
import { ModelStreamRedactor } from "../../src/remote/model-redaction.ts"

const terminal: StreamEvent = {
  type: "done",
  message: { role: "assistant", content: [], model: { provider: "p", model: "m" } },
}
function redacted(chunks: string[], secrets: string[]) {
  const redactor = new ModelStreamRedactor(secrets)
  const events = chunks.flatMap((text) => redactor.push({ type: "text.delta", text }))
  events.push(...redactor.push(terminal))
  return events.flatMap((event) => (event.type === "text.delta" ? [event.text] : [])).join("")
}

test("masking cannot form a credential at a replacement join across delta frames", () => {
  expect(redacted(["ar", "edbcxxxxxxxxxx"], ["abc", "red"])).not.toContain("abc")
  expect(redacted(["ar", "ed", "bc", "xxxxxxxxxx"], ["abc", "red"])).not.toContain("abc")
})

test("lookbehind is measured after redaction, not after raw bytes that were removed", () => {
  const secrets = ["prefix-suffix", "red"]
  const result = redacted(["prefix-", "redredredredredredredred", "suffixxxxxxxxxxxxxxxxx"], secrets)
  for (const secret of secrets) expect(result).not.toContain(secret)
})

test("overlapping literals, repeated masking and split boundaries converge to secret-free output", () => {
  for (const input of ["aredbcxxxxxxxxxx", "abcabcaredbc", "abredcredred", "aXXb", "abcxxxxabc"]) {
    for (let size = 1; size <= input.length; size++) {
      const chunks = []
      for (let start = 0; start < input.length; start += size) chunks.push(input.slice(start, start + size))
      const secrets = ["abc", "red", "XX", "a[redacted]b"]
      const output = redacted(chunks, secrets)
      for (const secret of secrets) expect(output).not.toContain(secret)
    }
  }
})

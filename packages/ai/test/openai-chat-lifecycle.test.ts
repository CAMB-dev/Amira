import { expect, test } from "bun:test"
import { endlessServer, request, waitFor } from "./helpers.ts"

test("stopping iteration mid-stream cancels the HTTP body", async () => {
  const { ai, state, stop } = endlessServer()
  try {
    let n = 0
    for await (const e of ai.stream(request(ai))) {
      if (e.type === "text.delta" && ++n === 2) break
    }
    expect(await waitFor(() => state.cancelled)).toBe(true)
  } finally {
    stop()
  }
})

test("stopping iteration right after start cancels the HTTP body", async () => {
  const { ai, state, stop } = endlessServer()
  try {
    for await (const e of ai.stream(request(ai))) {
      if (e.type === "start") break
    }
    expect(await waitFor(() => state.cancelled)).toBe(true)
  } finally {
    stop()
  }
})

import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { ToolResult } from "@amira/api"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import { validateRemoteDto, validateRemoteFrame } from "../../src/remote-schema.ts"

const result = {
  content: [{ type: "text", text: "answered" }],
  details: { answers: ["A"] },
  persistDetails: true,
} satisfies ToolResult
for (const type of ["tool.execute.end", "tool.execute.update"] as const) {
  test(`${type} preserves persistDetails while rejecting unknown result fields`, () => {
    const field = type === "tool.execute.end" ? "result" : "partial"
    const data = {
      toolCallId: "ask-1",
      name: "ask_user",
      [field]: result,
      ...(type === "tool.execute.end" ? { durationMs: 1 } : {}),
    }
    const event = { seq: 1, ts: 1, sessionId: "s1", type, data }
    validateRemoteDto("coreEvent", event)
    const frame = validateRemoteFrame({ v: 1, kind: "event", daemonEpoch: "epoch-1", seq: 1, payload: event })
    if (frame.kind === "chunk") throw new Error("Expected complete event")
    const decoder = new RemoteDecoder()
    expect([...encodeRemoteMessage(frame)].flatMap((bytes) => decoder.push(bytes))).toEqual([frame])
    decoder.finish()
    for (const invalid of [
      { ...result, unexpected: true },
      { ...result, persistDetails: "true" },
    ])
      expect(() =>
        validateRemoteDto("coreEvent", { ...event, data: { ...data, [field]: invalid } }),
      ).toThrow()
  })
}

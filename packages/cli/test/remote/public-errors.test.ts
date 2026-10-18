import "../server/offline.ts"
import { expect, test } from "bun:test"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import { publicUpdateError } from "../../src/remote/public-errors.ts"
import { RemoteWriter } from "../../src/remote/writer.ts"
import { validateRemoteDto } from "../../src/remote-schema.ts"

test("wire serialization canonicalizes error-update messages even without a runtime adapter", () => {
  const frames = [
    ...encodeRemoteMessage({
      v: 1,
      kind: "event",
      daemonEpoch: "epoch-1",
      seq: 1,
      payload: {
        kind: "error",
        error: { code: "invalid_snapshot", message: "SENTINEL_PROVIDER_SECRET" },
      },
    }),
  ]
  expect(new TextDecoder().decode(Buffer.concat(frames))).not.toContain("SENTINEL")
  const decoder = new RemoteDecoder()
  expect(frames.flatMap((frame) => decoder.push(frame))).toMatchObject([{ payload: publicUpdateError() }])
  decoder.finish()
})

test("outgoing unknown error codes are allowlisted without relaxing DTO closure", async () => {
  const message = {
    v: 1 as const,
    kind: "event" as const,
    daemonEpoch: "epoch-1",
    seq: 1,
    payload: {
      kind: "error",
      error: { code: "SENTINEL_UNKNOWN_CODE", message: "SENTINEL_PROVIDER_SECRET" },
    },
  }
  const frames = [...encodeRemoteMessage(message)]
  expect(new TextDecoder().decode(Buffer.concat(frames))).not.toContain("SENTINEL")
  const decoder = new RemoteDecoder()
  expect(frames.flatMap((frame) => decoder.push(frame))).toMatchObject([{ payload: publicUpdateError() }])
  decoder.finish()
  let writes = 0
  const writer = new RemoteWriter(async () => {
    writes++
  })
  try {
    await expect(
      writer.send({ ...message, payload: { ...message.payload, unexpected: "private" } }),
    ).rejects.toMatchObject({ code: "invalid_frame" })
    expect(writes).toBe(0)
  } finally {
    writer.close()
  }
})

for (const code of [
  undefined,
  "invalid_snapshot",
  "SENTINEL_PROVIDER_SECRET",
  null,
  1,
  {
    toString() {
      throw new Error("Must not coerce unknown error codes")
    },
  },
]) {
  test(`public update errors use allowlisted codes and fixed messages (${typeof code})`, () => {
    const value = publicUpdateError(code)
    expect(value).toEqual({
      kind: "error",
      error: { code: "invalid_snapshot", message: "Workspace display state is unavailable." },
    })
    validateRemoteDto("update", value)
    expect(JSON.stringify(value)).not.toContain("SENTINEL")
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect(Object.getPrototypeOf(value.error)).toBeNull()
  })
}

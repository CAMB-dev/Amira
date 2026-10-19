import "./offline.ts"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createServerUploadOperations } from "../../src/server/uploads.ts"

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const metadata = (bytes = png) => ({
  name: "screen.png",
  mimeType: "image/png" as const,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
})

test("uploads bounded chunks and only consumes attachments on accepted input", async () => {
  const service = createServerUploadOperations({ generation: () => 1 })
  try {
    const { uploadId } = await service.handlers["uploads.begin"](metadata())
    expect(
      await service.handlers["uploads.chunk"]({ uploadId, offset: 0, data: png.toString("base64") }),
    ).toEqual({ received: 8 })
    const { attachmentId } = await service.handlers["uploads.finish"]({ uploadId })
    expect(attachmentId).not.toBe(uploadId)
    const rejected = service.prepare([attachmentId])
    expect(rejected.images).toEqual([
      { type: "image", name: "screen.png", mimeType: "image/png", data: "iVBORw0KGgo=" },
    ])
    expect(() => service.prepare([attachmentId])).toThrow()
    rejected.rollback()
    const accepted = service.prepare([attachmentId])
    accepted.commit()
    expect(() => service.prepare([attachmentId])).toThrow()
    expect(await service.handlers["uploads.cancel"]({ uploadId })).toEqual({ cancelled: false })
  } finally {
    service.dispose()
  }
})

test("abandoned uploads expire, selection fences old ids, and hashes/MIME fail closed", async () => {
  let generation = 1
  let now = 0
  const service = createServerUploadOperations({ generation: () => generation, now: () => now, ttlMs: 10 })
  const h = service.handlers
  try {
    const first = await h["uploads.begin"](metadata())
    now = 11
    await expect(
      h["uploads.chunk"]({ uploadId: first.uploadId, offset: 0, data: png.toString("base64") }),
    ).rejects.toThrow("expired")
    const second = await h["uploads.begin"](metadata())
    generation++
    await expect(h["uploads.finish"](second)).rejects.toThrow("expired")
    const bad = await h["uploads.begin"]({ ...metadata(), sha256: "0".repeat(64) })
    await h["uploads.chunk"]({ ...bad, offset: 0, data: png.toString("base64") })
    await expect(h["uploads.finish"](bad)).rejects.toThrow("checksum")
    const fake = Buffer.from("not-a-png")
    const wrong = await h["uploads.begin"](metadata(fake))
    await h["uploads.chunk"]({ ...wrong, offset: 0, data: fake.toString("base64") })
    await expect(h["uploads.finish"](wrong)).rejects.toThrow("MIME")
    await expect(h["uploads.begin"]({ ...metadata(), name: "../escape.png" })).rejects.toThrow()
    const pending = await h["uploads.begin"](metadata())
    await expect(h["uploads.chunk"]({ ...pending, offset: 1, data: png.toString("base64") })).rejects.toThrow(
      "offset",
    )
    await expect(h["uploads.chunk"]({ ...pending, offset: 0, data: "!invalid!" })).rejects.toThrow()
  } finally {
    service.dispose()
  }
})

test("upload reservations and message aggregate payloads are bounded", async () => {
  const service = createServerUploadOperations({ generation: () => 1 })
  const h = service.handlers
  try {
    await h["uploads.begin"]({ ...metadata(), bytes: 5 * 1024 * 1024 })
    await expect(h["uploads.begin"](metadata())).rejects.toThrow("capacity")
    service.dispose()
    const begin = await h["uploads.begin"](metadata())
    await h["uploads.chunk"]({ ...begin, offset: 0, data: png.toString("base64") })
    const { attachmentId } = await h["uploads.finish"](begin)
    const prepared = service.prepare([attachmentId])
    expect(await h["uploads.cancel"](begin)).toEqual({ cancelled: false })
    prepared.rollback()
    expect(await h["uploads.cancel"](begin)).toEqual({ cancelled: true })
  } finally {
    service.dispose()
  }
})

import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { UserMessage } from "@amira/api"
import { FrontendOperationError } from "@amira/core"
import { type RemoteUploadClient, sendRemoteImages } from "../../src/remote/image-upload.ts"
import { createUploadSender } from "../../src/server/upload-send.ts"
import { createServerUploadOperations } from "../../src/server/uploads.ts"

const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const image = { type: "image" as const, name: "画.png", mimeType: "image/png", data: data.toString("base64") }

test("rejected image steering releases its reservation without consuming ready attachments", async () => {
  const uploads = createServerUploadOperations({ generation: () => 1 })
  let busy = true
  let received: UserMessage | undefined
  const send = createUploadSender({
    uploads,
    send: async (_operation, params) => {
      if (busy) throw new FrontendOperationError("agent_busy", "busy")
      received = params.message as UserMessage
      return { sessionGeneration: 1 }
    },
  })
  try {
    const begin = await uploads.handlers["uploads.begin"]({
      name: image.name,
      mimeType: "image/png",
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    })
    await uploads.handlers["uploads.chunk"]({ ...begin, offset: 0, data: image.data })
    const { attachmentId } = await uploads.handlers["uploads.finish"](begin)
    const params = {
      operation: "turn.steer" as const,
      message: {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "before" },
          { type: "attachment" as const, attachmentId },
          { type: "text" as const, text: "after" },
        ],
      },
    }
    await expect(send(params)).rejects.toMatchObject({ code: "agent_busy" })
    busy = false
    await send(params)
    expect(received?.content).toEqual([
      { type: "text", text: "before" },
      image,
      { type: "text", text: "after" },
    ])
    await expect(send(params)).rejects.toThrow("expired")
  } finally {
    uploads.dispose()
  }
})

test("local upload helper fences selection changes and releases abandoned chunks", async () => {
  const uploads = createServerUploadOperations({ generation: () => generation })
  let generation = 1
  let cancelled = false
  const client: RemoteUploadClient = {
    get sessionGeneration() {
      return generation
    },
    async request(operation, params, options) {
      if (operation === "uploads.send") throw new Error("stale input must not be sent")
      const result = await uploads.handlers[operation as keyof typeof uploads.handlers](
        params as never,
        options,
      )
      if (operation === "uploads.begin") generation++
      if (operation === "uploads.cancel") cancelled = true
      return result as never
    },
  }
  try {
    await expect(
      sendRemoteImages(client, { operation: "turn.prompt", message: { role: "user", content: [image] } }),
    ).rejects.toThrow("session changed")
    // Cleanup carries the old authority and must not cancel a new session's upload.
    expect(cancelled).toBe(false)
    const signal = AbortSignal.abort()
    await expect(
      sendRemoteImages(
        client,
        { operation: "turn.prompt", message: { role: "user", content: [image] } },
        { signal },
      ),
    ).rejects.toThrow("cancelled")
  } finally {
    uploads.dispose()
  }
})

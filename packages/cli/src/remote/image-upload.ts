import { createHash } from "node:crypto"
import type { UserMessage } from "@amira/api"
import type { FrontendExecuteOptions } from "@amira/core"
import type { ServerUploadOperations } from "../server/uploads.ts"
import { MAX_IMAGE_BYTES, MAX_UPLOAD_CHUNK_BYTES } from "./schema/files.ts"
import type { ServerUploadSendOperations } from "./schema/upload-send.ts"

type UploadOperations = ServerUploadOperations & ServerUploadSendOperations
type WithImages<P> = P extends { message: unknown } ? Omit<P, "message"> & { message: UserMessage } : never
export interface RemoteUploadClient {
  readonly sessionGeneration: number
  request<K extends keyof UploadOperations>(
    operation: K,
    params: UploadOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<UploadOperations[K]["result"]>
}

/** Upload bytes, never a local pathname; content order and display metadata survive steering. */
export async function sendRemoteImages(
  client: RemoteUploadClient,
  params: WithImages<ServerUploadSendOperations["uploads.send"]["params"]>,
  options?: FrontendExecuteOptions,
): Promise<{ sessionGeneration: number }> {
  const sessionGeneration = options?.sessionGeneration ?? client.sessionGeneration
  const captured = { ...options, sessionGeneration }
  const { operationId: _submissionId, ...staging } = captured
  const uploads: string[] = []
  const check = () => {
    if (options?.signal?.aborted) throw new Error("Image upload cancelled")
    if (client.sessionGeneration !== sessionGeneration) throw new Error("The active session changed")
  }
  let total = 0
  const images = params.message.content.map((block) => {
    if (block.type !== "image") return undefined
    if (block.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) throw new Error("Images are limited to 5 MiB")
    const bytes = Buffer.from(block.data, "base64")
    if (!bytes.length || bytes.toString("base64") !== block.data) throw new Error("Invalid image encoding")
    total += bytes.length
    return bytes
  })
  if (total > MAX_IMAGE_BYTES) throw new Error("Images in a message are limited to 5 MiB total")
  try {
    const content: ServerUploadSendOperations["uploads.send"]["params"]["message"]["content"] = []
    for (const [index, block] of params.message.content.entries()) {
      check()
      if (block.type === "text") {
        content.push(block)
        continue
      }
      const bytes = images[index]!
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType))
        throw new Error("Unsupported image format")
      const { uploadId } = await client.request(
        "uploads.begin",
        {
          name:
            block.name ?? `attachment.${block.mimeType === "image/jpeg" ? "jpg" : block.mimeType.slice(6)}`,
          mimeType: block.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        staging,
      )
      uploads.push(uploadId)
      for (let offset = 0; offset < bytes.length; offset += MAX_UPLOAD_CHUNK_BYTES) {
        check()
        await client.request(
          "uploads.chunk",
          {
            uploadId,
            offset,
            data: bytes.subarray(offset, offset + MAX_UPLOAD_CHUNK_BYTES).toString("base64"),
          },
          staging,
        )
      }
      check()
      const { attachmentId } = await client.request("uploads.finish", { uploadId }, staging)
      content.push({ type: "attachment", attachmentId })
    }
    check()
    return await client.request(
      "uploads.send",
      { ...params, message: { ...params.message, content } },
      captured,
    )
  } finally {
    // Accepted attachments have already been consumed; rejected/abandoned uploads are released.
    await Promise.allSettled(
      uploads.map((uploadId) => client.request("uploads.cancel", { uploadId }, { sessionGeneration })),
    )
  }
}

import { createHash, randomUUID } from "node:crypto"
import type { ImageBlock } from "@amira/ai"
import type { FrontendExecuteOptions } from "@amira/core"
import {
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_CHUNK_BYTES,
  type OperationsFromSchemas,
  uploadOperationSchemas,
} from "../remote/schema/files.ts"
import { failure, type OperationHandlers, operationGuard, validate } from "./file-support.ts"
import { checkedImage } from "./images.ts"

export type ServerUploadOperations = OperationsFromSchemas<typeof uploadOperationSchemas>
interface Upload {
  id: string
  attachmentId?: string
  generation: number
  expires: number
  name: string
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  hash: string
  buffer: Buffer
  received: number
  locked?: symbol
}

/** In-memory, finite session-scoped staging. No destination path, filesystem or detached work. */
export function createServerUploadOperations(deps: {
  generation: () => number
  now?: () => number
  ttlMs?: number
}) {
  const uploads = new Map<string, Upload>()
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? 60_000
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw new RangeError("Invalid upload TTL")
  const prune = () => {
    for (const [id, upload] of uploads) {
      if (!upload.locked && (upload.expires <= now() || upload.generation !== deps.generation()))
        uploads.delete(id)
    }
  }
  const find = (id: string) => {
    prune()
    const upload = uploads.get(id)
    if (!upload || upload.generation !== deps.generation()) failure("The upload expired")
    return upload
  }
  const handlers: OperationHandlers<ServerUploadOperations> = {
    "uploads.begin": async (params, options) => {
      operationGuard(deps.generation, options)()
      prune()
      const used = [...uploads.values()].reduce((sum, upload) => sum + upload.buffer.length, 0)
      if (uploads.size >= 8 || used + params.bytes > MAX_IMAGE_BYTES)
        failure("Image upload capacity exceeded")
      const id = randomUUID()
      uploads.set(id, {
        id,
        generation: deps.generation(),
        expires: now() + ttl,
        name: params.name,
        mimeType: params.mimeType,
        hash: params.sha256,
        buffer: Buffer.alloc(params.bytes),
        received: 0,
      })
      return { uploadId: id }
    },
    "uploads.chunk": async ({ uploadId, offset, data }, options) => {
      operationGuard(deps.generation, options)()
      const upload = find(uploadId)
      if (upload.attachmentId || upload.locked || offset !== upload.received)
        failure("Invalid upload offset or state")
      const bytes = Buffer.from(data, "base64")
      if (
        !bytes.length ||
        bytes.length > MAX_UPLOAD_CHUNK_BYTES ||
        bytes.toString("base64") !== data ||
        offset + bytes.length > upload.buffer.length
      )
        failure("Invalid upload chunk")
      bytes.copy(upload.buffer, offset)
      upload.received += bytes.length
      upload.expires = now() + ttl
      return { received: upload.received }
    },
    "uploads.finish": async ({ uploadId }, options) => {
      operationGuard(deps.generation, options)()
      const upload = find(uploadId)
      if (upload.attachmentId) return { attachmentId: upload.attachmentId }
      if (
        upload.received !== upload.buffer.length ||
        createHash("sha256").update(upload.buffer).digest("hex") !== upload.hash
      ) {
        uploads.delete(uploadId)
        failure("Image upload length or checksum mismatch")
      }
      try {
        checkedImage(upload.buffer, upload.name, upload.mimeType)
      } catch (error) {
        uploads.delete(uploadId)
        throw error
      }
      upload.attachmentId = randomUUID()
      upload.expires = now() + ttl
      return { attachmentId: upload.attachmentId }
    },
    "uploads.cancel": async ({ uploadId }, options) => {
      operationGuard(deps.generation, options)()
      prune()
      if (uploads.get(uploadId)?.locked) return { cancelled: false }
      return { cancelled: uploads.delete(uploadId) }
    },
  }
  for (const operation of Object.keys(handlers) as (keyof ServerUploadOperations)[]) {
    const handler = handlers[operation]
    Object.assign(handlers, {
      [operation]: async (params: never, options?: FrontendExecuteOptions) => {
        validate(uploadOperationSchemas[operation].params, params)
        return handler(params, options)
      },
    })
  }
  return {
    handlers,
    prepare(ids: readonly string[], options?: FrontendExecuteOptions) {
      const check = operationGuard(deps.generation, options)
      prune()
      const selected = ids.map((id) => {
        const upload = [...uploads.values()].find((upload) => upload.attachmentId === id)
        if (!upload || upload.generation !== deps.generation() || upload.locked)
          failure("The attachment expired or is in use")
        return upload
      })
      if (selected.reduce((sum, upload) => sum + upload.buffer.length, 0) > MAX_IMAGE_BYTES)
        failure("Images in a message are limited to 5 MiB total")
      const token = Symbol()
      const images: ImageBlock[] = selected.map((upload) => ({
        type: "image",
        name: upload.name,
        mimeType: upload.mimeType,
        data: upload.buffer.toString("base64"),
      }))
      for (const upload of selected) upload.locked = token
      let settled = false
      return {
        images,
        commit() {
          if (settled) return
          // Admission is already acknowledged. Release bytes even if selection changed meanwhile.
          settled = true
          for (const upload of selected) if (uploads.get(upload.id) === upload) uploads.delete(upload.id)
        },
        rollback() {
          if (settled) return
          settled = true
          for (const upload of selected) if (upload.locked === token) delete upload.locked
          prune()
        },
        check,
      }
    },
    dispose() {
      uploads.clear()
    },
  }
}

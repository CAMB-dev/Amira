import { array, bool, constrain, enumeration, integer, object, type SchemaType, text } from "./base.ts"

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_UPLOAD_CHUNK_BYTES = 128 * 1024
const opaqueId = constrain(text, { minLength: 1, maxLength: 128 })
const scope = constrain(text, { minLength: 1, maxLength: 128 })
const limit = constrain(integer, { minimum: 1, maximum: 100 })
const name = constrain(text, { minLength: 1, maxLength: 255, pattern: "^[^/\\\\\\u0000-\\u001f\\u007f]+$" })
const size = constrain(integer, { minimum: 1, maximum: MAX_IMAGE_BYTES })
const sha256 = constrain(text, { pattern: "^[a-f0-9]{64}$" })
export const imageMime = enumeration("image/png", "image/jpeg", "image/gif", "image/webp")
export const imagePayload = object({ name, mimeType: imageMime, data: text, bytes: size })
export type ServerImage = SchemaType<typeof imagePayload>
const page = object({
  generation: opaqueId,
  entries: constrain(array(text), { maxItems: 100 }),
  partial: bool,
  "nextCursor?": opaqueId,
})
const pageParams = { "scope?": scope, "cursor?": opaqueId, "limit?": limit }
const ack = object({ cancelled: bool })

/** Closed DTOs; callers select host-known scopes, never a cwd or destination path. */
export const fileOperationSchemas = {
  "files.list": { params: object(pageParams), result: page },
  "files.refresh": { params: object({ "scope?": scope, "limit?": limit }), result: page },
  "files.cancel": { params: object({ "scope?": scope, generation: opaqueId }), result: ack },
  "images.read": {
    params: object({ "scope?": scope, path: constrain(text, { minLength: 1, maxLength: 4096 }) }),
    result: imagePayload,
  },
  "artifacts.read": {
    params: object({ "scope?": scope, id: opaqueId }),
    result: object({ name, data: text, bytes: size }),
  },
}

export const uploadOperationSchemas = {
  "uploads.begin": {
    params: object({ name, mimeType: imageMime, bytes: size, sha256 }),
    result: object({ uploadId: opaqueId }),
  },
  "uploads.chunk": {
    params: object({
      uploadId: opaqueId,
      offset: integer,
      data: constrain(text, { minLength: 4, maxLength: 4 * Math.ceil(MAX_UPLOAD_CHUNK_BYTES / 3) }),
    }),
    result: object({ received: integer }),
  },
  "uploads.finish": {
    params: object({ uploadId: opaqueId }),
    result: object({ attachmentId: opaqueId }),
  },
  "uploads.cancel": { params: object({ uploadId: opaqueId }), result: ack },
}

export type OperationsFromSchemas<S extends Record<string, { params: unknown; result: unknown }>> = {
  [K in keyof S]: {
    params: SchemaType<S[K]["params"]>
    result: SchemaType<S[K]["result"]>
  }
}

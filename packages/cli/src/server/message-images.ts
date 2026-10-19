import type { UserMessage } from "@amira/api"
import { MAX_IMAGE_BYTES } from "../remote/schema/files.ts"
import { failure } from "./file-support.ts"
import { checkedImage } from "./images.ts"

/** Inline compatibility calls obey the same cap/magic checks as uploaded attachments. */
export function validateMessageImages(message: string | UserMessage): void {
  if (typeof message === "string") return
  let total = 0
  for (const block of message.content) {
    if (block.type !== "image") continue
    if (block.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) failure("Images are limited to 5 MiB")
    const bytes = Buffer.from(block.data, "base64")
    if (bytes.toString("base64") !== block.data) failure("Invalid image encoding")
    const suffix = block.mimeType === "image/jpeg" ? "jpg" : block.mimeType.slice(6)
    if (checkedImage(bytes, `attachment.${suffix}`).mimeType !== block.mimeType)
      failure("Unsupported image format")
    total += bytes.length
    if (total > MAX_IMAGE_BYTES) failure("Images in a message are limited to 5 MiB total")
  }
}

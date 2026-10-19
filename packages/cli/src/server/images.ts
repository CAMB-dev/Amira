import { extname } from "node:path"
import { MAX_IMAGE_BYTES, type ServerImage } from "../remote/schema/files.ts"
import { failure } from "./file-support.ts"

const MIME: Record<string, ServerImage["mimeType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

/** Narrow copy of the local image-input signature checks, without TUI or clipboard imports. */
export function checkedImage(
  bytes: Buffer,
  name: string,
  mimeType = MIME[extname(name).toLowerCase()],
): ServerImage {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) failure("Images are limited to 5 MiB")
  if (!mimeType || MIME[extname(name).toLowerCase()] !== mimeType) failure("Unsupported image format")
  const valid =
    mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mimeType === "image/gif"
          ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))
          : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
            bytes.subarray(8, 12).toString("ascii") === "WEBP"
  if (!valid) failure("Image data does not match its MIME type")
  return { name, mimeType, data: bytes.toString("base64"), bytes: bytes.length }
}

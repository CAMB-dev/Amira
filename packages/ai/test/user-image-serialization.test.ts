import { expect, test } from "bun:test"
import { BUILTIN_DIALECTS } from "../src/dialects/index.ts"
import type { ImageBlock, UserMessage } from "../src/types.ts"
import { req, run, sse } from "./dialect-helpers.ts"

const image: ImageBlock = { type: "image", mimeType: "image/png", data: "cG5n", name: "screen.png" }
for (const dialect of BUILTIN_DIALECTS) {
  for (const imageOnly of [true, false]) {
    test(`${dialect.id} serializes ${imageOnly ? "image-only" : "mixed text and image"} user content`, async () => {
      const message: UserMessage = {
        role: "user",
        content: imageOnly ? [image] : [{ type: "text", text: "look" }, image],
        display: { text: "[image 1: screen.png 3 B]" },
      }
      const { seen } = await run(dialect, req(dialect.id, { messages: [message] }, { images: true }), sse(""))
      const text = { type: "text", text: "look" }
      const url = "data:image/png;base64,cG5n"
      if (dialect.id === "anthropic-messages") {
        expect(seen.body.messages[0]).toEqual({
          role: "user",
          content: [
            ...(imageOnly ? [] : [text]),
            { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } },
          ],
        })
      } else if (dialect.id === "openai-chat") {
        expect(seen.body.messages[0]).toEqual({
          role: "user",
          content: [...(imageOnly ? [] : [text]), { type: "image_url", image_url: { url } }],
        })
      } else if (dialect.id === "openai-responses") {
        expect(seen.body.input[0]).toEqual({
          type: "message",
          role: "user",
          content: [
            ...(imageOnly ? [] : [{ type: "input_text", text: "look" }]),
            { type: "input_image", image_url: url, detail: "auto" },
          ],
        })
      } else {
        expect(seen.body.contents[0]).toEqual({
          role: "user",
          parts: [
            ...(imageOnly ? [] : [{ text: "look" }]),
            { inlineData: { mimeType: "image/png", data: image.data } },
          ],
        })
      }
      expect(JSON.stringify(seen.body)).not.toContain("screen.png")
      expect(JSON.stringify(seen.body)).not.toContain("[image 1:")
    })
  }
}

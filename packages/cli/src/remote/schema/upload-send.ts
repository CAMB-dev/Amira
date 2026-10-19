import { array, bool, constrain, enumeration, object, type SchemaType, text, union } from "./base.ts"
import { acknowledgement } from "./frontend.ts"
import { display, textBlock } from "./messages.ts"

const message = object({
  role: enumeration("user"),
  content: constrain(
    array(
      union(
        textBlock,
        object({
          type: enumeration("attachment"),
          attachmentId: constrain(text, { minLength: 1, maxLength: 128 }),
        }),
      ),
    ),
    { maxItems: 1024 },
  ),
  "display?": display,
})
export const uploadSendSchema = {
  params: union(
    object({ operation: enumeration("turn.prompt"), message, "turnId?": text, "expectedHoldId?": text }),
    object({
      operation: enumeration("turn.steer"),
      message,
      "turnId?": text,
      "expectedTurnId?": text,
      "expectedHoldId?": text,
      "expectedIdle?": bool,
    }),
  ),
  result: acknowledgement,
}
export interface ServerUploadSendOperations {
  "uploads.send": {
    params: SchemaType<typeof uploadSendSchema.params>
    result: SchemaType<typeof uploadSendSchema.result>
  }
}

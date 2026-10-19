import type { UserMessage } from "@amira/api"
import { type FrontendExecuteOptions, FrontendOperationError, type FrontendOperations } from "@amira/core"
import type { ServerUploadSendOperations } from "../remote/schema/upload-send.ts"
import type { createServerUploadOperations } from "./uploads.ts"

type Send = "turn.prompt" | "turn.steer"
export function createUploadSender(deps: {
  uploads: ReturnType<typeof createServerUploadOperations>
  send?: (
    operation: Send,
    params: FrontendOperations[Send]["params"],
    options?: FrontendExecuteOptions,
  ) => Promise<{ sessionGeneration: number }>
}) {
  return async (
    params: ServerUploadSendOperations["uploads.send"]["params"],
    options?: FrontendExecuteOptions,
  ) => {
    if (!deps.send)
      throw new FrontendOperationError("unsupported_operation", "Image submission is unavailable")
    const ids = params.message.content.flatMap((block) =>
      block.type === "attachment" ? [block.attachmentId] : [],
    )
    const prepared = deps.uploads.prepare(ids, options)
    let image = 0
    const message: UserMessage = {
      ...params.message,
      content: params.message.content.map((block) =>
        block.type === "attachment" ? prepared.images[image++]! : block,
      ),
    }
    const { operation, ...submission } = params
    try {
      prepared.check()
      const ack = await deps.send(operation, { ...submission, message }, options)
      prepared.commit()
      return ack
    } finally {
      prepared.rollback()
    }
  }
}

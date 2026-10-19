import type { FrontendExecuteOptions } from "@amira/core"
import { FileIndex, type FileIndexOptions, type FileSource } from "../../../tui/src/file-index.ts"
import type { ServerFileOperations } from "../server/files.ts"

/** Implemented by the negotiated remote port; authority/epoch never come from a path. */
export interface RemoteFileClient {
  readonly sessionGeneration: number
  request<K extends keyof ServerFileOperations>(
    operation: K,
    params: ServerFileOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<ServerFileOperations[K]["result"]>
}

/** FileIndex retains the local picker's incremental search/directory/TTL behavior, but no IO. */
export function createRemoteFileSource(
  client: RemoteFileClient,
  scope?: string,
  options: Pick<FileIndexOptions, "limit" | "ttlMs"> = {},
): FileSource {
  return new FileIndex("", {
    ...options,
    list: async (_cwd, emit, signal) => {
      const sessionGeneration = client.sessionGeneration
      const executeOptions = { sessionGeneration, signal }
      const scoped = scope === undefined ? {} : { scope }
      let generation: string | undefined
      let cursor: string | undefined
      let complete = false
      const cursors = new Set<string>()
      const current = () => !signal.aborted && client.sessionGeneration === sessionGeneration
      try {
        do {
          const page = cursor
            ? await client.request("files.list", { ...scoped, cursor, limit: 100 }, executeOptions)
            : await client.request("files.refresh", { ...scoped, limit: 100 }, executeOptions)
          if (!current()) return false
          if (generation && page.generation !== generation) return false
          generation = page.generation
          emit(page.entries)
          cursor = page.nextCursor
          if (cursor && (cursors.has(cursor) || cursors.size >= 2500)) return false
          if (cursor) cursors.add(cursor)
          if (!cursor) {
            complete = true
            return !page.partial
          }
        } while (current())
        return false
      } finally {
        if (!complete && generation && client.sessionGeneration === sessionGeneration) {
          // Cancellation itself needs a live signal; a disposed picker cannot cancel its successor.
          void client
            .request("files.cancel", { ...scoped, generation }, { sessionGeneration })
            .catch(() => {})
        }
      }
    },
  })
}

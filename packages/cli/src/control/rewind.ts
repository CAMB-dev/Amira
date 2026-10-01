import type { SessionControl } from "@amira/api"
import { FILE_REWIND_COVERAGE, FileRewindConflictError } from "@amira/core"
import type { ControlContext } from "./context.ts"

type RewindControl = Pick<SessionControl, "planRewind" | "pruneFileHistory" | "rewind">

export function createRewindControl(ctx: ControlContext): RewindControl {
  return {
    planRewind: (index) => {
      const { a, entry } = ctx.rewindEntry(index)
      const owner = ctx.session.host.fileRestoration
      return owner
        ? {
            owner: owner.label,
            enabled: true,
            restored: 0,
            removed: 0,
            conflicts: [],
            note: `File restoration is managed by ${owner.source}. The core will not restore files.`,
          }
        : (a.fileRewind?.plan(entry.id) ?? {
            owner: "core",
            enabled: false,
            restored: 0,
            removed: 0,
            conflicts: [],
            note: `Files will not be restored. ${FILE_REWIND_COVERAGE}`,
          })
    },
    pruneFileHistory: () => {
      ctx.idle("prune file history")
      ctx.idleFiles()
      if (!ctx.agent().fileRewind) throw new Error("this session has no file history")
      return ctx.agent().fileRewind!.prune()
    },
    rewind: async (index, options) => {
      ctx.idle("rewind the conversation")
      ctx.idleFiles()
      const { a, store, entry } = ctx.rewindEntry(index)
      const owner = ctx.session.host.fileRestoration
      const restore = options?.restoreFiles !== false
      const interrupted = a.fileRewind?.interrupted()
      if (interrupted) {
        // Never two restores: finish the started one, or give it up only once it cannot finish.
        const stuck = interrupted.conflicts.length > 0 || interrupted.failure !== undefined
        if (!stuck && (!restore || owner || interrupted.messageId !== entry.id))
          throw new Error(
            `Finish the interrupted core file restore first: rewind with files to the message it was started for${owner ? ` (unload ${owner.source} first; it would restore instead)` : ""}`,
          )
        if (interrupted.conflicts.length && restore) throw new FileRewindConflictError(interrupted.conflicts)
        if (stuck && restore && (owner || interrupted.messageId !== entry.id))
          throw new Error(
            `The interrupted core file restore failed (${interrupted.failure ?? "conflicts"}); retry it with files to the same message, or rewind the conversation only to abandon it`,
          )
        if (!restore) a.fileRewind!.abandon()
      }
      if (restore && owner) {
        await a.hold("file restore", async () => {
          await owner.restore(index)
          // Inputs queued during the hold belong to the discarded conversation; do not wake it.
          a.abort()
          store.append({ type: "checkout", target: entry.parentId })
          await ctx.switchTo(store.id, () => ctx.session.resume(store, a.model), "resume")
        })
        return
      } else if (restore && a.fileRewind?.plan(entry.id).enabled) {
        a.fileRewind.restore(entry.id, entry.parentId)
        await ctx.switchTo(store.id, () => ctx.session.resume(store, a.model), "resume")
        return
      }
      // Nothing came before it: back to an empty conversation, still in this session.
      store.append({ type: "checkout", target: entry.parentId })
      await ctx.switchTo(store.id, () => ctx.session.resume(store, a.model), "resume")
    },
  }
}

import type { ServerToolBlock } from "@amira/ai"
import type { EventMap } from "@amira/api"
import { serverToolCall } from "../server-tools.ts"
import { modelErrorNotice } from "../transcript.ts"
import type { TranscriptView } from "../view.ts"

/** A failed turn's next step stays visible; provider details remain folded. */
export function turnFailureNotice(view: Pick<TranscriptView, "notice">, end: EventMap["turn.end"]) {
  const failure = end.failure
  if (!failure) return view.notice("error", modelErrorNotice(end.error))
  view.notice(
    "error",
    failure.hint ? `${failure.summary}\n${failure.hint}` : modelErrorNotice(failure.summary),
    failure.detail,
  )
}

/** Provider-hosted search rows end once, including calls left running at message.end. */
export function createServerRows(
  view: TranscriptView,
  deps: {
    interrupted: () => boolean
    output: () => void
    started: () => void
  },
) {
  const rows = new Map<string, { startedAt: number; ended: boolean }>()
  return {
    clear: () => rows.clear(),
    show(block: ServerToolBlock, final = false) {
      const call = serverToolCall(block)
      let row = rows.get(block.id)
      if (row?.ended) return
      if (!row) {
        if (final && block.status === "running") return
        row = { startedAt: Date.now(), ended: false }
        rows.set(block.id, row)
        if (view.replyEnd([])) deps.output()
        deps.started()
      }
      view.toolStart(block.id, call.name, call.args, row.startedAt)
      if (block.status === "running" && !final) return
      row.ended = true
      if (
        view.toolEnd(block.id, {
          result: call.result,
          durationMs: Date.now() - row.startedAt,
          interrupted: deps.interrupted(),
          ...(call.rejected ? { rejected: call.rejected } : {}),
        })
      )
        deps.output()
    },
  }
}

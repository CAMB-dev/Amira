import type { FileRewindPlan, SessionControl, UserMessage } from "@amira/api"
import type { Agent, CommandHost } from "@amira/core"
import type { Editor, EditorPart } from "@amira/tui-kit"
import { Dialog, type DialogRequest } from "../dialog.ts"
import { userText } from "../format.ts"
import type { Keybindings } from "../keybindings.ts"
import type { TranscriptView } from "../view.ts"
import { messageParts, messageText, oneLine } from "./outbox.ts"
import { REWIND_ID } from "./startup.ts"

interface RewindPick {
  m: UserMessage
  index: number
}

type RewindMode = { fork: true } | { restoreFiles: boolean; plan?: FileRewindPlan }

export interface RewindFlowDeps {
  /** The active session; commands such as /resume can replace it while the UI is open. */
  agent: () => Agent
  commands?: Pick<CommandHost, "control">
  dialogs: Dialog[]
  keys: Keybindings
  editor: Editor
  sentParts: ReadonlyMap<string, EditorPart[]>
  working: () => boolean
  compacting: () => boolean
  showNote: (text: string) => void
  view: Pick<TranscriptView, "notice" | "requestRender">
  redraw: () => void
}

/** The TUI's rewind picker, including optional file restoration and its notices. */
export class RewindFlow {
  constructor(private readonly deps: RewindFlowDeps) {}

  /**
   * The rewind picker: the user's messages, newest first. Picking one cuts the conversation
   * back to just before it and puts it in the editor to change and send again. The second
   * choice previews file restoration, including the host's coverage and conflicts.
   */
  openRewind(): boolean {
    const { commands, dialogs, keys, view } = this.deps
    const control = commands?.control
    if (
      !control?.rewind ||
      this.deps.working() ||
      this.deps.compacting() ||
      dialogs.some((d) => d.request.requestId.startsWith(REWIND_ID))
    )
      return false
    const picks = this.deps
      .agent()
      .messages.map((m, index) => ({ m, index }))
      .filter((p): p is RewindPick => p.m.role === "user" && !p.m.display?.origin)
      .reverse()
    if (!picks.length) {
      this.deps.showNote("Nothing to rewind to yet")
      return true
    }
    const labels = picks.map((p, i) => `${i + 1}. ${oneLine(messageText(p.m))}`)
    const request: Extract<DialogRequest, { kind: "select" }> = {
      kind: "select",
      requestId: `${REWIND_ID}${Date.now()}`,
      title: "Rewind the conversation to before which message?",
      options: labels,
      ...(control.fork
        ? { sections: [{ at: 0, choose: "rewind", keys: [{ key: "f", label: "fork from here" }] }] }
        : {}),
    }
    const dialog: Dialog = new Dialog(
      request,
      (answer) => {
        const i = dialogs.indexOf(dialog)
        if (i !== -1) dialogs.splice(i, 1)
        const label =
          typeof answer === "string"
            ? answer
            : answer && typeof answer === "object" && "option" in answer
              ? answer.option
              : undefined
        const fork = answer && typeof answer === "object" && "key" in answer && answer.key === "f"
        const at = label ? labels.indexOf(label) : -1
        if (at !== -1) {
          if (fork) void this.rewindTo(control, picks[at]!, { fork: true })
          else this.chooseFileRewind(control, picks[at]!)
        }
        view.requestRender()
      },
      keys,
    )
    dialogs.unshift(dialog)
    view.requestRender()
    return true
  }

  private chooseFileRewind(control: SessionControl, pick: RewindPick) {
    const { dialogs, keys, view } = this.deps
    if (!control.planRewind) {
      void this.rewindTo(control, pick, { restoreFiles: false })
      return
    }
    let plan: FileRewindPlan
    try {
      plan = control.planRewind(pick.index)
    } catch (error) {
      view.notice("warning", `Cannot rewind: ${(error as Error).message}`)
      view.requestRender()
      return
    }
    if (plan.conflicts.length) view.notice("warning", `File restore conflicts:\n${plan.conflicts.join("\n")}`)
    const restore =
      plan.owner === "core"
        ? `Restore files too (${plan.restored} restored, ${plan.removed} removed)`
        : plan.owner
    const canRestore = plan.enabled && (plan.owner !== "core" || plan.restored + plan.removed > 0)
    const options = [...(canRestore ? [restore] : []), "Conversation only"]
    const dialog: Dialog = new Dialog(
      {
        kind: "select",
        requestId: `${REWIND_ID}files-${Date.now()}`,
        title: canRestore ? "Restore files too?" : "Rewind conversation; files will not be restored",
        options,
        descriptions: options.map((option) =>
          option === restore
            ? `${plan.conflicts.length ? "Conflicts must be resolved first. " : ""}${plan.note}`
            : `Files will not be restored. ${plan.note}`,
        ),
      },
      (answer) => {
        const at = dialogs.indexOf(dialog)
        if (at !== -1) dialogs.splice(at, 1)
        if (typeof answer === "string")
          void this.rewindTo(control, pick, { restoreFiles: canRestore && answer === restore, plan })
        view.requestRender()
      },
      keys,
    )
    dialogs.unshift(dialog)
    view.requestRender()
  }

  private async rewindTo(control: SessionControl, pick: RewindPick, mode: RewindMode) {
    const text = messageText(pick.m)
    try {
      if ("fork" in mode) await control.fork!(pick.index)
      else await control.rewind!(pick.index, { restoreFiles: mode.restoreFiles })
    } catch (err) {
      this.deps.view.notice("warning", `Cannot rewind: ${err instanceof Error ? err.message : String(err)}`)
      this.deps.view.requestRender()
      return
    }
    const back = pick.m.content.some((b) => b.type === "image")
      ? messageParts(pick.m)
      : (this.deps.sentParts.get(userText(pick.m)) ?? [text])
    this.deps.editor.setParts(
      this.deps.editor.isEmpty ? back : [...back, "\n\n", ...this.deps.editor.getParts()],
    )
    this.deps.view.notice(
      "info",
      "fork" in mode
        ? "Forked the conversation to before that message, now back in the input."
        : `Rewound the conversation to before that message, now back in the input. ${
            mode.restoreFiles && mode.plan
              ? mode.plan.owner === "core"
                ? `Restored ${mode.plan.restored} file${mode.plan.restored === 1 ? "" : "s"}; removed ${mode.plan.removed} file${mode.plan.removed === 1 ? "" : "s"}.`
                : `${mode.plan.owner} completed.`
              : "Files were not restored."
          }${mode.plan ? ` ${mode.plan.note}` : ""}`,
    )
    this.deps.redraw()
  }
}

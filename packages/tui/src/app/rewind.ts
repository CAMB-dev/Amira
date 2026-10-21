// Owns rewind and fork picking, optional file restoration and draft recovery.
import type { FileRewindPlan, SessionControl, UserMessage } from "@amira/api"
import { type Agent, type AgentPort, type CommandHost, frontendIdentity } from "@amira/core"
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

type RewindControl = Pick<SessionControl, "fork" | "rewind"> & {
  planRewind?: (index: number) => FileRewindPlan | Promise<FileRewindPlan>
}

type RewindMode = { fork: true } | { restoreFiles: boolean; plan?: FileRewindPlan }

export interface RewindFlowDeps {
  /** The active session; commands such as /resume can replace it while the UI is open. */
  agent: () => Agent | undefined
  commands?: Pick<CommandHost, "control">
  port?: AgentPort
  dialogs: Dialog[]
  keys: Keybindings
  editor: Pick<Editor, "getParts" | "setParts" | "isEmpty">
  /** Main-local dialogs may be deferred while another conversation owns input. */
  onMain?: (run: () => boolean) => boolean
  /** Captures the root session, invalidating continuations after unrelated session replacement. */
  current?: () => () => boolean
  /** Identifies switches originating in this control call, including its async continuations. */
  runOperation?: (current: () => boolean, run: () => Promise<void>) => Promise<void>
  sentParts: ReadonlyMap<string, EditorPart[]>
  working: () => boolean
  compacting: () => boolean
  showNote: (text: string) => void
  view: Pick<TranscriptView, "notice" | "requestRender">
  redraw: () => void
  waitingChanged: (change: "opened" | "resolved") => void
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
    const current = this.deps.current?.() ?? (() => true)
    const run = () => this.showRewind(current)
    return this.deps.onMain ? this.deps.onMain(run) : run()
  }

  private showRewind(current: () => boolean): boolean {
    if (!current()) return false
    const { commands, dialogs, keys, view } = this.deps
    const port = this.deps.port
    const snapshot = port?.snapshot
    const identity = port ? frontendIdentity(port) : undefined
    if (
      snapshot &&
      identity &&
      (snapshot.sessionGeneration !== identity.sessionGeneration ||
        snapshot.state.sessionId !== identity.sessionId)
    )
      return false
    // These indices belong to the displayed transcript, not merely the current authority.
    const sessionGeneration = snapshot?.sessionGeneration
    const control: RewindControl | undefined = port
      ? {
          fork:
            commands && !commands.control.fork
              ? undefined
              : async (index) => {
                  await port.execute("session.fork", { index: index! }, { sessionGeneration })
                },
          rewind:
            commands && !commands.control.rewind
              ? undefined
              : async (index, options) => {
                  await port.execute(
                    "session.rewind",
                    { index, restoreFiles: options?.restoreFiles },
                    { sessionGeneration },
                  )
                },
          planRewind:
            commands && !commands.control.planRewind
              ? undefined
              : (index) => port.execute("session.planRewind", { index }, { sessionGeneration }),
        }
      : commands?.control
    if (
      !control?.rewind ||
      this.deps.working() ||
      this.deps.compacting() ||
      dialogs.some((d) => d.request.requestId.startsWith(REWIND_ID))
    )
      return false
    const messages = snapshot
      ? snapshot.transcript.messages.map((entry) => entry.message)
      : (this.deps.agent()?.messages ?? [])
    const picks = messages
      .map((m, index) => ({ m, index }))
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
        this.deps.waitingChanged("resolved")
        const label =
          typeof answer === "string"
            ? answer
            : answer && typeof answer === "object" && "option" in answer
              ? answer.option
              : undefined
        const fork = answer && typeof answer === "object" && "key" in answer && answer.key === "f"
        const at = label ? labels.indexOf(label) : -1
        if (at !== -1) {
          if (fork) void this.rewindTo(control, picks[at]!, { fork: true }, current)
          else this.chooseFileRewind(control, picks[at]!, current)
        }
        view.requestRender()
      },
      keys,
    )
    dialogs.unshift(dialog)
    this.deps.waitingChanged("opened")
    view.requestRender()
    return true
  }

  private chooseFileRewind(control: RewindControl, pick: RewindPick, current: () => boolean) {
    if (!current()) return
    const run = () => this.showFileRewind(control, pick, current)
    if (this.deps.onMain) this.deps.onMain(run)
    else run()
  }

  private showFileRewind(control: RewindControl, pick: RewindPick, current: () => boolean): boolean {
    if (!current()) return false
    if (!control.planRewind) {
      void this.rewindTo(control, pick, { restoreFiles: false }, current)
      return true
    }
    void this.planFileRewind(control, pick, current)
    return true
  }

  private async planFileRewind(control: RewindControl, pick: RewindPick, current: () => boolean) {
    const { view, port } = this.deps
    const generation = port ? frontendIdentity(port).sessionGeneration : undefined
    const valid = () => current() && (!port || frontendIdentity(port).sessionGeneration === generation)
    let plan: FileRewindPlan
    try {
      plan = await control.planRewind!(pick.index)
    } catch (error) {
      if (!valid()) return
      view.notice("warning", `Cannot rewind: ${error instanceof Error ? error.message : String(error)}`)
      view.requestRender()
      return
    }
    if (!valid()) return
    const run = () => valid() && this.confirmFileRewind(control, pick, plan, current)
    if (this.deps.onMain) this.deps.onMain(run)
    else run()
  }

  private confirmFileRewind(
    control: RewindControl,
    pick: RewindPick,
    plan: FileRewindPlan,
    current: () => boolean,
  ): boolean {
    if (!current()) return false
    const { dialogs, keys, view } = this.deps
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
        this.deps.waitingChanged("resolved")
        if (typeof answer === "string")
          void this.rewindTo(control, pick, { restoreFiles: canRestore && answer === restore, plan }, current)
        view.requestRender()
      },
      keys,
    )
    dialogs.unshift(dialog)
    this.deps.waitingChanged("opened")
    view.requestRender()
    return true
  }

  private rewindTo(control: RewindControl, pick: RewindPick, mode: RewindMode, current: () => boolean) {
    if (!current()) return
    const run = () => {
      void this.performRewind(control, pick, mode, current)
      return true
    }
    if (this.deps.onMain) this.deps.onMain(run)
    else run()
  }

  private async performRewind(
    control: RewindControl,
    pick: RewindPick,
    mode: RewindMode,
    current: () => boolean,
  ) {
    if (!current()) return
    const text = messageText(pick.m)
    try {
      const run = () =>
        "fork" in mode
          ? control.fork!(pick.index)
          : control.rewind!(pick.index, { restoreFiles: mode.restoreFiles })
      if (this.deps.runOperation) await this.deps.runOperation(current, run)
      else await run()
    } catch (err) {
      if (!current()) return
      this.deps.view.notice("warning", `Cannot rewind: ${err instanceof Error ? err.message : String(err)}`)
      this.deps.view.requestRender()
      return
    }
    if (!current()) return
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

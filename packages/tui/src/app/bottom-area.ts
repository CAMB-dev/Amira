// Owns bottom-area layout: panels, activity, pending messages, input, status and hints.
import type { Agent, PanelRegistry, StatusRegistry } from "@amira/core"
import {
  bold,
  type Component,
  type Editor,
  type RenderContext,
  type Spinner,
  Stack,
  type Theme,
  truncateToWidth,
} from "@amira/tui-kit"
import type { CommandPopup } from "../command-popup.ts"
import type { Dialog } from "../dialog.ts"
import { renderToolLines } from "../diff-view.ts"
import type { FilePicker } from "../file-picker.ts"
import { glyphs } from "../glyphs.ts"
import { fitHint } from "../hint.ts"
import type { HistorySearch } from "../history-search.ts"
import { InputBox } from "../input-box.ts"
import { type Keybindings, type KeySpec, keyLabel } from "../keybindings.ts"
import { type StatusEntry, statusLine } from "../status-bar.ts"
import { type TranscriptView, View } from "../view.ts"
import type { TurnActivity } from "./activity.ts"
import { type NoticeStrip, type Outgoing, otherWay, pendingMessageRows, type WhileWorking } from "./outbox.ts"

/** The items of a hint line, most useful ones with the highest priority. */
type HintItems = Parameters<typeof fitHint>[0]

/** The input box, its hint and list, the status, live panels and pending messages under the transcript. */
export interface BottomArea {
  layout(width: number, ctx: RenderContext, budget: number, top?: Component): string[]
  readonly panelsShown: boolean
  togglePanels(): void
}

/** The functions are read at draw time, never once: the agent is replaced on a session switch. */
export interface BottomAreaDeps {
  agent: () => Agent
  activity: () => TurnActivity
  view: () => Pick<TranscriptView, "runningTools" | "capturing">
  noticeStrip: () => NoticeStrip
  dialogs: () => readonly Dialog[]
  steering: () => readonly string[]
  queued: () => readonly Outgoing[]
  mode: () => "fullscreen" | "inline"
  hintNote: () => { text: string; until: number } | undefined
  hasCancellable: () => boolean
  canRewind: () => boolean
  status: StatusRegistry
  header?: (width: number, ctx: RenderContext) => string[]
  panels?: PanelRegistry
  editor: Editor
  keys: Keybindings
  reaches: (spec: KeySpec) => boolean
  enterDoes: WhileWorking
  spinner: Spinner
  search: HistorySearch
  popups: CommandPopup[]
  filePicker: FilePicker
}

export function createBottomArea(deps: BottomAreaDeps): BottomArea {
  const { editor, keys, reaches, enterDoes, spinner, search, popups, filePicker } = deps
  /** The list shown below the input box, if any, with its key hint. */
  const inputList = ():
    | { lines: (width: number, ctx: RenderContext) => string[]; hint: () => HintItems }
    | undefined => {
    if (search.active) return { lines: (w, ctx) => search.render(w, ctx), hint: searchHint }
    const popup = popups.find((p) => p.visible)
    if (popup) return { lines: (w, ctx) => popup.render(w, ctx), hint: popupHint }
    if (filePicker.visible) return { lines: (w, ctx) => filePicker.render(w, ctx), hint: fileHint }
    return undefined
  }
  const newlineKey = keys.label("newline", reaches)
  const queueKey = keys.label("queue")
  /**
   * Extension status items and the right-aligned model/effort/mode label. Header facts
   * and the running turn's rate stay out of the border, so each is shown only once.
   */
  const statusItems = (): StatusEntry[] => {
    const agent = deps.agent()
    const items = deps.status
      .snapshot()
      .filter((i) => !["context", "cost", "place", "token-speed"].includes(i.id))
    const model = items.find((i) => i.id === "model")
    const thinking = agent.thinking.state(agent.model).thinking
    const fallback = agent.model.provider
      ? `${agent.model.id}${thinking ? ` (${thinking})` : ""}`
      : "(no model)"
    return [
      ...items.filter((i) => i.id !== "model"),
      {
        id: "model",
        align: "right",
        tone: model?.tone ?? "accent",
        priority: model?.priority ?? 40,
        text: `${model?.text ?? fallback} ${glyphs.separator} ${agent.permissions.mode}`,
      },
    ]
  }
  const inputBox = new InputBox(editor, statusItems)
  /** Rows the last frame's dialog took, to size it against the rest of the bottom area. */
  let dialogRows = 0
  /** The user folded the live panels to one line each (panels.toggle). */
  let panelsCollapsed = false
  /** Whether the last frame showed a panel: only then does the fold key act. */
  let panelsShown = false
  /** Rows the panels may take this frame, their blank line included; layoutBottom sets it. */
  let panelRoom = Number.POSITIVE_INFINITY
  /** Rows the last frame's panels took. */
  let panelRows = 0
  /** The most rows the list below the input had since it opened (full screen keeps them). */
  let listRows = 0

  /** The panels' rows; unfolded, a blank row sets each panel apart from the one before. */
  const panelLines = (width: number, ctx: RenderContext, collapsed: boolean) =>
    (deps.panels?.size
      ? deps.panels.snapshot({
          width,
          now: Date.now(),
          sessionId: deps.agent().sessionId,
          data: deps.agent().data,
          collapsed,
        })
      : []
    )
      .map((p) => renderToolLines(p.lines, ctx.theme, width))
      .filter((rows) => rows.length > 0)
      .flatMap((rows, i) => (i > 0 && !collapsed ? ["", ...rows] : rows))

  const bottom = new Stack([
    new View((width, ctx) => (deps.mode() === "inline" ? (deps.header?.(width, ctx) ?? []) : [])),
    // Live panels (e.g. a todo list): extensions supply the lines, for the session shown now.
    // They give way to everything else under the transcript: folded, then cut, when rows are short.
    new View((width, ctx) => {
      let lines = panelRoom < 2 ? [] : panelLines(width, ctx, panelsCollapsed)
      if (!panelsCollapsed && lines.length + 1 > panelRoom) lines = panelLines(width, ctx, true)
      if (lines.length + 1 > panelRoom) lines = lines.slice(0, Math.max(0, panelRoom - 1))
      panelsShown = lines.length > 0
      panelRows = panelsShown ? lines.length + 1 : 0
      return panelsShown ? [...lines, ""] : []
    }),
    new View((width, ctx) => [
      ...deps
        .noticeStrip()
        .render(ctx.theme)
        .map((l) => truncateToWidth(l, width, "…")),
      ...pendingMessageRows(
        [
          ...deps.steering().map((text) => ({ label: "steering", text })),
          ...deps.queued().map((q) => ({ label: "queued", text: q.display ?? q.text })),
        ],
        width,
        ctx.theme,
      ),
    ]),
    // The activity line: a summary of the turn (what it does now, how long it has run, the
    // tokens and live rate), lit by a travelling highlight. It shows for
    // the whole turn; running tools are counted here and named on their own rows. How to
    // interrupt stays on the row as well as the existing hint line.
    new View((width, ctx) => {
      return deps.activity().render(width, ctx, {
        running: deps.view().runningTools,
        waiting: deps.dialogs().length > 0,
        spinner,
        stop: `${keys.label("interrupt") ?? keyLabel({ name: "escape" })} stop`,
      })
    }),
    // The input box carries the status in its bottom border. A dialog takes the box's place;
    // the status then gets a line of its own under it.
    new View((width, ctx) => {
      const dialog = deps.dialogs()[0]
      if (!dialog) return inputBox.render(width, ctx)
      const lines = dialog.render(width, ctx)
      dialogRows = lines.length
      return [...lines, ...statusLine(statusItems(), width, ctx)]
    }),
    // The command or skill list, file list or history search opens below the input box, in place of
    // the hint, so the box stays where it is while the list changes with each key. Full screen,
    // the bottom area is drawn up from the screen's last row: the list keeps the most rows it had
    // since it opened (blank ones below it), so the box does not jump as it gets shorter.
    new View((width, ctx) => {
      const list = deps.dialogs()[0] ? undefined : inputList()
      if (!list) {
        listRows = 0
        return []
      }
      const rows = list.lines(width, ctx)
      if (deps.mode() === "fullscreen") {
        listRows = Math.max(listRows, rows.length)
        while (rows.length < listRows) rows.push("")
      }
      return [...rows, ctx.theme.muted(fitHint(list.hint(), width))]
    }),
    // The key hint, or a note in its place. A find bar or block selection (full screen) shows
    // its own keys above the transcript: the row stays, blank, so the layout does not jump.
    new View((width, ctx) => {
      if (deps.dialogs()[0] || inputList()) return []
      const hintNote = deps.hintNote()
      if (hintNote && Date.now() < hintNote.until) {
        return [ctx.theme.muted(truncateToWidth(hintNote.text, width, glyphs.more))]
      }
      if (deps.view().capturing) return [""]
      return [
        ` ${fitHint(inputHint(ctx.theme), Math.max(0, width - 1), ctx.theme.muted(`  ${glyphs.treePipe}  `))}`,
      ]
    }),
  ])

  /**
   * The bottom area under `top`, fitted into `budget` rows: live panels give way first (to the
   * dialog at its full size too), then the dialog is fitted into what the rest leaves.
   */
  function layoutBottom(width: number, ctx: RenderContext, budget: number, top?: Component): string[] {
    const parts = top ? [top, bottom] : [bottom]
    const draw = () => parts.flatMap((c) => c.render(width, ctx))
    const dialog = deps.dialogs()[0]
    if (dialog) dialog.maxRows = Math.max(1, budget)
    panelRoom = Number.POSITIVE_INFINITY
    let rest = draw()
    if (panelRows && rest.length > budget) {
      panelRoom = Math.max(0, budget - (rest.length - panelRows))
      rest = draw()
    }
    // The blank rows a list keeps (full screen) go before anything else: the terminal shrank,
    // or the rows above the box grew, since the list was that tall.
    if (listRows && rest.length > budget) {
      listRows = Math.max(0, listRows - (rest.length - budget))
      rest = draw()
    }
    if (dialog && rest.length > budget) {
      dialog.maxRows = Math.max(1, budget - (rest.length - dialogRows))
      rest = draw()
    }
    return rest
  }

  /**
   * The few keys that matter now, the most useful first to stay as the line narrows; the key
   * reference (the help key) lists the rest.
   */
  function inputHint(theme: Theme): HintItems {
    const item = (key: string | undefined, label: string, priority: number) =>
      key && { text: `${bold(theme.fg2(key))}${theme.muted(` ${label}`)}`, priority }
    const interruptKey = keys.label("interrupt")
    const working = deps.activity().working
    const cancellable = deps.hasCancellable() && !deps.activity().compacting
    const waiting = deps.queued().length > 0 || deps.steering().length > 0
    const stop = cancellable ? "cancel command" : waiting ? "send queued" : "stop"
    return [
      item(keys.label("permissions.mode"), "mode", 5),
      (working || cancellable || deps.activity().compacting) && item(interruptKey, stop, 6),
      item(keys.label("tool-output"), "detail", 5),
      item(keys.label("help"), "keys", 5),
      !editor.isEmpty && item(newlineKey, "newline", 1),
      (working || cancellable) && item(keys.label("submit"), working ? enterDoes : "send", 4),
      working && item(queueKey, otherWay(enterDoes), 3),
      working && deps.canRewind() && item(interruptKey && `${interruptKey} ${interruptKey}`, "rewind", 2),
      panelsCollapsed && panelsShown && item(keys.label("panels.toggle"), "unfold panels", 4),
    ]
  }

  function searchHint(): HintItems {
    const accept = keys.label("search.accept")
    const older = keys.label("search.older")
    const cancel = keys.label("search.cancel")
    return [
      accept && { text: `${accept} accept`, priority: 5 },
      older && { text: `${older} older`, priority: 3 },
      cancel && { text: `${cancel} cancel`, priority: 4 },
    ]
  }

  /** The file list takes the command popup's keys; Tab and Enter both insert. */
  function fileHint(): HintItems {
    const insert = [keys.label("popup.complete"), keys.label("popup.accept")].filter(Boolean).join("/")
    const close = keys.label("popup.close")
    // Nothing to choose yet (the project is still listed, or the query still searched).
    if (!filePicker.open) return [close && { text: `${close} close`, priority: 4 }]
    return [
      insert && { text: `${insert} insert`, priority: 5 },
      close && { text: `${close} close`, priority: 4 },
    ]
  }

  function popupHint(): HintItems {
    const complete = keys.label("popup.complete")
    const accept = keys.label("popup.accept")
    const close = keys.label("popup.close")
    // A usage line or "no command matches": nothing to pick or complete.
    if (!popups.find((p) => p.visible)?.hasCandidates)
      return [close && { text: `${close} close`, priority: 4 }]
    return [
      complete && { text: `${complete} complete`, priority: 2 },
      accept && { text: `${accept} run`, priority: 5 },
      close && { text: `${close} close`, priority: 4 },
    ]
  }

  return {
    layout: layoutBottom,
    get panelsShown() {
      return panelsShown
    },
    togglePanels() {
      panelsCollapsed = !panelsCollapsed
    },
  }
}

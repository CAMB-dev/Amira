// Owns bottom-area layout: panels, activity, pending messages, input, status and hints.
import type { Agent, PanelRegistry, StatusRegistry } from "@amira/core"
import {
  bold,
  type Editor,
  type InputEvent,
  type MouseInput,
  type RenderContext,
  type Spinner,
  type Theme,
  translateMouse,
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
import type { CommandRunner } from "./command-runner.ts"
import type { DockedView } from "./dock.ts"
import { type NoticeStrip, type Outgoing, otherWay, pendingMessageRows, type WhileWorking } from "./outbox.ts"

/** The items of a hint line, most useful ones with the highest priority. */
type HintItems = Parameters<typeof fitHint>[0]

/** The input box, its hint and list, the status, live panels and pending messages under the transcript. */
export interface BottomArea {
  layout(width: number, ctx: RenderContext, budget: number): string[]
  /** Composer beneath an extension overlay, without transcript panels or a dock. */
  overlayInput(width: number, ctx: RenderContext, budget: number): string[]
  searchHint(theme: Theme, width: number): string | undefined
  /** Content-relative pointer input, translated to the visible dialog or completion list. */
  handlePointer(event: MouseInput, completion: (event: InputEvent) => boolean): boolean
  /** Pointer input relative to the composer beneath a fullscreen extension view. */
  handleOverlayPointer(event: MouseInput, completion: (event: InputEvent) => boolean): boolean
  readonly panelsShown: boolean
  togglePanels(): void
}

/** The functions are read at draw time, never once: the agent is replaced on a session switch. */
export interface BottomAreaDeps {
  agent: () => Agent
  activity: () => TurnActivity
  /** The activity row survived the final bottom-aligned viewport budget. */
  activityVisible?: (visible: boolean, ctx: RenderContext) => void
  /** Command activity survived the same final viewport budget. */
  commandVisible?: (visible: boolean) => void
  themePreview?: () => boolean
  view: () => Pick<TranscriptView, "runningTools" | "capturing">
  noticeStrip: () => NoticeStrip
  dialogs: () => readonly Dialog[]
  askDialogVisible?: () => boolean
  steering: () => readonly string[]
  queued: () => readonly Outgoing[]
  hintNote: () => { text: string; until: number } | undefined
  commandActivity: () => Pick<CommandRunner, "spinner" | "render" | "hasCancellable">
  canRewind: () => boolean
  status: StatusRegistry
  panels?: PanelRegistry
  dock?: () => DockedView | undefined
  renderDock?: (width: number, ctx: RenderContext, available: number) => string[]
  focusHint?: (theme: Theme, width: number) => string | undefined
  conversationIndicator?: (width: number) => string | undefined
  conversationFocused?: () => boolean
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
    | { lines: (width: number, ctx: RenderContext, maxRows: number) => string[]; hint: () => HintItems }
    | undefined => {
    if (!editor.focused) return undefined
    if (search.active)
      return { lines: (w, ctx, maxRows) => (maxRows > 0 ? search.render(w, ctx) : []), hint: searchHint }
    const popup = popups.find((p) => p.visible)
    if (popup) return { lines: (w, ctx, maxRows) => popup.render(w, ctx, maxRows), hint: popupHint }
    if (filePicker.visible)
      return { lines: (w, ctx, maxRows) => filePicker.render(w, ctx, maxRows), hint: fileHint }
    return undefined
  }
  const newlineKey = keys.label("newline", reaches)
  const queueKey = keys.label("queue")
  /**
   * Extension status items and the right-aligned model/effort/mode label. Header facts
   * and the running turn's rate stay out of the border, so each is shown only once.
   */
  const statusItems = (): StatusEntry[] => {
    // Root model and permission decorations must not masquerade as the owned runtime.
    if (deps.conversationFocused?.()) return []
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
      // Requested but not supported by the current model: say so, instead of hiding the choice.
      ...(agent.fastModeApplied
        ? [{ id: "fast", align: "right", tone: "accent", priority: 40, text: "fast" } as const]
        : agent.fastMode
          ? [{ id: "fast", align: "right", tone: "muted", priority: 40, text: "fast n/a" } as const]
          : []),
    ]
  }
  const inputBox = new InputBox(editor, statusItems)
  /** Lists supply their own two-cell gutter; the frame adds two more before the text. */
  const listLines = (
    list: NonNullable<ReturnType<typeof inputList>>,
    width: number,
    ctx: RenderContext,
    maxRows: number,
  ) => {
    const inset = inputBox.framed(width) ? "  " : ""
    return list.lines(width - inset.length, ctx, maxRows).map((row) => inset + row)
  }
  /** Rows the last frame's dialog took, to size it against the rest of the bottom area. */
  let dialogRows = 0
  let composerRows = 0
  /** The user folded the live panels to one line each (panels.toggle). */
  let panelsCollapsed = false
  /** Whether the last frame showed a panel: only then does the fold key act. */
  let panelsShown = false
  /** Rows the panels may take this frame, their blank line included; layoutBottom sets it. */
  let panelRoom = Number.POSITIVE_INFINITY
  /** Command activity gives way on short screens rather than pushing the caret offscreen. */
  let commandRoom = true
  let commandRows: string[] = []
  /** Rows the last frame's panels took. */
  let panelRows = 0
  /** The most rows the list below the input had since it opened (full screen keeps them). */
  let listRows = 0
  let listRoom = Number.POSITIVE_INFINITY
  let showHint = true
  let bottomBudget = Number.POSITIVE_INFINITY
  let interactiveStart = 0
  let pointerTop = 0
  let pointerWidth = 0
  let pointerVisible = false
  let dialogInset = 0
  let listInset = 0
  let overlayListTop = 0
  let overlayListHeight = 0
  let overlayListWidth = 0
  let overlayListInset = 0

  /** The panels' rows; unfolded, a blank row sets each panel apart from the one before. */
  const panelLines = (width: number, ctx: RenderContext, collapsed: boolean) =>
    (deps.panels?.size
      ? deps.panels.snapshot({
          width,
          now: Date.now(),
          spinner: deps.commandActivity().spinner,
          sessionId: deps.agent().sessionId,
          data: deps.agent().data,
          collapsed,
        })
      : []
    )
      .map((p) => renderToolLines(p.lines, ctx.theme, width))
      .filter((rows) => rows.length > 0)
      .flatMap((rows, i) => (i > 0 && !collapsed ? ["", ...rows] : rows))

  let activityRows: string[] = []
  let dockRoom = 0
  const dock = new View((width, ctx) => deps.renderDock?.(width, ctx, dockRoom) ?? [])
  const inputRegion = new View((width, ctx) => {
    const dialog = deps.dialogs()[0]
    if (!dialog) {
      inputBox.accentFocus = deps.focusHint?.(ctx.theme, width) !== undefined
      const indicator = deps.conversationIndicator?.(width)
      const rows = [...(indicator ? [ctx.theme.accent(indicator)] : []), ...inputBox.render(width, ctx)]
      composerRows = rows.length
      return rows
    }
    const lines = dialog.render(width, ctx)
    dialogInset = deps.conversationIndicator?.(width) ? 1 : 0
    dialogRows = lines.length
    // Status is optional: leave three rows for title, selection and footer first.
    const indicator = deps.conversationIndicator?.(width)
    const note = deps.hintNote()
    const pointerHint = note && Date.now() < note.until && note.text.startsWith("Clicks go to Amira here:")
    return [
      ...(indicator ? [ctx.theme.accent(indicator)] : []),
      ...lines,
      ...(bottomBudget > 3
        ? pointerHint
          ? [ctx.theme.muted(truncateToWidth(note.text, width))]
          : statusLine(statusItems(), width, ctx)
        : []),
    ]
  })
  const bottom = [
    // Live panels (e.g. a todo list): extensions supply the lines, for the session shown now.
    // They give way to everything else under the transcript: folded, then cut, when rows are short.
    new View((width, ctx) => {
      let lines = panelRoom < 1 ? [] : panelLines(width, ctx, panelsCollapsed)
      if (!panelsCollapsed && lines.length + 1 > panelRoom) lines = panelLines(width, ctx, true)
      if (lines.length > panelRoom) lines = lines.slice(0, Math.max(0, panelRoom))
      panelsShown = lines.length > 0
      // An intact composer already separates a one-row folded panel on a short screen.
      const gap = panelsShown && lines.length < panelRoom ? [""] : []
      panelRows = panelsShown ? lines.length + gap.length : 0
      return panelsShown ? [...lines, ...gap] : []
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
      activityRows = deps.activity().render(width, ctx, {
        running: deps.view().runningTools,
        waiting: deps.dialogs().length > 0 && !deps.themePreview?.(),
        askDialogVisible: deps.askDialogVisible?.(),
        preview: deps.themePreview?.(),
        spinner,
        stop: deps.dock?.()
          ? `${keyLabel({ name: "escape" })} close dock`
          : `${keys.label("interrupt") ?? keyLabel({ name: "escape" })} stop`,
      })
      return activityRows
    }),
    // Commands have their own clock, including index loads and reloads outside a turn.
    new View((width, ctx) => {
      commandRows =
        deps.dialogs().length || !commandRoom
          ? []
          : deps
              .commandActivity()
              .render(width, ctx, deps.dock?.() ? `${keyLabel({ name: "escape" })} close dock` : undefined)
      return commandRows
    }),
    // A live dock is immediately above the input; selectable content can take keyboard focus.
    dock,
    // Both composer and dialog keep their borders intact, with shared-edge status below.
    inputRegion,
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
      const rows = listLines(list, width, ctx, listRoom)
      listRows = Math.min(listRoom, Math.max(listRows, rows.length))
      while (rows.length < listRows) rows.push("")
      const note = deps.hintNote()
      const pointerHint =
        note && Date.now() < note.until && note.text.startsWith("Clicks go to Amira here:")
          ? ctx.theme.muted(truncateToWidth(note.text, Math.max(1, width - 2)))
          : undefined
      return [
        ...rows,
        ...(showHint
          ? [
              `  ${pointerHint ?? deps.focusHint?.(ctx.theme, Math.max(1, width - 2)) ?? ctx.theme.muted(fitHint(list.hint(), Math.max(1, width - 2)))}`,
            ]
          : []),
      ]
    }),
    // The key hint, or a note in its place. A find bar or block selection (full screen) shows
    // its own keys above the transcript: the row stays, blank, so the layout does not jump.
    new View((width, ctx) => {
      if (!showHint || deps.dialogs()[0] || inputList()) return []
      const hintNote = deps.hintNote()
      if (hintNote && Date.now() < hintNote.until) {
        return [`  ${ctx.theme.muted(truncateToWidth(hintNote.text, Math.max(1, width - 2), glyphs.more))}`]
      }
      const focusHint = deps.focusHint?.(ctx.theme, Math.max(1, width - 2))
      if (focusHint) return [`  ${focusHint}`]
      if (deps.view().capturing) return [""]
      return [
        `  ${fitHint(inputHint(ctx.theme), Math.max(0, width - 2), ctx.theme.muted(`  ${glyphs.separator}  `))}`,
      ]
    }),
  ]

  /**
   * The bottom area fitted into `budget` rows: live panels give way first (to the
   * dialog at its full size too), then the dialog is fitted into what the rest leaves.
   */
  function layoutBottom(width: number, ctx: RenderContext, budget: number): string[] {
    const draw = () => {
      let afterDock = 0
      let passedDock = false
      let total = 0
      const rows = bottom.flatMap((c) => {
        const lines = c.render(width, ctx)
        if (c === inputRegion) interactiveStart = total
        total += lines.length
        if (passedDock) afterDock += lines.length
        if (c === dock) passedDock = true
        return lines
      })
      deps.dock?.()?.place(afterDock, ctx.rows)
      return rows
    }
    // First fit the ordinary bottom area, then give the dock only the rows it leaves.
    dockRoom = 0
    listRoom = Number.POSITIVE_INFINITY
    bottomBudget = budget
    showHint = budget >= (inputList() ? 3 : 2)
    inputBox.maxRows = Number.POSITIVE_INFINITY
    const dialog = deps.dialogs()[0]
    if (dialog) dialog.maxRows = Math.max(1, budget)
    panelRoom = Number.POSITIVE_INFINITY
    commandRoom = true
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
    if (rest.length > budget && commandRoom) {
      commandRoom = false
      rest = draw()
    }
    if (dialog && rest.length > budget) {
      // Title, selection and footer take precedence over optional rows above the dialog.
      dialog.maxRows = Math.max(1, Math.min(3, budget), budget - (rest.length - dialogRows))
      rest = draw()
    }
    if (!dialog && inputList() && rest.length > budget) {
      // Keep a framed editor, one selected option and its hint before optional chrome.
      const prefix = Math.min(interactiveStart, Math.max(0, budget - 6))
      inputBox.maxRows = Math.max(1, budget - prefix - (showHint ? 1 : 0) - 1)
      rest = draw()
      listRoom = Math.max(0, budget - prefix - composerRows - (showHint ? 1 : 0))
      listRows = Math.min(listRows, listRoom)
      rest = draw()
    }
    if (!dialog && !inputList() && rest.length > budget) {
      // Reserve the footer and all other bottom rows before sizing editor text.
      inputBox.maxRows = Math.max(1, budget - (rest.length - composerRows))
      rest = draw()
    }
    if (deps.dock?.()) {
      dockRoom = Math.max(0, budget - rest.length)
      rest = draw()
      if (deps.dock?.()?.finishLayout()) rest = draw()
    }
    // Only optional rows above the interactive region may be clipped. Never choose
    // editor/options/hints by tail slicing the whole bottom area.
    const essential = rest.slice(interactiveStart)
    const prefixRoom = Math.max(0, budget - essential.length)
    const visible =
      budget > 0
        ? [...rest.slice(Math.max(0, interactiveStart - prefixRoom), interactiveStart), ...essential]
        : []
    pointerTop = ctx.rows - (rest.length - interactiveStart)
    pointerWidth = width
    pointerVisible = budget > 0
    listInset = inputBox.framed(width) ? 2 : 0
    deps.activityVisible?.(budget > 0 && activityRows.some((row) => visible.includes(row)), ctx)
    deps.commandVisible?.(budget > 0 && commandRows.some((row) => visible.includes(row)))
    return visible
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
    if (deps.conversationFocused?.())
      return [
        item(keys.label("view.focus"), "main", 6),
        (working || editor.isEmpty) && item(interruptKey, working ? "stop" : "main", 6),
        item(keys.label("tool-output"), "detail", 5),
        item(keys.label("help"), "keys", 5),
        !editor.isEmpty && item(newlineKey, "newline", 1),
      ]
    const cancellable = deps.commandActivity().hasCancellable() && !deps.activity().compacting
    const waiting = deps.queued().length > 0 || deps.steering().length > 0
    const stop = cancellable ? "cancel command" : waiting ? "send queued" : "stop"
    return [
      item(keys.label("permissions.mode"), "mode", 5),
      deps.dock?.()
        ? item(keyLabel({ name: "escape" }), "close dock", 6)
        : (working || cancellable || deps.activity().compacting) && item(interruptKey, stop, 6),
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
    handlePointer(event, completion) {
      if (!pointerVisible) return false
      const dialog = deps.dialogs()[0]
      if (dialog) {
        const top = pointerTop + dialogInset
        if (
          event.action === "wheel" &&
          (event.x < 0 || event.x >= pointerWidth || event.y < top || event.y >= top + dialogRows)
        )
          return false
        dialog.handleInput(translateMouse(event, 0, top))
        return true
      }
      if (!inputList() || search.active) return false
      const top = pointerTop + composerRows
      const inside =
        event.x >= listInset && event.x < pointerWidth && event.y >= top && event.y < top + listRows
      if (event.action !== "wheel" || inside) completion(translateMouse(event, listInset, top))
      // An open picker owns clicks, including outside clicks; wheel elsewhere still scrolls the transcript.
      return event.action !== "wheel" || (event.y >= top && event.y < top + listRows)
    },
    handleOverlayPointer(event, completion) {
      if (!overlayListHeight || !inputList() || search.active) return false
      const inside =
        event.x >= overlayListInset &&
        event.x < overlayListWidth &&
        event.y >= overlayListTop &&
        event.y < overlayListTop + overlayListHeight
      if (event.action !== "wheel" || inside)
        completion(translateMouse(event, overlayListInset, overlayListTop))
      return inside
    },
    searchHint: (theme, width) => (search.active ? theme.muted(fitHint(searchHint(), width)) : undefined),
    overlayInput(width, ctx, budget) {
      const list = inputList()
      inputBox.accentFocus = true
      inputBox.maxRows = Math.max(1, budget - (list ? 1 : 0))
      const rows = inputBox.render(width, ctx)
      overlayListTop = rows.length
      overlayListWidth = width
      overlayListInset = inputBox.framed(width) ? 2 : 0
      const choices = list ? listLines(list, width, ctx, Math.max(0, budget - rows.length)) : []
      overlayListHeight = choices.length
      rows.push(...choices)
      return rows
    },
    get panelsShown() {
      return panelsShown
    },
    togglePanels() {
      panelsCollapsed = !panelsCollapsed
    },
  }
}

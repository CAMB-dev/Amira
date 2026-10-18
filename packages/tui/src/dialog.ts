import { type AskAnswer, type ConfirmAnswer, type EventMap, type SelectChoice, sectionOf } from "@amira/api"
import { rankMatches, sessionSnippet } from "@amira/core"
import {
  bold,
  type Component,
  Editor,
  type InputEvent,
  key,
  LineInput,
  type MouseInput,
  type RenderContext,
  Spinner,
  stripAnsi,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import {
  cutEnd,
  cutMiddle,
  type DialogHints,
  DialogTargets,
  fitTitle,
  renderDialogInput,
} from "./dialog-render.ts"
import { parseUnifiedDiff, renderToolLines } from "./diff-view.ts"
import { styledExtensionLabel } from "./extension-status.ts"
import { glyphs } from "./glyphs.ts"
import type { HintItem } from "./hint.ts"
import { type Action, defaultKeybindings, type Keybindings, keyLabel } from "./keybindings.ts"
import { styledStatusBadge } from "./status-badge.ts"

export type DialogRequest = Exclude<EventMap["ui.request"], { kind: "form" | "extension-settings" }>

/** How a dialog was answered; undefined cancels it. */
export type DialogAnswer = string | ConfirmAnswer | AskAnswer[] | SelectChoice | undefined

/** Options of a list shown at once; longer lists scroll with the selection. */
const MAX_OPTIONS = 10

/** The marker gutter used by committed answered-question rows. */
const BAR_WIDTH = 2

/** The labels of a confirm's choices, which its echo repeats. */
export const CONFIRM_LABELS = {
  yes: "Yes",
  always: "Yes, and don't ask again this session",
  no: "No",
} as const

const otherLabel = () => `Other${glyphs.more}`

/** The "don't ask again" choice, saying how far it reaches when the asker says so. */
const alwaysLabel = (always: boolean | string) =>
  typeof always === "string" && always.trim()
    ? `Yes, and don't ask again ${always.trim()}`
    : CONFIRM_LABELS.always

/** One choice of a list: what it reads and what choosing it answers. */
interface Choice {
  label: string
  description?: string
  /** The answer of a confirm's or a list's choice; an ask's choices answer with their label. */
  value?: DialogAnswer
  /** The free-text choice: choosing it opens a text field in its row. */
  other?: boolean
  /** A select's option: its place in the request's options, which its section goes by. */
  index?: number
}

/** One question of the dialog: a confirm, a list, or one of an ask's questions. */
interface Page {
  question: string
  header?: string
  choices: Choice[]
  multi: boolean
  /** The selected choice; -1 while a confirm waits for the user to pick one (nothing preselected). */
  selected: number
  /** Checked choices of a multi-select, by index. */
  checked: Set<number>
  /** The text last typed for the free-text choice. */
  other?: string
  answer?: AskAnswer
}

/** How much of a dialog is shown, given back row by row when the rows run short. */
interface Fit {
  blanks: number
  /** Option descriptions on the label's row, cut to fit, rather than wrapped under it. */
  inlineDescriptions: boolean
  message: number
  options: number
  title: number
  indicator: boolean
  /** The "3/12" row under options that scroll. */
  position: boolean
  /** Section headings give way before selected options and the footer. */
  headings: boolean
}

/**
 * The one component for every question the user answers inline (ui.request): a confirm, a
 * select (typing filters it), a diff review, an input (plain or secret) and the questions of
 * ask_user. It has a rounded frame: the title, a muted message or diff, the
 * options as a list (› marks the selected one; digits choose in short lists; a multi-select
 * checks them with Space), and the keys at the bottom. A select's sections put a heading over
 * their options and add keys of their own, shown while one of them is selected; once a filter
 * is typed, every key goes to it. A confirm starts with nothing selected: Enter does nothing
 * until the user has moved to a choice, so keys typed before it showed up (a message being
 * written) cannot answer it. A free-text choice ("Other…") opens a text field in its row,
 * which Esc closes again; Esc elsewhere cancels. Several questions are asked one after another
 * in the same block and answered together. Calls `onDone` once. It fits `maxRows`: the title,
 * the selected option and the keys always show, given three rows.
 */
export class Dialog implements Component {
  /** Rows the dialog may take; set by the app before each render. */
  maxRows = Number.POSITIVE_INFINITY
  #mouse = new DialogTargets()
  #request: DialogRequest
  #pages: Page[]
  #page = 0
  #filter = ""
  #searchTexts: string[] = []
  #editor: Editor | undefined
  /** A secret input: masked, one line, never shown. */
  #secret: LineInput | undefined
  /** The free-text choice's field while it is open. */
  #field: LineInput | undefined
  #done = false
  #spinner = new Spinner()
  #spinnerFrame: number | undefined
  #refreshIntervalMs: number | undefined
  #animatedRows = new Set<string>()

  constructor(
    request: DialogRequest,
    private onDone: (answer: DialogAnswer) => void,
    private keys: Keybindings = defaultKeybindings(),
    private selection: {
      changed?: (option: string) => void
      /** A local picker's independent control, shown below its title. */
      header?: (theme: Theme) => string
      footer?: HintItem[]
      handleInput?: (event: InputEvent) => boolean
    } = {},
  ) {
    this.#request = request
    this.#pages = pagesOf(request)
    if (request.kind === "select") this.#searchTexts = request.searchTexts?.map((s) => s.toLowerCase()) ?? []
    if (request.kind === "input" && request.secret) {
      this.#secret = new LineInput({ mask: "*", accept: (g) => !/\s/.test(g) })
    } else if (request.kind === "input") {
      this.#editor = new Editor({
        prompt: `${glyphs.pointer} `,
        placeholder: request.placeholder ?? "",
        onSubmit: (text) => this.#finish(text),
        isSubmit: (e) => keys.is(e, "dialog.choose"),
        isNewline: () => false,
      })
      if (request.initial) this.#editor.setText(request.initial)
    }
  }

  get request(): DialogRequest {
    return this.#request
  }

  /** Only working badges actually shown by the last frame request animation. */
  get refreshIntervalMs(): number | undefined {
    return this.#done ? undefined : this.#refreshIntervalMs
  }

  /** Refreshes presentation in place; fixed options keep selection, filtering and scroll intact. */
  update(request: DialogRequest): boolean {
    const current = this.request
    if (
      this.#done ||
      current.kind !== "select" ||
      request.kind !== "select" ||
      current.requestId !== request.requestId ||
      current.options.length !== request.options.length ||
      current.options.some((option, i) => option !== request.options[i])
    )
      return false
    this.#request = {
      ...current,
      optionLabels: request.optionLabels,
      optionStatuses: request.optionStatuses,
      optionExtensionStatuses: request.optionExtensionStatuses,
      descriptions: request.descriptions,
    }
    for (const c of this.#current.choices) c.description = request.descriptions?.[c.index ?? 0]
    return true
  }

  /** A rejected acknowledgement resumes the same editor, including multi-question drafts. */
  retryAnswer(): void {
    if (this.#pages.length) this.#done = false
  }

  /** Releases unfinished answers without invoking the request's answer callback. */
  close(): void {
    this.#done = true
    this.#editor = undefined
    this.#secret = undefined
    this.#field = undefined
    this.#filter = ""
    this.#pages = []
    this.#mouse.reset()
  }

  handleInput(e: InputEvent): boolean {
    if (this.#done) return false
    if (e.type === "mouse") return this.handleMouse(e)
    const keys = this.keys
    if (this.#field) return this.#fieldKey(e)
    if (keys.is(e, "dialog.cancel")) {
      // Esc on a later question of several goes back one, keeping the answers given so far.
      if (this.#page > 0 && e.type === "key" && e.name === "escape") {
        this.#goTo(this.#page - 1)
        return true
      }
      return this.#finish(undefined)
    }
    if (this.selection.handleInput?.(e)) return true
    const r = this.request
    if (r.kind === "input") {
      if (this.#secret) {
        if (keys.is(e, "dialog.choose")) return this.#finish(this.#secret.value)
        return this.#secret.handleInput(e)
      }
      // An empty input is still an answer; the editor leaves Enter on empty text to us.
      if (this.#editor!.handleInput(e)) return true
      if (keys.is(e, "dialog.choose")) return this.#finish("")
      return false
    }
    const page = this.#current
    const choices = this.#choices()
    const n = choices.length
    if (this.#pages.length > 1 && keys.is(e, "dialog.prev-question")) {
      if (this.#page > 0) this.#goTo(this.#page - 1)
      return true
    }
    if (this.#pages.length > 1 && keys.is(e, "dialog.next-question")) {
      if (this.#page < this.#frontier()) this.#goTo(this.#page + 1)
      return true
    }
    if (keys.is(e, "dialog.up")) page.selected = n ? (Math.max(0, page.selected) - 1 + n) % n : 0
    else if (keys.is(e, "dialog.down")) page.selected = n ? (page.selected + 1) % n : 0
    else if (r.kind === "confirm" && keys.is(e, "dialog.yes")) return this.#finish(true)
    else if (r.kind === "confirm" && keys.is(e, "dialog.no")) return this.#finish(false)
    else if (page.multi && keys.is(e, "dialog.toggle")) this.#toggle(page.selected)
    else if (keys.is(e, "dialog.choose")) {
      if (!n || page.selected < 0) return true
      if (!page.multi) return this.#choose(page.selected)
      // Enter on an empty free-text choice opens it rather than submitting without it.
      const at = choices[page.selected]
      if (at?.other && !page.checked.has(page.selected)) return this.#openField(page)
      return this.#submitPage()
    } else if (this.#digits && e.type === "key" && e.text && /^[1-9]$/.test(e.text) && Number(e.text) <= n) {
      const i = Number(e.text) - 1
      page.selected = i
      if (page.multi) this.#toggle(i)
      else return this.#choose(i)
    } else if (
      r.kind === "select" &&
      e.type === "key" &&
      (r.searchTexts ? e.ctrl : !e.ctrl) &&
      !e.alt &&
      (!this.#filter || (!!r.searchTexts && e.ctrl)) &&
      this.#isSectionKey(e.text ?? e.name)
    ) {
      // A section's key answers on the selected option; where it does nothing it is not typed
      // either. Once a filter is being typed, the key is part of it.
      const c = choices[page.selected]
      if (c && this.#sectionKeys(c).some((k) => k.key === (e.text ?? e.name)))
        return this.#finish({ option: c.label, key: e.text ?? e.name })
    } else if (r.kind === "select" && e.type === "key" && e.name === "backspace" && this.#filter) {
      this.#setFilter(this.#filter.slice(0, -1))
    } else if (r.kind === "select" && e.type === "key" && e.text && !e.ctrl && !e.alt) {
      this.#setFilter(this.#filter + e.text)
    } else return false
    const option = this.#choices()[page.selected]?.label
    if (option !== undefined) this.selection.changed?.(option)
    return true
  }

  /** Handles cells relative to the last rendered frame. */
  handleMouse(e: MouseInput): boolean {
    if (this.#done) return false
    if (e.action === "wheel") {
      if (e.button !== "up" && e.button !== "down") return false
      if (!this.#mouse.contains(e)) return false
      const choices = this.#choices()
      const page = this.#current
      page.selected = Math.max(0, Math.min(choices.length - 1, page.selected + (e.button === "up" ? -3 : 3)))
      const option = choices[page.selected]?.label
      if (option !== undefined) this.selection.changed?.(option)
      return true
    }
    const hit = this.#mouse.handle(e)
    if (hit) {
      if (hit.key) return this.handleInput(hit.key)
      if (hit.row !== undefined) {
        this.#editor?.placeCursor(e.x, hit.row)
        return true
      }
      if (hit.id === "secret") {
        this.#secret?.placeCursor(e.x - (hit.column ?? 0))
        return true
      }
      const page = this.#current
      const choice = this.#choices()[hit.index]
      if (!choice) return false
      if (this.#field && choice.other && page.selected === hit.index) {
        this.#field.placeCursor(e.x - (hit.column ?? 0))
        return true
      }
      if (this.#field) {
        const draft = this.#field.value.trim()
        if (draft) page.other = draft
        this.#field = undefined
      }
      page.selected = hit.index
      this.selection.changed?.(choice.label)
      if (page.multi) {
        // Clicking a checkbox toggles it; a second click submits without toggling it back.
        if (hit.double) return this.#submitPage()
        this.#toggle(hit.index)
      } else if (this.request.kind === "confirm" || this.request.kind === "diff-review" || hit.double) {
        return this.#choose(hit.index)
      }
      return true
    }
    return this.#mouse.contains(e)
  }

  render(width: number, ctx: RenderContext): string[] {
    this.#mouse.begin(width)
    if (!this.#pages.length) return []
    const { theme } = ctx
    this.#animatedRows.clear()
    this.#refreshIntervalMs = undefined
    if (this.request.kind === "select" && this.request.optionStatuses?.includes("working")) {
      // Existing redraws drive the shared spinner cadence; static states never animate.
      const frame = Math.floor(Date.now() / Spinner.INTERVAL_MS)
      if (this.#spinnerFrame !== undefined && frame !== this.#spinnerFrame) this.#spinner.tick()
      this.#spinnerFrame = frame
    }
    // Border semantics: approvals warn, other live questions use the interactive accent.
    const border = this.request.source === "approval" ? theme.warning : theme.accent
    const inner = Math.max(1, width - 3)
    const title = this.#titleRows(inner, theme)[0] ?? ""
    // Body producers include their two-cell gutter; the frame absorbs one into its side.
    const body =
      this.request.kind === "input"
        ? renderDialogInput(inner + 2, ctx, {
            budget: this.#bodyBudget,
            title: this.#titleRows(inner, theme).slice(1),
            targets: this.#mouse,
            hints: this.#footer(),
            editor: this.#editor,
            secret: this.#secret,
            placeholder: this.request.placeholder,
          })
        : this.#renderList(inner + 2, ctx)
    const { rows, kept } = this.#mouse.frame(title, body, width, ctx, border, this.maxRows)
    if (kept.some((row) => this.#animatedRows.has(row))) this.#refreshIntervalMs = Spinner.INTERVAL_MS
    return rows
  }

  get #bodyBudget(): number {
    return this.maxRows < 4 ? Math.max(1, this.maxRows - 1) : Math.max(2, this.maxRows - 2)
  }

  #renderList(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const r = this.request
    const page = this.#current
    const choices = this.#choices()
    const title = this.#titleRows(Math.max(1, width - 2), theme).slice(1)
    const message =
      r.kind === "confirm" && r.message
        ? r.message
            .split("\n")
            .flatMap((l) => wrapText(theme.muted(l), Math.max(1, width - 2)).map((w) => `  ${w}`))
        : []
    // A diff to review, or what an approval is about as its tool presents it (a command, a diff).
    const diff =
      r.kind === "diff-review"
        ? renderToolLines(parseUnifiedDiff(r.diff), theme, Math.max(1, width - 2))
        : r.kind === "confirm" && r.preview?.length
          ? renderToolLines(r.preview, theme, Math.max(1, width - 2))
          : []
    const indicator =
      this.#pages.length > 1
        ? theme.muted(
            truncateToWidth(
              `${this.#page + 1}/${this.#pages.length}${page.header ? ` ${glyphs.separator} ${page.header}` : ""}`,
              width,
              glyphs.more,
            ),
          )
        : undefined
    // At the four-row minimum, the selected answer and hint take precedence over the filter.
    const filter =
      this.#filter && this.#bodyBudget >= 3
        ? [truncateToWidth(`${theme.muted("filter:")} ${this.#filter}`, Math.max(1, width - 2), glyphs.more)]
        : []
    const fit: Fit = {
      blanks: 2,
      inlineDescriptions: false,
      message: message.length,
      options: Math.min(MAX_OPTIONS, Math.max(1, choices.length)),
      title: title.length,
      indicator: indicator !== undefined,
      position: true,
      headings: true,
    }
    const layout = (diffRows: number) => {
      const out: string[] = []
      if (fit.indicator && indicator) out.push(indicator)
      out.push(...fitTitle(title, fit.title))
      out.push(...cutEnd(message, fit.message, theme))
      if (diffRows > 0) out.push(...cutMiddle(diff, diffRows, theme, Math.max(1, width - 2)))
      if (fit.blanks > 1) out.push("")
      out.push(...filter)
      const offset = out.length
      out.push(...this.#optionRows(choices, width, fit, theme))
      this.#mouse.placeOptions(offset)
      if (fit.blanks > 0) out.push("")
      out.push(this.#mouse.footer(out.length, this.#footer(), Math.max(1, width - 2), theme))
      return out
    }
    // The diff takes what the rest leaves, and a diff cut short is worth more than blank rows.
    // The rest gives rows back in this order.
    if (diff.length && layout(0).length + diff.length > this.#bodyBudget) fit.blanks = 0
    const fits = () => layout(0).length <= this.#bodyBudget
    // Each step gives up a row (or a way of drawing) while it can.
    const steps: [can: () => boolean, take: () => void][] = [
      [() => fit.blanks > 0, () => fit.blanks--],
      [() => !fit.inlineDescriptions, () => (fit.inlineDescriptions = true)],
      [() => fit.message > 0, () => fit.message--],
      [() => fit.headings, () => (fit.headings = false)],
      [() => fit.options > 1, () => fit.options--],
      [() => fit.position, () => (fit.position = false)],
      [() => fit.title > 0, () => fit.title--],
      [() => fit.indicator, () => (fit.indicator = false)],
    ]
    for (const [can, take] of steps) {
      while (!fits() && can()) take()
    }
    const room = this.#bodyBudget - layout(0).length
    const rows = layout(Number.isFinite(room) ? Math.max(0, room) : diff.length)
    // Local pickers keep their explicit control hints even below the usual three-row minimum.
    if (this.selection.footer?.length && rows.length > this.#bodyBudget) {
      const cut = rows.length - Math.max(1, this.#bodyBudget)
      this.#mouse.trimBody(cut)
      return rows.slice(cut)
    }
    return rows
  }

  /** The options around the selected one, as many as `fit` allows, then where the window is. */
  #optionRows(choices: Choice[], width: number, fit: Fit, theme: Theme): string[] {
    const page = this.#current
    this.#mouse.beginOptions()
    if (!choices.length) return [theme.muted("  no match")]
    const shown = Math.min(fit.options, choices.length)
    const start = Math.min(Math.max(0, page.selected - shown + 1), Math.max(0, choices.length - shown))
    const digits = this.#digits
    const items = choices.slice(start, start + shown).map((c, j) => {
      const i = start + j
      const selected = i === page.selected
      const marker = selected ? theme.accent(glyphs.choice) : " "
      const digit = digits ? `${theme.muted(String(i + 1))} ` : ""
      const box = page.multi ? `${page.checked.has(i) ? glyphs.checked : glyphs.unchecked} ` : ""
      const status =
        this.request.kind === "select" && c.index !== undefined
          ? this.request.optionStatuses?.[c.index]
          : undefined
      const badge = status ? `${styledStatusBadge(status, theme, this.#spinner.glyph, { pad: true })} ` : ""
      const lead = `${marker} ${digit}${box}`
      // An option numbered as its digit ("1. explorer", for frontends without digits) shows once.
      const display =
        this.request.kind === "select" && c.index !== undefined
          ? (this.request.optionLabels?.[c.index] ?? c.label)
          : c.label
      const label = digits && display.startsWith(`${i + 1}. `) ? display.slice(`${i + 1}. `.length) : display
      const typed = c.other && page.other ? `${label} ${theme.muted(JSON.stringify(page.other))}` : label
      const description = c.description?.replace(/\s+/g, " ").trim() ?? ""
      return { c, i, selected, lead, badge, typed, description, status }
    })
    // Descriptions line up in a column after the labels when every one fits there; else each
    // goes under its label, unless the rows are too few for that.
    const described = items.filter((it) => it.description && !it.c.other)
    const column = Math.max(
      0,
      ...described.map((it) => visibleWidth(it.lead) + visibleWidth(it.badge) + visibleWidth(it.typed)),
    )
    const inline =
      fit.inlineDescriptions ||
      (!(this.request.kind === "select" && this.request.searchTexts) &&
        described.every((it) => column + 2 + visibleWidth(it.description) <= width))
    const rows: string[] = []
    for (const { c, i, selected, lead, badge, typed, description, status } of items) {
      const heading = this.#heading(c)
      if (heading && fit.headings) rows.push(truncateToWidth(`  ${theme.muted(heading)}`, width, glyphs.more))
      const leadWidth = visibleWidth(lead)
      const id = `choice:${this.#page}:${c.index ?? i}`
      const target = { id, index: i, ...(c.other ? { column: leadWidth } : {}) }
      const firstRow = rows.length
      if (c.other && this.#field && selected) {
        const field = this.#field.render(Math.max(4, width - leadWidth), theme, {
          focused: true,
          placeholder: "Type your answer",
        })
        this.#mouse.option(rows.length, rows.length + 1, target)
        rows.push(`${lead}${field}`)
        continue
      }
      const extensionStatus =
        this.request.kind === "select" && c.index !== undefined
          ? this.request.optionExtensionStatuses?.[c.index]
          : undefined
      const head = `${lead}${badge}${styledExtensionLabel(typed, extensionStatus, theme, selected)}`
      const optionRow = rows.length
      if (!description) {
        rows.push(truncateToWidth(head, width, glyphs.more))
      } else if (inline) {
        const pad = " ".repeat(Math.max(0, column - visibleWidth(head)))
        rows.push(truncateToWidth(`${head}${pad}  ${theme.muted(description)}`, width, glyphs.more))
      } else {
        rows.push(truncateToWidth(head, width, glyphs.more))
        const indent = " ".repeat(leadWidth)
        for (const l of wrapText(description, Math.max(1, width - leadWidth)))
          rows.push(`${indent}${theme.muted(l)}`)
      }
      this.#mouse.option(firstRow, rows.length, target)
      if (status === "working" && leadWidth < width - 1) this.#animatedRows.add(rows[optionRow]!)
    }
    if (shown < choices.length && fit.position) {
      rows.push(theme.muted(`  ${Math.max(0, page.selected) + 1}/${choices.length}`))
    }
    return rows
  }

  /** The bold title, and who asked in muted text; wrapped under itself. */
  #titleRows(width: number, theme: Theme): string[] {
    const r = this.request
    const sourceLabel = r.sourceLabel ?? r.source
    const from = sourceLabel ? theme.muted(` (${sourceLabel})`) : ""
    const question = this.#current?.question ?? r.title
    const title = wrapText(`${bold(theme.text(question))}${from}`, Math.max(1, width))
    const header = this.selection.header?.(theme)
    if (header) {
      const marked = stripAnsi(header).startsWith(`${glyphs.choice} `)
      title.push(truncateToWidth(header, width + (marked ? 2 : 0), glyphs.more))
    }
    return title
  }

  /** The keys at the bottom, the most useful kept longest as the width shrinks. */
  #footer(): DialogHints {
    const r = this.request
    const page = this.#current
    if (r.kind === "input")
      return [this.#hint("dialog.choose", "submit", 5), this.#hint("dialog.cancel", "cancel", 3)]
    if (this.#field) {
      return [this.#hint("dialog.choose", "submit", 5), this.#hint("dialog.cancel", "back", 4)]
    }
    const move = this.keys.pairLabel("dialog.up", "dialog.down")
    const questions = this.keys.pairLabel("dialog.prev-question", "dialog.next-question")
    const yes = this.keys.label("dialog.yes")
    const no = this.keys.label("dialog.no")
    const answerKeys =
      r.kind === "confirm" && (yes && no ? `${yes}/${no}` : no ? `${no} no` : yes ? `${yes} yes` : "")
    // Nothing chosen yet (a confirm): the arrows pick, and only then does Enter answer.
    const picking = page.selected < 0
    // Of several questions, Enter goes on to the next one not answered, until the last.
    const more = this.#pages.some((p) => p !== page && !p.answer)
    const section = this.#section(this.#choices()[page.selected])
    const choose = more ? "next" : page.multi ? "submit" : (section?.choose ?? "choose")
    // An approval's Esc denies the call (and stops the turn); a later question's goes back one.
    const cancel = this.#page > 0 ? "back" : r.source === "approval" ? "deny" : "cancel"
    return [
      this.#pages.length > 1 && questions && { text: `${questions} question`, priority: 4 },
      move && { text: `${move} ${picking ? "select" : "move"}`, priority: picking ? 5 : 2 },
      page.multi && this.#hint("dialog.toggle", "toggle", 4),
      // Only a select filters; the other lists are few and fixed.
      r.kind === "select" && { text: "type to filter", priority: 1 },
      answerKeys && { text: answerKeys, priority: 1 },
      !picking && this.#hint("dialog.choose", choose, 5),
      // Typed into a filter, the keys are part of it.
      ...(this.#filter && !(r.kind === "select" && r.searchTexts) ? [] : (section?.keys ?? [])).map((k) => ({
        text: `${keyLabel({ name: k.key, ctrl: r.kind === "select" && !!r.searchTexts })} ${k.label}`,
        priority: 4,
      })),
      ...(this.selection.footer ?? []),
      this.#hint("dialog.cancel", cancel, 3),
    ]
  }

  /** A footer item for an action's key; none when the action has no key bound. */
  #hint(action: Action, what: string, priority: number) {
    const label = this.keys.label(action)
    const spec =
      action === "dialog.choose" || action === "dialog.cancel" ? this.keys.keys(action)[0] : undefined
    return label
      ? { text: `${label} ${what}`, priority, ...(spec ? { key: key(spec.name, spec) } : {}) }
      : undefined
  }

  /** The section of a select that a choice is in, by its place in the whole list. */
  #section(c: Choice | undefined) {
    const r = this.request
    if (r.kind !== "select" || !r.sections || c?.index === undefined) return undefined
    return sectionOf(r.sections, c.index)
  }

  #sectionKeys(c: Choice) {
    return this.#section(c)?.keys ?? []
  }

  /** Whether `text` is a key of some section: it answers rather than filters. */
  #isSectionKey(text: string): boolean {
    const r = this.request
    return r.kind === "select" && (r.sections ?? []).some((s) => s.keys?.some((k) => k.key === text))
  }

  /** The heading shown above a choice: its section's title, when it starts there and nothing is typed. */
  #heading(c: Choice): string | undefined {
    const r = this.request
    if (r.kind !== "select" || this.#filter || c.index === undefined) return undefined
    return r.sections?.find((s) => s.at === c.index)?.title
  }

  get #current(): Page {
    return this.#pages[this.#page]!
  }

  /** The current page's choices: a select's are those matching the filter, best first. */
  #choices(): Choice[] {
    const r = this.request
    const choices = this.#current?.choices ?? []
    if (r.kind !== "select" || !this.#filter) return choices
    if (!r.searchTexts) return rankMatches(this.#filter, choices, (c) => c.label)
    const query = this.#filter.toLowerCase()
    return choices.flatMap((c) => {
      const text = r.searchTexts![c.index ?? 0] ?? ""
      const snippet = sessionSnippet(text, this.#filter, 45, this.#searchTexts[c.index ?? 0])
      return c.label.toLowerCase().includes(query) || snippet !== undefined
        ? [{ ...c, description: snippet ?? c.description }]
        : []
    })
  }

  /**
   * Digits choose (or check) an option of a short unfiltered list. A longer list needs them for
   * its filter: model ids like gpt-4o start with or turn on a digit. A confirm has y and n.
   */
  get #digits(): boolean {
    const r = this.request
    return (
      r.kind !== "confirm" &&
      r.kind !== "input" &&
      !(r.kind === "select" && r.searchTexts) &&
      this.#choices().length <= 9 &&
      !this.#filter
    )
  }

  #choose(i: number): true {
    const page = this.#current
    const c = this.#choices()[i]
    if (!c) return true
    page.selected = i
    if (c.other) return this.#openField(page)
    if (this.request.kind !== "ask") return this.#finish(c.value ?? c.label)
    return this.#answerPage({ selected: [c.label] })
  }

  #toggle(i: number) {
    const page = this.#current
    const c = page.choices[i]
    if (!c) return
    if (page.checked.has(i)) page.checked.delete(i)
    else if (c.other) this.#openField(page)
    else page.checked.add(i)
  }

  #openField(page: Page): true {
    this.#field = new LineInput()
    if (page.other) this.#field.value = page.other
    return true
  }

  /** Keys while the free-text field is open: it edits; Enter keeps the text, Esc closes it. */
  #fieldKey(e: InputEvent): boolean {
    const field = this.#field!
    if (this.keys.is(e, "dialog.cancel") && !(e.type === "key" && e.name === "escape")) {
      // Ctrl+C (or another cancel key but Esc) bails out of the whole dialog, as elsewhere.
      return this.#finish(undefined)
    }
    if (this.keys.is(e, "dialog.cancel")) {
      // Esc closes the field; what was typed stays with the choice, for when it is chosen again.
      const draft = field.value.trim()
      if (draft) this.#current.other = draft
      this.#field = undefined
      return true
    }
    if (this.keys.is(e, "dialog.choose")) {
      const text = field.value.trim()
      if (!text) return true
      const page = this.#current
      this.#field = undefined
      page.other = text
      if (page.multi) {
        page.checked.add(page.selected)
        return true
      }
      if (this.request.kind === "confirm") return this.#finish({ other: text })
      return this.#answerPage({ selected: [], other: text })
    }
    return field.handleInput(e)
  }

  #submitPage(): true {
    const page = this.#current
    const selected: string[] = []
    let other: string | undefined
    for (const [i, c] of page.choices.entries()) {
      if (!page.checked.has(i)) continue
      if (c.other) other = page.other
      else selected.push(c.label)
    }
    return this.#answerPage({ selected, ...(other ? { other } : {}) })
  }

  /** Keeps a question's answer and goes on to the first one not answered; the last one answers all. */
  #answerPage(answer: AskAnswer): true {
    this.#current.answer = answer
    const next = this.#pages.findIndex((p) => !p.answer)
    if (next === -1) return this.#finish(this.#pages.map((p) => p.answer!))
    this.#goTo(next)
    return true
  }

  /** The furthest question one may go to: the first not answered yet. */
  #frontier(): number {
    const i = this.#pages.findIndex((p) => !p.answer)
    return i === -1 ? this.#pages.length - 1 : i
  }

  #goTo(i: number) {
    this.#mouse.reset()
    this.#page = i
    const page = this.#current
    // Back on an answered question, the cursor is on its answer.
    const a = page.answer
    if (a && !page.multi) {
      const at =
        a.other !== undefined
          ? page.choices.findIndex((c) => c.other)
          : page.choices.findIndex((c) => c.label === a.selected[0])
      if (at !== -1) page.selected = at
    }
  }

  #setFilter(filter: string) {
    this.#mouse.reset()
    this.#filter = filter
    this.#current.selected = 0
  }

  #finish(answer: DialogAnswer): true {
    if (!this.#done) {
      this.#done = true
      this.#mouse.reset()
      this.onDone(answer)
    }
    return true
  }
}

/** The questions of a request, each with its choices. */
function pagesOf(r: DialogRequest): Page[] {
  const page = (question: string, choices: Choice[], extra: Partial<Page> = {}): Page => ({
    question,
    choices,
    multi: false,
    selected: 0,
    checked: new Set(),
    ...extra,
  })
  switch (r.kind) {
    case "confirm":
      return [
        page(
          r.title,
          [
            { label: CONFIRM_LABELS.yes, value: true },
            ...(r.always ? [{ label: alwaysLabel(r.always), value: "always" as const }] : []),
            { label: CONFIRM_LABELS.no, value: false },
            ...(r.other ? [{ label: otherLabel(), other: true }] : []),
          ],
          // Nothing preselected: an Enter typed before the dialog showed up does not answer it.
          { selected: -1 },
        ),
      ]
    case "select":
      return [
        page(
          r.title,
          r.options.map((o, i) => {
            const description = r.descriptions?.[i]
            return { label: o, value: o, index: i, ...(description ? { description } : {}) }
          }),
          { selected: r.initial === undefined ? 0 : Math.max(0, r.options.indexOf(r.initial)) },
        ),
      ]
    case "diff-review":
      return [
        page(
          r.title,
          r.options.map((o) => ({ label: o, value: o })),
        ),
      ]
    case "ask":
      return r.questions.map((q) =>
        page(
          q.question,
          [
            ...q.options.map((o) => ({
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
            { label: otherLabel(), other: true },
          ],
          { multi: q.multiSelect === true, ...(q.header ? { header: q.header } : {}) },
        ),
      )
    default:
      return [page(r.title, [])]
  }
}

/**
 * What stays in the transcript once a dialog is answered: a line per question under the same
 * empty marker gutter, "  Allow bash? › Yes". A secret answer is never shown.
 */
export function dialogEchoLines(
  r: DialogRequest,
  answer: DialogAnswer,
  theme: Theme,
  width = Number.POSITIVE_INFINITY,
): string[] {
  // Completed questions are transcript content, not a live typing container.
  const line = (question: string, shown: string) => {
    const text = `${bold(theme.text(question))} ${theme.muted(`${glyphs.pointer} ${shown}`)}`
    const rows = Number.isFinite(width) ? wrapText(text, Math.max(1, width - BAR_WIDTH)) : [text]
    return rows.map((l) => `  ${l}`)
  }
  if (answer === undefined) return line(r.title, "cancelled")
  if (r.kind === "ask" && Array.isArray(answer)) {
    return r.questions.flatMap((q, i) =>
      line(q.question, answer[i] ? askAnswerText(answer[i]) : "(no answer)"),
    )
  }
  if (r.kind === "select" && typeof answer === "object" && "option" in answer) {
    const key =
      answer.key &&
      sectionOf(r.sections, r.options.indexOf(answer.option))?.keys?.find((k) => k.key === answer.key)
    return line(r.title, key ? `${answer.option} ${glyphs.separator} ${key.label}` : answer.option)
  }
  if (r.kind === "input" && r.secret) return line(r.title, "(hidden)")
  if (r.kind === "input" && answer === "") return line(r.title, "(empty)")
  if (r.kind === "confirm") {
    const shown =
      answer === true
        ? CONFIRM_LABELS.yes
        : answer === false
          ? CONFIRM_LABELS.no
          : answer === "always"
            ? alwaysLabel(r.always ?? true)
            : typeof answer === "object" && "other" in answer
              ? JSON.stringify(answer.other)
              : String(answer)
    return line(r.title, shown)
  }
  return line(r.title, String(answer))
}

/** An ask answer in words: the labels chosen, then the text typed, quoted. */
function askAnswerText(a: AskAnswer): string {
  const parts = [...a.selected, ...(a.other !== undefined ? [JSON.stringify(a.other)] : [])]
  return parts.length ? parts.join(", ") : "(none)"
}

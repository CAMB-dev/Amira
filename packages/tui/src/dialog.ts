import { type AskAnswer, type ConfirmAnswer, type EventMap, type SelectChoice, sectionOf } from "@amira/api"
import { rankMatches } from "@amira/core"
import {
  type Component,
  Editor,
  type InputEvent,
  LineInput,
  type RenderContext,
  type StyleFn,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { parseUnifiedDiff, renderToolLines } from "./diff-view.ts"
import { glyphs } from "./glyphs.ts"
import { fitHint } from "./hint.ts"
import { type Action, defaultKeybindings, type Keybindings } from "./keybindings.ts"

export type DialogRequest = EventMap["ui.request"]

/** How a dialog was answered; undefined cancels it. */
export type DialogAnswer = string | ConfirmAnswer | AskAnswer[] | SelectChoice | undefined

/** Options of a list shown at once; longer lists scroll with the selection. */
const MAX_OPTIONS = 10

/** Where a dialog's bar and title start: "┃ ". */
const BAR_WIDTH = 2

/** The labels of a confirm's choices, which its echo repeats. */
export const CONFIRM_LABELS = {
  yes: "Yes",
  always: "Yes, and don't ask again this session",
  no: "No",
} as const

const OTHER_LABEL = `Other${glyphs.more}`

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
}

/**
 * The one component for every question the user answers inline (ui.request): a confirm, a
 * select (typing filters it), a diff review, an input (plain or secret) and the questions of
 * ask_user. It is a block with a bar down its left: the question, a muted message or diff, the
 * options as a list (❯ marks the selected one; digits choose in short lists; a multi-select
 * checks them with Space), and the keys at the bottom. A select's sections put a heading over
 * their options and add keys of their own, shown while one of them is selected. A confirm starts with nothing selected:
 * Enter does nothing until the user has moved to a choice, so keys typed before it showed up
 * (a message being written) cannot answer it. A free-text choice ("Other…") opens a
 * text field in its row, which Esc closes again; Esc elsewhere cancels. Several questions are
 * asked one after another in the same block and answered together. Calls `onDone` once. It
 * fits `maxRows`: the title, the selected option and the keys always show, given three rows.
 */
export class Dialog implements Component {
  /** Rows the dialog may take; set by the app before each render. */
  maxRows = Number.POSITIVE_INFINITY
  #pages: Page[]
  #page = 0
  #filter = ""
  #editor: Editor | undefined
  /** A secret input: masked, one line, never shown. */
  #secret: LineInput | undefined
  /** The free-text choice's field while it is open. */
  #field: LineInput | undefined
  #done = false

  constructor(
    readonly request: DialogRequest,
    private onDone: (answer: DialogAnswer) => void,
    private keys: Keybindings = defaultKeybindings(),
  ) {
    this.#pages = pagesOf(request)
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

  handleInput(e: InputEvent): boolean {
    if (this.#done) return false
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
    if (r.kind === "form") return false
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
      e.text &&
      !e.ctrl &&
      !e.alt &&
      this.#isSectionKey(e.text)
    ) {
      // A section's key answers on the selected option; where it does nothing it is not typed either.
      const c = choices[page.selected]
      if (c && this.#sectionKeys(c).some((k) => k.key === e.text))
        return this.#finish({ option: c.label, key: e.text })
    } else if (r.kind === "select" && e.type === "key" && e.name === "backspace" && this.#filter) {
      this.#setFilter(this.#filter.slice(0, -1))
    } else if (r.kind === "select" && e.type === "key" && e.text && !e.ctrl && !e.alt) {
      this.#setFilter(this.#filter + e.text)
    } else return false
    return true
  }

  render(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const bar = barStyle(this.request, theme)(glyphs.dialogBar)
    const inner = Math.max(1, width - BAR_WIDTH)
    const rows = this.request.kind === "input" ? this.#renderInput(inner, ctx) : this.#renderList(inner, ctx)
    return rows.map((l) => (l ? `${bar} ${l}` : bar))
  }

  #renderInput(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const r = this.request as Extract<DialogRequest, { kind: "input" }>
    const hint = theme.muted(
      fitHint([this.#hint("dialog.choose", "submit", 5), this.#hint("dialog.cancel", "cancel", 3)], width),
    )
    const title = this.#titleRows(width, theme)
    const editor = this.#editor
    // The whole text, to see whether it fits with the title.
    if (editor) editor.maxRows = Number.POSITIVE_INFINITY
    const render = () =>
      this.#secret
        ? [
            `${glyphs.pointer} ${this.#secret.render(Math.max(4, width - 2), theme, { focused: true, placeholder: r.placeholder ?? "" })}`,
          ]
        : editor!.render(width, ctx)
    let body = render()
    // A blank row before the keys goes first, then the title gives way, then the text scrolls
    // inside the rows left (the caret stays in view): a row of title stays while two are left.
    const blank = title.length + body.length + 2 <= this.maxRows ? [""] : []
    const room = Math.max(1, this.maxRows - 1 - blank.length)
    if (editor && body.length > room - 1) {
      editor.maxRows = Math.max(1, room - (room > 1 ? 1 : 0))
      body = render()
    }
    const titleRoom = room - body.length
    return [...(titleRoom > 0 ? fitTitle(title, titleRoom) : []), ...body, ...blank, hint]
  }

  #renderList(width: number, ctx: RenderContext): string[] {
    const { theme } = ctx
    const r = this.request
    const page = this.#current
    const choices = this.#choices()
    const title = this.#titleRows(width, theme)
    const message =
      r.kind === "confirm" && r.message
        ? r.message
            .split("\n")
            .flatMap((l) => wrapText(theme.muted(l), Math.max(1, width - 2)).map((w) => `  ${w}`))
        : []
    // A diff to review, or what an approval is about as its tool presents it (a command, a diff).
    const diff =
      r.kind === "diff-review"
        ? renderToolLines(parseUnifiedDiff(r.diff), theme, width)
        : r.kind === "confirm" && r.preview?.length
          ? renderToolLines(r.preview, theme, width)
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
    const filter = this.#filter
      ? [truncateToWidth(`${theme.muted(`filter ${glyphs.pointer}`)} ${this.#filter}`, width, glyphs.more)]
      : []
    const hint = theme.muted(fitHint(this.#footer(), width))
    const fit: Fit = {
      blanks: 2,
      inlineDescriptions: false,
      message: message.length,
      options: Math.min(MAX_OPTIONS, Math.max(1, choices.length)),
      title: title.length,
      indicator: indicator !== undefined,
      position: true,
    }
    const layout = (diffRows: number) => {
      const out: string[] = []
      if (fit.indicator && indicator) out.push(indicator)
      out.push(...fitTitle(title, fit.title))
      out.push(...cutEnd(message, fit.message, theme))
      if (diffRows > 0) out.push(...cutMiddle(diff, diffRows, theme))
      if (fit.blanks > 1) out.push("")
      out.push(...filter, ...this.#optionRows(choices, width, fit, theme))
      if (fit.blanks > 0) out.push("")
      out.push(hint)
      return out
    }
    // The diff takes what the rest leaves, and a diff cut short is worth more than blank rows.
    // The rest gives rows back in this order.
    if (diff.length && layout(0).length + diff.length > this.maxRows) fit.blanks = 0
    const fits = () => layout(0).length <= this.maxRows
    // Each step gives up a row (or a way of drawing) while it can.
    const steps: [can: () => boolean, take: () => void][] = [
      [() => fit.blanks > 0, () => fit.blanks--],
      [() => !fit.inlineDescriptions, () => (fit.inlineDescriptions = true)],
      [() => fit.message > 1, () => fit.message--],
      [() => fit.options > 1, () => fit.options--],
      [() => fit.message > 0, () => fit.message--],
      [() => fit.position, () => (fit.position = false)],
      [() => fit.title > 1, () => fit.title--],
      [() => fit.indicator, () => (fit.indicator = false)],
    ]
    for (const [can, take] of steps) {
      while (!fits() && can()) take()
    }
    const room = this.maxRows - layout(0).length
    return layout(Number.isFinite(room) ? Math.max(0, room) : diff.length)
  }

  /** The options around the selected one, as many as `fit` allows, then where the window is. */
  #optionRows(choices: Choice[], width: number, fit: Fit, theme: Theme): string[] {
    const page = this.#current
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
      const lead = `${marker} ${digit}${box}`
      // An option numbered as its digit ("1. explorer", for frontends without digits) shows once.
      const label = digits && c.label.startsWith(`${i + 1}. `) ? c.label.slice(`${i + 1}. `.length) : c.label
      const typed = c.other && page.other ? `${label} ${theme.muted(JSON.stringify(page.other))}` : label
      const description = c.description?.replace(/\s+/g, " ").trim() ?? ""
      return { c, selected, lead, typed, description }
    })
    // Descriptions line up in a column after the labels when every one fits there; else each
    // goes under its label, unless the rows are too few for that.
    const described = items.filter((it) => it.description && !it.c.other)
    const column = Math.max(0, ...described.map((it) => visibleWidth(it.lead) + visibleWidth(it.typed)))
    const inline =
      fit.inlineDescriptions || described.every((it) => column + 2 + visibleWidth(it.description) <= width)
    const rows: string[] = []
    for (const { c, selected, lead, typed, description } of items) {
      const heading = this.#heading(c)
      if (heading) rows.push(truncateToWidth(`  ${theme.muted(heading)}`, width, glyphs.more))
      const leadWidth = visibleWidth(lead)
      if (c.other && this.#field && selected) {
        const field = this.#field.render(Math.max(4, width - leadWidth), theme, {
          focused: true,
          placeholder: "Type your answer",
        })
        rows.push(`${lead}${field}`)
        continue
      }
      const head = `${lead}${selected ? theme.accent(typed) : typed}`
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
    }
    if (shown < choices.length && fit.position) {
      rows.push(theme.muted(`  ${Math.max(0, page.selected) + 1}/${choices.length}`))
    }
    return rows
  }

  /** The question with its "?", and who asked in muted text; wrapped under itself. */
  #titleRows(width: number, theme: Theme): string[] {
    const r = this.request
    const from = r.source ? theme.muted(` (${r.source})`) : ""
    const question = this.#current?.question ?? r.title
    const rows = wrapText(`${question}${from}`, Math.max(1, width - 2))
    return rows.map((l, i) => (i === 0 ? `${theme.accent(glyphs.question)} ${l}` : `  ${l}`))
  }

  /** The keys at the bottom, the most useful kept longest as the width shrinks. */
  #footer(): Parameters<typeof fitHint>[0] {
    const r = this.request
    const page = this.#current
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
      ...(section?.keys ?? []).map((k) => ({ text: `${k.key} ${k.label}`, priority: 4 })),
      this.#hint("dialog.cancel", cancel, 3),
    ]
  }

  /** A footer item for an action's key; none when the action has no key bound. */
  #hint(action: Action, what: string, priority: number) {
    const key = this.keys.label(action)
    return key ? { text: `${key} ${what}`, priority } : undefined
  }

  /** The section of a select that a choice is in, by its place in the whole list. */
  #section(c: Choice | undefined) {
    const r = this.request
    if (r.kind !== "select" || !r.sections || !c) return undefined
    return sectionOf(r.sections, r.options.indexOf(c.label))
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
    if (r.kind !== "select" || this.#filter) return undefined
    const i = r.options.indexOf(c.label)
    return r.sections?.find((s) => s.at === i)?.title
  }

  get #current(): Page {
    return this.#pages[this.#page]!
  }

  /** The current page's choices: a select's are those matching the filter, best first. */
  #choices(): Choice[] {
    const r = this.request
    const choices = this.#current?.choices ?? []
    return r.kind === "select" && this.#filter ? rankMatches(this.#filter, choices, (c) => c.label) : choices
  }

  /**
   * Digits choose (or check) an option of a short unfiltered list. A longer list needs them for
   * its filter: model ids like gpt-4o start with or turn on a digit. A confirm has y and n.
   */
  get #digits(): boolean {
    const r = this.request
    return r.kind !== "confirm" && r.kind !== "input" && this.#choices().length <= 9 && !this.#filter
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
    this.#filter = filter
    this.#current.selected = 0
  }

  #finish(answer: DialogAnswer): true {
    if (!this.#done) {
      this.#done = true
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
            ...(r.other ? [{ label: OTHER_LABEL, other: true }] : []),
          ],
          // Nothing preselected: an Enter typed before the dialog showed up does not answer it.
          { selected: -1 },
        ),
      ]
    case "select":
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
            { label: OTHER_LABEL, other: true },
          ],
          { multi: q.multiSelect === true, ...(q.header ? { header: q.header } : {}) },
        ),
      )
    default:
      return [page(r.title, [])]
  }
}

/** The bar's color: approvals of tool calls in the warning color, other questions in the accent. */
function barStyle(r: DialogRequest, theme: Theme): StyleFn {
  return r.source === "approval" ? theme.warning : theme.accent
}

/**
 * What stays in the transcript once a dialog is answered: a line per question under the same
 * bar, "┃ ? Allow bash? › Yes". A secret answer is never shown.
 */
export function dialogEchoLines(
  r: DialogRequest,
  answer: DialogAnswer,
  theme: Theme,
  width = Number.POSITIVE_INFINITY,
): string[] {
  const bar = barStyle(r, theme)(glyphs.dialogBar)
  // Wrapped, a line goes on under its question, the bar still at its left.
  const line = (question: string, shown: string) => {
    const text = `${theme.accent(glyphs.question)} ${question} ${theme.muted(`${glyphs.pointer} ${shown}`)}`
    const rows = Number.isFinite(width) ? wrapText(text, Math.max(1, width - BAR_WIDTH - 2)) : [text]
    return rows.map((l, i) => (i === 0 ? `${bar} ${l}` : `${bar}   ${l}`))
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

/** A wrapped title cut to `rows`, its last row ending in an ellipsis when cut. */
function fitTitle(title: string[], rows: number): string[] {
  if (title.length <= rows) return title
  const kept = title.slice(0, Math.max(1, rows))
  kept[kept.length - 1] = `${kept[kept.length - 1]}${glyphs.more}`
  return kept
}

/** Lines cut to `rows` from the end, the last kept one marking the cut. */
function cutEnd(lines: string[], rows: number, theme: Theme): string[] {
  if (lines.length <= rows) return lines
  if (rows <= 0) return []
  const kept = lines.slice(0, rows)
  kept[rows - 1] = `${kept[rows - 1]}${theme.muted(` ${glyphs.more}`)}`
  return kept
}

/**
 * Lines cut to `rows`: the start and the end, with a marker in the middle saying how many
 * were left out. The start (file names, first hunk) gets the extra row.
 */
function cutMiddle(lines: string[], rows: number, theme: Theme): string[] {
  if (lines.length <= rows) return lines
  if (rows <= 0) return []
  const keep = rows - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  const marker = theme.muted(`${glyphs.more} ${lines.length - keep} more lines ${glyphs.more}`)
  return [...lines.slice(0, head), marker, ...lines.slice(lines.length - tail)]
}

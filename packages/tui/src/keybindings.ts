import { readFileSync } from "node:fs"
import { detectEnv, type InputEvent, type TerminalEnv } from "@amira/tui-kit"

/**
 * Where an action applies: the input box, a completion list below it while open (commands
 * or files), the history search while it runs, or a dialog; in full-screen mode also the
 * transcript (keys taken before the input's), a block selection, and the find bar.
 */
export type KeyScope = "input" | "popup" | "search" | "dialog" | "transcript" | "select" | "find"

interface ActionInfo {
  scope: KeyScope
  description: string
}

/**
 * Every key the TUI answers, by action. `~/.amira/keybindings.json` maps these names to key
 * specs; docs/keybindings.md lists them with their defaults.
 */
export const ACTIONS = {
  submit: {
    scope: "input",
    description:
      'Send the message; while a turn runs, steer it (queue it with tui.submitWhileWorking "queue")',
  },
  newline: { scope: "input", description: "Insert a line break" },
  queue: {
    scope: "input",
    description:
      'While a turn runs, send the message after it (steer it with tui.submitWhileWorking "queue")',
  },
  "submit.steer": { scope: "input", description: "Send the message; while a turn runs, always steer it" },
  "submit.queue": {
    scope: "input",
    description: "Send the message; while a turn runs, always send it after the turn",
  },
  interrupt: { scope: "input", description: "Stop the running turn" },
  cancel: { scope: "input", description: "Stop the running turn, else clear the input, else quit" },
  exit: { scope: "input", description: "Quit when the input is empty and nothing runs" },
  redraw: { scope: "input", description: "Clear the screen and draw it again" },
  "history.prev": { scope: "input", description: "Recall the previous prompt, from the first line" },
  "history.next": { scope: "input", description: "Recall the next prompt, from the last line" },
  "history.search": { scope: "input", description: "Search the prompt history" },
  "tool-output": { scope: "input", description: "Cycle how much of tool results is shown" },
  "panels.toggle": {
    scope: "input",
    description: "Fold or unfold the live panels above the activity line (e.g. a todo list)",
  },
  "popup.up": { scope: "popup", description: "Select the previous command, argument or file" },
  "popup.down": { scope: "popup", description: "Select the next command, argument or file" },
  "popup.complete": {
    scope: "popup",
    description: "Complete the selected command or argument; insert the file",
  },
  "popup.accept": { scope: "popup", description: "Run the command; insert the file" },
  "popup.close": { scope: "popup", description: "Close the list until the text changes" },
  "search.older": { scope: "search", description: "Show the next older match" },
  "search.newer": { scope: "search", description: "Show the next newer match" },
  "search.accept": { scope: "search", description: "Keep the match in the input to edit or send" },
  "search.cancel": { scope: "search", description: "Leave the search with the draft back" },
  "dialog.up": { scope: "dialog", description: "Select the previous option" },
  "dialog.down": { scope: "dialog", description: "Select the next option" },
  "dialog.choose": { scope: "dialog", description: "Choose the selected option, or submit the input" },
  "dialog.cancel": { scope: "dialog", description: "Cancel the dialog" },
  "dialog.yes": { scope: "dialog", description: "Answer yes to a confirmation" },
  "dialog.no": { scope: "dialog", description: "Answer no to a confirmation" },
  "dialog.toggle": {
    scope: "dialog",
    description: "Check or uncheck the selected option where several may be chosen",
  },
  "dialog.prev-question": { scope: "dialog", description: "Go back to the previous question of several" },
  "dialog.next-question": {
    scope: "dialog",
    description: "Go on to the next question of several, up to the first one not answered yet",
  },
  "scroll.up": { scope: "transcript", description: "Scroll the transcript up a line" },
  "scroll.down": { scope: "transcript", description: "Scroll the transcript down a line" },
  "scroll.page-up": { scope: "transcript", description: "Scroll the transcript up a page" },
  "scroll.page-down": { scope: "transcript", description: "Scroll the transcript down a page" },
  "scroll.top": {
    scope: "transcript",
    description: "Go to the start of the transcript (Home only while the input is empty)",
  },
  "scroll.bottom": {
    scope: "transcript",
    description: "Go to the end of the transcript and follow it (End only while the input is empty)",
  },
  "select.start": { scope: "transcript", description: "Select the newest block of the transcript" },
  find: { scope: "transcript", description: "Find text in the transcript" },
  "copy.reply": { scope: "transcript", description: "Copy the last reply (its Markdown) to the clipboard" },
  "select.prev": { scope: "select", description: "Select the block before" },
  "select.next": { scope: "select", description: "Select the block after" },
  "select.toggle": {
    scope: "select",
    description: "Fold or unfold the selected block (tool output, long code, details, sub-agents)",
  },
  "select.copy": { scope: "select", description: "Copy the selected block to the clipboard" },
  "select.exit": { scope: "select", description: "Stop selecting and go back to the input" },
  "find.next": { scope: "find", description: "Go to the next match up (older)" },
  "find.prev": { scope: "find", description: "Go to the next match down (newer)" },
  "find.close": { scope: "find", description: "Close the find bar, staying where the match is" },
} satisfies Record<string, ActionInfo>

export type Action = keyof typeof ACTIONS

const isAction = (name: string): name is Action => Object.hasOwn(ACTIONS, name)

/**
 * The default keys. Windows Terminal takes Alt+Enter for fullscreen, so Ctrl+Q comes first
 * there. VS Code keeps Ctrl+Q for itself (Quick Open View is in its commandsToSkipShell), so
 * Alt+Enter comes first in its terminal, as everywhere else. Both keys queue everywhere.
 */
export function defaultKeys(env: Pick<TerminalEnv, "vscode">, platform = process.platform) {
  const ctrlQFirst = platform === "win32" && !env.vscode
  const keys: Record<Action, string[]> = {
    submit: ["enter"],
    newline: ["shift+enter", "ctrl+enter"],
    queue: ctrlQFirst ? ["ctrl+q", "alt+enter"] : ["alt+enter", "ctrl+q"],
    // Unbound: submit and queue cover both; these are for a key that never depends on the setting.
    "submit.steer": [],
    "submit.queue": [],
    interrupt: ["escape"],
    cancel: ["ctrl+c"],
    exit: ["ctrl+d"],
    redraw: ["ctrl+l"],
    "history.prev": ["up"],
    "history.next": ["down"],
    "history.search": ["ctrl+r"],
    "tool-output": ["ctrl+o"],
    "panels.toggle": ["ctrl+t"],
    "popup.up": ["up"],
    "popup.down": ["down"],
    "popup.complete": ["tab"],
    "popup.accept": ["enter"],
    "popup.close": ["escape"],
    "search.older": ["ctrl+r"],
    "search.newer": ["ctrl+s"],
    "search.accept": ["enter"],
    "search.cancel": ["escape", "ctrl+c", "ctrl+g"],
    "dialog.up": ["up", "shift+tab"],
    "dialog.down": ["down", "tab"],
    "dialog.choose": ["enter"],
    "dialog.cancel": ["escape", "ctrl+c"],
    "dialog.yes": ["y"],
    "dialog.no": ["n"],
    "dialog.toggle": ["space"],
    "dialog.prev-question": ["left"],
    "dialog.next-question": ["right"],
    "scroll.up": ["shift+up"],
    "scroll.down": ["shift+down"],
    "scroll.page-up": ["pageup"],
    "scroll.page-down": ["pagedown"],
    // VS Code keeps Ctrl+Home/End (scroll its terminal), Ctrl+F (its find widget) and Ctrl+↑↓
    // (move between commands) for itself (commandsToSkipShell); the Alt keys reach the UI there.
    "scroll.top": env.vscode ? ["alt+home", "home", "ctrl+home"] : ["ctrl+home", "home", "alt+home"],
    "scroll.bottom": env.vscode ? ["alt+end", "end", "ctrl+end"] : ["ctrl+end", "end", "alt+end"],
    "select.start": env.vscode ? ["alt+up", "ctrl+up"] : ["ctrl+up", "alt+up"],
    find: env.vscode ? ["alt+f", "ctrl+f"] : ["ctrl+f", "alt+f"],
    "copy.reply": ["alt+c"],
    "select.prev": ["up", "ctrl+up", "alt+up", "k"],
    "select.next": ["down", "ctrl+down", "alt+down", "j"],
    "select.toggle": ["enter", "space"],
    "select.copy": ["y", "c"],
    "select.exit": ["escape"],
    "find.next": ["enter", "up", "f3"],
    "find.prev": ["shift+enter", "down", "shift+f3"],
    "find.close": ["escape", "ctrl+c", "ctrl+g"],
  }
  return keys
}

/** A parsed key spec. `shift` undefined matches either: a plain "y" is also "Y". */
export interface KeySpec {
  name: string
  ctrl: boolean
  alt: boolean
  shift: boolean | undefined
}

/** Names a spec may use, and the spellings taken for them. */
const KEY_NAMES: Record<string, string> = {
  enter: "enter",
  return: "enter",
  tab: "tab",
  escape: "escape",
  esc: "escape",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  insert: "insert",
  space: "space",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
}
for (let i = 1; i <= 12; i++) KEY_NAMES[`f${i}`] = `f${i}`

/** Reads "ctrl+q", "alt+enter", "shift+tab", "escape", "y"; an error message when it cannot. */
export function parseKeySpec(spec: string): KeySpec | string {
  const parts = spec.trim().toLowerCase().split("+")
  // "ctrl++" names the plus key.
  if (parts.length > 1 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+")
  const last = parts.pop() ?? ""
  const out: KeySpec = { name: "", ctrl: false, alt: false, shift: undefined }
  for (const mod of parts) {
    if (mod === "ctrl" || mod === "control") out.ctrl = true
    else if (mod === "alt" || mod === "option" || mod === "meta") out.alt = true
    else if (mod === "shift") out.shift = true
    else return `unknown modifier "${mod}" (use ctrl, alt or shift)`
  }
  const named = KEY_NAMES[last]
  if (named) out.name = named
  else if ([...last].length === 1 && last.trim()) out.name = last
  else return last ? `unknown key "${last}"` : "no key after the modifiers"
  // Named keys and shortcuts must match Shift exactly: Enter is not Shift+Enter.
  if (out.shift === undefined && (named || out.ctrl || out.alt)) out.shift = false
  return out
}

export function keyMatches(e: InputEvent, spec: KeySpec): boolean {
  return (
    e.type === "key" &&
    e.name === spec.name &&
    e.ctrl === spec.ctrl &&
    e.alt === spec.alt &&
    (spec.shift === undefined || e.shift === spec.shift)
  )
}

const LABELS: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
}

/** How a key reads in hints: "Ctrl+Q", "Alt+Enter", "Esc", "↑", "y". */
export function keyLabel(spec: KeySpec): string {
  const mods = spec.ctrl || spec.alt || spec.shift
  const base = LABELS[spec.name] ?? (/^f\d+$/.test(spec.name) ? spec.name.toUpperCase() : spec.name)
  const key = mods && base.length === 1 ? base.toUpperCase() : base
  return `${spec.ctrl ? "Ctrl+" : ""}${spec.alt ? "Alt+" : ""}${spec.shift ? "Shift+" : ""}${key}`
}

const specKey = (s: KeySpec) => `${s.ctrl}:${s.alt}:${s.shift ?? "any"}:${s.name}`

/** The keys of every action, checked by name wherever the TUI takes a key. */
export class Keybindings {
  readonly #specs: Record<Action, KeySpec[]>

  constructor(keys: Record<Action, string[]>) {
    const specs = {} as Record<Action, KeySpec[]>
    for (const action of Object.keys(ACTIONS) as Action[]) {
      specs[action] = (keys[action] ?? []).flatMap((k) => {
        const s = parseKeySpec(k)
        return typeof s === "string" ? [] : [s]
      })
    }
    this.#specs = specs
  }

  /** Whether `e` is one of the action's keys. */
  is(e: InputEvent, action: Action): boolean {
    return this.#specs[action].some((s) => keyMatches(e, s))
  }

  /** The keys bound to an action, first the one hints show. */
  keys(action: Action): readonly KeySpec[] {
    return this.#specs[action]
  }

  /**
   * How the action's key reads in a hint: its first key, or the first `usable` one (Shift+Enter
   * is no use where the terminal cannot tell it from Enter). Undefined when nothing is bound.
   */
  label(action: Action, usable: (s: KeySpec) => boolean = () => true): string | undefined {
    const specs = this.#specs[action]
    const spec = specs.find(usable) ?? specs[0]
    return spec ? keyLabel(spec) : undefined
  }

  /** A pair of moves in one label: "↑↓" for the arrows, else "Ctrl+P/Ctrl+N". */
  pairLabel(up: Action, down: Action): string | undefined {
    const a = this.label(up)
    const b = this.label(down)
    if (!a || !b) return a ?? b
    return a.length === 1 && b.length === 1 ? `${a}${b}` : `${a}/${b}`
  }
}

/** The default keys for this terminal, for components not handed any. */
export function defaultKeybindings(env: Pick<TerminalEnv, "vscode"> = detectEnv()): Keybindings {
  return new Keybindings(defaultKeys(env))
}

export interface LoadedKeybindings {
  keys: Keybindings
  /** Problems with the file, each naming it; the keys they concern keep their defaults. */
  warnings: string[]
}

/**
 * Applies a keybindings.json object to the defaults: `{"queue": "ctrl+q"}` or
 * `{"newline": ["shift+enter", "ctrl+j"]}`; an empty list unbinds the action. Unknown actions
 * and keys that cannot be read are reported and left out.
 */
export function parseKeybindings(
  raw: unknown,
  file: string,
  defaults: Record<Action, string[]>,
): LoadedKeybindings {
  const warnings: string[] = []
  const keys = { ...defaults }
  const set = new Set<Action>()
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`${file}: must hold a JSON object of action names to keys; using the default keys`)
    return { keys: new Keybindings(keys), warnings }
  }
  for (const [name, value] of Object.entries(raw)) {
    if (name === "$schema") continue
    if (!isAction(name)) {
      warnings.push(`${file}: unknown action "${name}" (ignored); see docs/keybindings.md`)
      continue
    }
    const list = typeof value === "string" ? [value] : value
    if (!Array.isArray(list) || !list.every((k) => typeof k === "string")) {
      warnings.push(`${file}: "${name}" must be a key such as "ctrl+q", or a list of them (ignored)`)
      continue
    }
    const good: string[] = []
    for (const k of list) {
      const spec = parseKeySpec(k)
      if (typeof spec === "string") warnings.push(`${file}: "${name}": cannot use "${k}": ${spec}`)
      else good.push(k)
    }
    if (list.length && !good.length) continue
    keys[name] = good
    set.add(name)
  }
  // A key bound twice in one place does only the first action checked; say so.
  const byScope = new Map<string, Action>()
  for (const action of Object.keys(ACTIONS) as Action[]) {
    for (const k of keys[action]) {
      const spec = parseKeySpec(k) as KeySpec
      const id = `${ACTIONS[action].scope}:${specKey(spec)}`
      const other = byScope.get(id)
      if (other && (set.has(action) || set.has(other)) && other !== action) {
        warnings.push(`${file}: ${keyLabel(spec)} is bound to both "${other}" and "${action}"`)
      } else byScope.set(id, action)
    }
  }
  return { keys: new Keybindings(keys), warnings }
}

/** Reads keybindings.json; a missing file means the defaults, a broken one a warning. */
export function loadKeybindings(
  file: string,
  defaults: Record<Action, string[]> = defaultKeys(detectEnv()),
): LoadedKeybindings {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT"
    return {
      keys: new Keybindings(defaults),
      warnings: missing
        ? []
        : [`${file}: cannot be read (${(err as Error).message}); using the default keys`],
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      keys: new Keybindings(defaults),
      warnings: [`${file}: not valid JSON (${(err as Error).message}); using the default keys`],
    }
  }
  return parseKeybindings(raw, file, defaults)
}

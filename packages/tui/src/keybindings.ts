import { readFileSync } from "node:fs"
import { detectEnv, type InputEvent, type TerminalEnv } from "@amira/tui-kit"

/** Where an action applies: the input box, the command popup while open, or a dialog. */
export type KeyScope = "input" | "popup" | "dialog"

interface ActionInfo {
  scope: KeyScope
  description: string
}

/**
 * Every key the TUI answers, by action. `~/.amira/keybindings.json` maps these names to key
 * specs; docs/keybindings.md lists them with their defaults.
 */
export const ACTIONS = {
  submit: { scope: "input", description: "Send the message; while a turn runs, steer it" },
  newline: { scope: "input", description: "Insert a line break" },
  queue: { scope: "input", description: "While a turn runs, send the message after it" },
  interrupt: { scope: "input", description: "Stop the running turn" },
  cancel: { scope: "input", description: "Stop the running turn, else clear the input, else quit" },
  exit: { scope: "input", description: "Quit when the input is empty and nothing runs" },
  redraw: { scope: "input", description: "Clear the screen and draw it again" },
  "popup.up": { scope: "popup", description: "Select the previous command or argument" },
  "popup.down": { scope: "popup", description: "Select the next command or argument" },
  "popup.complete": { scope: "popup", description: "Complete the selected command or argument" },
  "popup.accept": { scope: "popup", description: "Run the command" },
  "popup.close": { scope: "popup", description: "Close the popup until the text changes" },
  "dialog.up": { scope: "dialog", description: "Select the previous option" },
  "dialog.down": { scope: "dialog", description: "Select the next option" },
  "dialog.choose": { scope: "dialog", description: "Choose the selected option, or submit the input" },
  "dialog.cancel": { scope: "dialog", description: "Cancel the dialog" },
  "dialog.yes": { scope: "dialog", description: "Answer yes to a confirmation" },
  "dialog.no": { scope: "dialog", description: "Answer no to a confirmation" },
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
    interrupt: ["escape"],
    cancel: ["ctrl+c"],
    exit: ["ctrl+d"],
    redraw: ["ctrl+l"],
    "popup.up": ["up"],
    "popup.down": ["down"],
    "popup.complete": ["tab"],
    "popup.accept": ["enter"],
    "popup.close": ["escape"],
    "dialog.up": ["up", "shift+tab"],
    "dialog.down": ["down", "tab"],
    "dialog.choose": ["enter"],
    "dialog.cancel": ["escape", "ctrl+c"],
    "dialog.yes": ["y"],
    "dialog.no": ["n"],
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
export function loadKeybindings(file: string, defaults: Record<Action, string[]>): LoadedKeybindings {
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

import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { InputParser, key, keyLabel as sharedKeyLabel, textKey } from "@amira/tui-kit"
import {
  ACTIONS,
  defaultKeys,
  Keybindings,
  keyLabel,
  loadKeybindings,
  parseKeybindings,
  parseKeySpec,
} from "../src/keybindings.ts"

const defaults = defaultKeys({ vscode: false }, "linux")
const events = (raw: string) => new InputParser().feed(raw)

test("key specs: modifiers, names and single characters", () => {
  expect(parseKeySpec("ctrl+q")).toEqual({ name: "q", ctrl: true, alt: false, shift: false })
  expect(parseKeySpec("Alt+Enter")).toEqual({ name: "enter", ctrl: false, alt: true, shift: false })
  expect(parseKeySpec("esc")).toEqual({ name: "escape", ctrl: false, alt: false, shift: false })
  expect(parseKeySpec("shift+tab")).toEqual({ name: "tab", ctrl: false, alt: false, shift: true })
  // A plain character matches with or without Shift, like typing y or Y.
  expect(parseKeySpec("y")).toEqual({ name: "y", ctrl: false, alt: false, shift: undefined })
  expect(parseKeySpec("ctrl++")).toMatchObject({ name: "+", ctrl: true })
  expect(parseKeySpec("hyper+x")).toBe('unknown modifier "hyper" (use ctrl, alt or shift)')
  expect(parseKeySpec("ctrl+")).toBe("no key after the modifiers")
  expect(parseKeySpec("ctrl+enterr")).toBe('unknown key "enterr"')
})

test("labels share the lower-case formatter with tui-kit", () => {
  expect(keyLabel).toBe(sharedKeyLabel)
  const label = (s: string) => keyLabel(parseKeySpec(s) as never)
  expect(label("ctrl+q")).toBe("ctrl+q")
  expect(label("alt+enter")).toBe("alt+enter")
  expect(label("escape")).toBe("esc")
  expect(label("up")).toBe("↑")
  expect(label("y")).toBe("y")
  expect(label("f5")).toBe("f5")
  expect(label("ctrl+alt+shift+f12")).toBe("ctrl+alt+shift+f12")
  expect(label("shift+tab")).toBe("shift+tab")
  expect(label("ctrl++")).toBe("ctrl++")
  expect(label("shift+up")).toBe("shift+↑")
  expect(label("pageup")).toBe("pgup")
  expect(label("pagedown")).toBe("pgdn")
  for (const name of ["enter", "tab", "space", "home", "end", "backspace", "delete", "insert"]) {
    expect(label(name)).toBe(name)
  }
  for (const specs of Object.values(defaults)) {
    for (const spec of specs) expect(label(spec)).toBe(label(spec).toLowerCase())
  }
})

test("the default keys match what terminals send", () => {
  const keys = new Keybindings(defaults)
  expect(keys.is(events("\x11")[0]!, "queue")).toBe(true) // Ctrl+Q
  expect(keys.is(events("\x1b\r")[0]!, "queue")).toBe(true) // Alt+Enter, legacy
  expect(keys.is(events("\x1b[13;3u")[0]!, "queue")).toBe(true) // Alt+Enter, kitty
  expect(keys.is(events("\r")[0]!, "submit")).toBe(true)
  expect(keys.is(events("\x1b[13;2u")[0]!, "submit")).toBe(false) // Shift+Enter
  expect(keys.is(events("\x1b[13;2u")[0]!, "newline")).toBe(true)
  expect(keys.is(events("\x0c")[0]!, "redraw")).toBe(true) // Ctrl+L
  expect(keys.is(textKey("y"), "dialog.yes")).toBe(false)
  expect(keys.is(textKey("N", { shift: true }), "dialog.no")).toBe(true)
  expect(keys.is(key("tab", { shift: true }), "dialog.up")).toBe(true)
  expect(keys.is(key("tab"), "dialog.up")).toBe(false)
})

test("the queue key hints show depends on the terminal: Ctrl+Q in Windows Terminal, else Alt+Enter", () => {
  expect(new Keybindings(defaultKeys({ vscode: false }, "win32")).label("queue")).toBe("ctrl+q")
  // VS Code keeps Ctrl+Q (Quick Open View) from its terminal.
  expect(new Keybindings(defaultKeys({ vscode: true }, "win32")).label("queue")).toBe("alt+enter")
  expect(new Keybindings(defaultKeys({ vscode: false }, "darwin")).label("queue")).toBe("alt+enter")
})

test("in VS Code the transcript keys it keeps for itself have Alt ones first", () => {
  const vscode = new Keybindings(defaultKeys({ vscode: true }, "win32"))
  // Ctrl+F, Ctrl+Home and Ctrl+End are in its commandsToSkipShell.
  expect(vscode.label("find")).toBe("alt+f")
  expect(vscode.label("scroll.top")).toBe("alt+home")
  expect(vscode.label("scroll.bottom")).toBe("alt+end")
  expect(vscode.is(events("\x1bf")[0]!, "find")).toBe(true)
  const other = new Keybindings(defaultKeys({ vscode: false }, "win32"))
  expect(other.label("find")).toBe("ctrl+f")
  expect(other.label("scroll.bottom")).toBe("ctrl+end")
  // The Alt keys work everywhere.
  expect(other.is(events("\x1b[1;3H")[0]!, "scroll.top")).toBe(true)
})

test("a label can skip keys the terminal cannot send", () => {
  const keys = new Keybindings(defaults)
  expect(keys.label("newline")).toBe("shift+enter")
  expect(keys.label("newline", (s) => !(s.shift && s.name === "enter"))).toBe("ctrl+enter")
})

test("keybindings.json replaces an action's keys; an empty list unbinds it", () => {
  const { keys, warnings } = parseKeybindings(
    { queue: "ctrl+b", newline: ["ctrl+j"], redraw: [] },
    "kb.json",
    defaults,
  )
  expect(warnings).toEqual([])
  expect(keys.is(key("b", { ctrl: true }), "queue")).toBe(true)
  expect(keys.is(key("q", { ctrl: true }), "queue")).toBe(false)
  expect(keys.is(key("j", { ctrl: true }), "newline")).toBe(true)
  expect(keys.is(key("l", { ctrl: true }), "redraw")).toBe(false)
  expect(keys.label("queue")).toBe("ctrl+b")
  expect(keys.label("newline")).toBe("ctrl+j")
  expect(keys.label("redraw")).toBeUndefined()
})

test("paired hints retain rebound and unbound keys in lower case", () => {
  const { keys } = parseKeybindings(
    { "dialog.up": "ctrl+p", "dialog.down": "ctrl+n", "select.prev": [], "select.next": "f6" },
    "kb.json",
    defaults,
  )
  expect(keys.pairLabel("dialog.up", "dialog.down")).toBe("ctrl+p/ctrl+n")
  expect(keys.pairLabel("select.prev", "select.next")).toBe("f6")
})

test("problems are reported clearly and leave the defaults in place", () => {
  const { keys, warnings } = parseKeybindings(
    { quue: "ctrl+q", queue: "ctrl+", exit: 4, redraw: ["ctrl+l", "hyper+l"], cancel: "ctrl+l" },
    "kb.json",
    defaults,
  )
  expect(warnings).toEqual([
    'kb.json: unknown action "quue" (ignored); see docs/keybindings.md',
    'kb.json: "queue": cannot use "ctrl+": no key after the modifiers',
    'kb.json: "exit" must be a key such as "ctrl+q", or a list of them (ignored)',
    'kb.json: "redraw": cannot use "hyper+l": unknown modifier "hyper" (use ctrl, alt or shift)',
    'kb.json: ctrl+l is bound to both "cancel" and "redraw"',
  ])
  expect(keys.is(key("q", { ctrl: true }), "queue")).toBe(true)
  expect(keys.is(key("d", { ctrl: true }), "exit")).toBe(true)
  // The same key in different places (the input and a dialog) is fine.
  expect(parseKeybindings({ "dialog.cancel": "ctrl+c" }, "kb.json", defaults).warnings).toEqual([])
  expect(parseKeybindings([], "kb.json", defaults).warnings).toEqual([
    "kb.json: must hold a JSON object of action names to keys; using the default keys",
  ])
})

test("the file: missing means the defaults, broken JSON a warning", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-kb-"))
  try {
    const file = path.join(dir, "keybindings.json")
    expect(loadKeybindings(file, defaults).warnings).toEqual([])
    writeFileSync(file, "{ queue: ")
    const broken = loadKeybindings(file, defaults)
    expect(broken.warnings[0]).toStartWith(`${file}: not valid JSON (`)
    expect(broken.keys.is(key("q", { ctrl: true }), "queue")).toBe(true)
    writeFileSync(file, JSON.stringify({ $schema: "x", queue: "ctrl+b" }))
    const loaded = loadKeybindings(file, defaults)
    expect(loaded.warnings).toEqual([])
    expect(loaded.keys.label("queue")).toBe("ctrl+b")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("every action has a default and a description", () => {
  // Enter and the queue key cover these two; they are there to be bound by hand.
  // A single key that approves is opt-in: typed early, it would answer an approval unseen.
  const optIn = new Set(["submit.steer", "submit.queue", "dialog.yes"])
  for (const action of Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]) {
    if (optIn.has(action)) expect(defaults[action]).toEqual([])
    else expect(defaults[action].length).toBeGreaterThan(0)
    expect(ACTIONS[action].description.length).toBeGreaterThan(0)
  }
})

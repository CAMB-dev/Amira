import { expect, test } from "bun:test"
import { key, textKey, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { KeyReference, type KeyReferenceOptions } from "../src/key-reference.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"

const keys = new Keybindings({ ...defaultKeys({ vscode: false }, "linux"), help: ["f1"] })

function open(opts: { fullscreen?: boolean; usable?: KeyReferenceOptions["usable"] } = {}) {
  let closed = 0
  const ref = new KeyReference(keys, {
    fullscreen: opts.fullscreen ?? true,
    onClose: () => closed++,
    ...(opts.usable ? { usable: opts.usable } : {}),
  })
  return { ref, closed: () => closed }
}

test("Esc, q, Ctrl+C and the help key close it; other keys scroll or do nothing", () => {
  for (const k of [key("escape"), textKey("q"), textKey("c", { ctrl: true }), key("f1")]) {
    const { ref, closed } = open()
    ref.render(60, { ...plain, rows: 12 })
    expect(ref.handleInput(k)).toBe(true)
    expect(closed()).toBe(1)
  }
  const { ref, closed } = open()
  ref.render(60, { ...plain, rows: 12 })
  expect(ref.handleInput(key("pagedown"))).toBe(true)
  expect(ref.render(60, { ...plain, rows: 12 }).at(-1)).toMatch(/^\d+–\d+ of \d+ · /)
  expect(ref.handleInput(textKey("x"))).toBe(false)
  expect(closed()).toBe(0)
})

test("it fits any screen: exactly its rows, none wider than the width", () => {
  for (const rows of [1, 2, 3, 5, 24]) {
    for (const width of [10, 40, 120]) {
      const lines = open().ref.render(width, { ...plain, rows })
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(width)
    }
  }
})

test("keys the terminal cannot send are left out; an action with none says so", () => {
  const { ref } = open({ usable: (action, s) => action !== "newline" || !(s.shift && s.name === "enter") })
  const text = ref.render(120, { ...plain, rows: 40 }).join("\n")
  expect(text).toMatch(/^ {2}Ctrl\+Enter +Insert a line break · newline$/m)
  expect(text).toMatch(
    /^ {2}not bound +Send the message; while a turn runs, always steer it · submit\.steer$/m,
  )
  expect(text).toMatch(/^ {2}F1 +List every key/m)
})

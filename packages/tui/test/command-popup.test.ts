import { expect, test } from "bun:test"
import type { CommandCandidate, CommandInfo } from "@amira/api"
import { rankMatches } from "@amira/core"
import { key } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { CommandPopup, type CompletionSource } from "../src/command-popup.ts"

const COMMANDS: CommandInfo[] = [
  { name: "clear", description: "Start over", source: "b" },
  { name: "compact", description: "Summarize", hint: "[instructions]", source: "b" },
  { name: "model", description: "Switch the model", hint: "[provider/model]", source: "b" },
  { name: "tools", description: "List tools", source: "b" },
]
const MODELS = ["deepseek/deepseek-flash", "deepseek/deepseek-pro", "openai/gpt-5"]

/** Completes like CommandHost; `delays` holds answers back to test stale ones. */
function source(delays: Record<string, number> = {}): CompletionSource {
  return {
    list: () => COMMANDS,
    async complete(line) {
      if (delays[line]) await Bun.sleep(delays[line])
      const name = /^\/(\S*)$/.exec(line)
      if (name) {
        return {
          candidates: rankMatches(name[1]!, COMMANDS, (c) => c.name).map((c) => ({
            value: c.name,
            description: c.description,
          })),
        }
      }
      const args = /^\/(\S+)\s([\s\S]*)$/.exec(line)!
      const all: CommandCandidate[] = args[1] === "model" ? MODELS.map((value) => ({ value })) : []
      return { command: args[1]!, candidates: rankMatches(args[2]!.trim(), all, (c) => c.value) }
    },
  }
}

async function popupFor(text: string, src = source()) {
  const popup = new CommandPopup(src, () => {})
  popup.update(text)
  await Bun.sleep(5)
  const lines = () => popup.render(60, plain)
  return { popup, lines }
}

test("opens only for one line starting with a slash", async () => {
  expect((await popupFor("hello")).popup.open).toBe(false)
  expect((await popupFor("/c\nmore")).popup.open).toBe(false)
  expect((await popupFor("/zzz")).popup.open).toBe(false)
  const { popup, lines } = await popupFor("/c")
  expect(popup.open).toBe(true)
  expect(lines()).toEqual(["› /clear    Start over", "  /compact  Summarize"])
})

test("↑↓ move the selection, wrapping; Tab completes the name with a space", async () => {
  const { popup, lines } = await popupFor("/c")
  expect(popup.handleKey(key("up"))).toEqual({ type: "handled" })
  expect(lines()[1]).toStartWith("› /compact")
  expect(popup.handleKey(key("tab"))).toEqual({ type: "replace", text: "/compact " })
})

test("Enter runs the selected command, but a bare slash runs nothing until one is picked", async () => {
  expect((await popupFor("/mo")).popup.handleKey(key("enter"))).toEqual({ type: "run", line: "/model" })
  const { popup } = await popupFor("/")
  expect(popup.handleKey(key("enter"))).toEqual({ type: "handled" })
  popup.handleKey(key("down"))
  expect(popup.handleKey(key("enter"))).toEqual({ type: "run", line: "/compact" })
})

test("argument candidates: Tab fills them in; Enter keeps typed text unless it is part of one", async () => {
  const partial = await popupFor("/model flash")
  expect(partial.lines()).toEqual(["› deepseek/deepseek-flash"])
  expect(partial.popup.handleKey(key("tab"))).toEqual({
    type: "replace",
    text: "/model deepseek/deepseek-flash",
  })
  expect(partial.popup.handleKey(key("enter"))).toEqual({
    type: "run",
    line: "/model deepseek/deepseek-flash",
  })
  // Nothing typed: Enter runs the bare command (here the picker), unless one was selected.
  const empty = await popupFor("/model ")
  expect(empty.lines()).toHaveLength(3)
  expect(empty.popup.handleKey(key("enter"))).toEqual({ type: "run", line: "/model" })
  empty.popup.handleKey(key("down"))
  expect(empty.popup.handleKey(key("enter"))).toEqual({ type: "run", line: "/model deepseek/deepseek-pro" })
})

test("a command without candidates shows its usage and leaves Enter to the editor", async () => {
  const { popup, lines } = await popupFor("/compact keep notes")
  expect(lines()).toEqual(["  /compact [instructions]  Summarize"])
  expect(popup.handleKey(key("enter"))).toBeUndefined()
  expect(popup.handleKey(key("up"))).toBeUndefined()
})

test("Esc closes the popup until the text changes", async () => {
  const { popup } = await popupFor("/c")
  expect(popup.handleKey(key("escape"))).toEqual({ type: "handled" })
  expect(popup.open).toBe(false)
  popup.update("/cl")
  await Bun.sleep(5)
  expect(popup.open).toBe(true)
})

test("a late answer for older text is dropped", async () => {
  const popup = new CommandPopup(source({ "/c": 40 }), () => {})
  popup.update("/c")
  popup.update("/t")
  await Bun.sleep(60)
  // "/t": the prefix match, then "compact" fuzzily; nothing of the answer for "/c".
  expect(popup.render(60, plain)).toEqual(["› /tools    List tools", "  /compact  Summarize"])
})

test("long lists scroll with the selection and show where it is", async () => {
  const many: CompletionSource = {
    list: () => [],
    complete: async () => ({ candidates: Array.from({ length: 20 }, (_, i) => ({ value: `c${i}` })) }),
  }
  const { popup, lines } = await popupFor("/", many)
  expect(lines()).toHaveLength(9)
  expect(lines().at(-1)).toBe("  1/20")
  for (let i = 0; i < 10; i++) popup.handleKey(key("down"))
  expect(lines()).toContain("› /c10")
  expect(lines()).not.toContain("  /c0")
  expect(lines().at(-1)).toBe("  11/20")
})

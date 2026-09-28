import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { CommandCandidate, CommandInfo, SessionControl } from "@amira/api"
import {
  Agent,
  CommandHost,
  CommandRegistry,
  EventBus,
  rankMatches,
  SkillRegistry,
  UiRequests,
} from "@amira/core"
import { key } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { CommandPopup, type CompletionSource } from "../src/command-popup.ts"

const COMMANDS: CommandInfo[] = [
  { name: "clear", aliases: [], description: "Start over", source: "b" },
  { name: "compact", aliases: [], description: "Summarize", hint: "[instructions]", source: "b" },
  { name: "model", aliases: [], description: "Switch the model", hint: "[provider/model]", source: "b" },
  { name: "tools", aliases: [], description: "List tools", source: "b" },
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
  // A looser fuzzy match only suggests: Enter runs what was typed, which may be a model the
  // list does not know. Tab still takes the suggestion.
  const fuzzy = await popupFor("/model deepseek/flash")
  expect(fuzzy.lines()).toEqual(["› deepseek/deepseek-flash"])
  expect(fuzzy.popup.handleKey(key("enter"))).toEqual({ type: "run", line: "/model deepseek/flash" })
  fuzzy.popup.handleKey(key("down"))
  expect(fuzzy.popup.handleKey(key("enter"))).toEqual({ type: "run", line: "/model deepseek/deepseek-flash" })
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

test("while the next answer is on its way the last list stays drawn, but keys wait for it", async () => {
  const { popup, lines } = await popupFor("/c", source({ "/co": 40 }))
  popup.update("/co")
  // Dropping the list for this frame made the popup and the rows below it flicker on each key.
  expect(popup.visible).toBe(true)
  expect(lines()).toEqual(["› /clear    Start over", "  /compact  Summarize"])
  expect(popup.open).toBe(false)
  await Bun.sleep(60)
  expect(popup.open).toBe(true)
  expect(lines()[0]).toBe("› /compact  Summarize")
  // Text that is no longer a command hides it at once.
  popup.update("hello")
  expect(popup.visible).toBe(false)
  expect(lines()).toEqual([])
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

/** A real CommandHost with /quit (exit, q) and /model, plus a settings alias. */
function hostSource(): CompletionSource {
  const bus = new EventBus()
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const registry = new CommandRegistry()
  const run = () => {}
  registry.register({ name: "quit", aliases: ["exit", "q"], description: "Leave Amira", run }, "b")
  registry.register({ name: "model", description: "Switch the model", args: { hint: "[ref]" }, run }, "b")
  return new CommandHost({
    registry,
    bus,
    ui: new UiRequests(bus),
    control: {} as SessionControl,
    agent: new Agent({ ai, model: ai.model("mock/m"), cwd: "/w", bus }),
    aliases: { ds: "model deepseek/deepseek-flash" },
  })
}

test("a command row shows its aliases; typing an alias finds it and Tab completes the name", async () => {
  const all = await popupFor("/", hostSource())
  expect(all.lines()).toEqual([
    "› /ds → /model deepseek/deepseek-flash  Switch the model",
    // The name column stops at 32 characters; a longer row pushes only its own description.
    "  /model                            Switch the model",
    "  /quit (exit, q)                   Leave Amira",
  ])
  const { popup, lines } = await popupFor("/ex", hostSource())
  expect(lines()).toEqual(["› /quit (exit, q)  Leave Amira"])
  expect(popup.handleKey(key("tab"))).toEqual({ type: "replace", text: "/quit " })
  expect(popup.handleKey(key("enter"))).toEqual({ type: "run", line: "/quit" })
  // An alias with arguments shows how the command it runs is used.
  expect((await popupFor("/q now", hostSource())).lines()).toEqual(["  /quit (exit, q)  Leave Amira"])
})

test("a settings alias row completes to the alias itself", async () => {
  const { popup, lines } = await popupFor("/d", hostSource())
  expect(lines()[0]).toStartWith("› /ds → /model deepseek/deepseek-flash")
  expect(popup.handleKey(key("tab"))).toEqual({ type: "replace", text: "/ds " })
  expect(popup.handleKey(key("enter"))).toEqual({ type: "run", line: "/ds" })
})

/** The skills of a real CommandHost, as the app hands them to the "$" popup. */
function skillSource(): CompletionSource {
  const bus = new EventBus()
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const skills = new SkillRegistry()
  const run = () => {}
  skills.register({ name: "deploy", description: "Ship it", run }, "s")
  skills.register({ name: "home-assistant", description: "Smart home", run }, "s")
  skills.register({ name: "review-pr", description: "Review a pull request", run }, "s")
  const host = new CommandHost({
    registry: new CommandRegistry(),
    skills,
    bus,
    ui: new UiRequests(bus),
    control: {} as SessionControl,
    agent: new Agent({ ai, model: ai.model("mock/m"), cwd: "/w", bus }),
  })
  return { complete: (line) => host.completeSkill(line), list: () => host.skills() }
}

async function skillPopupFor(text: string) {
  const popup = new CommandPopup(skillSource(), () => {}, undefined, "$")
  popup.update(text)
  await Bun.sleep(5)
  return { popup, lines: () => popup.render(60, plain) }
}

test("the $ popup lists skills; Tab and Enter complete and run them with a $", async () => {
  expect((await skillPopupFor("/d")).popup.open).toBe(false)
  const all = await skillPopupFor("$")
  expect(all.lines()).toEqual([
    "› $deploy          Ship it",
    "  $home-assistant  Smart home",
    "  $review-pr       Review a pull request",
  ])
  expect(all.popup.handleKey(key("enter"))).toEqual({ type: "handled" })
  all.popup.handleKey(key("down"))
  expect(all.popup.handleKey(key("tab"))).toEqual({ type: "replace", text: "$home-assistant " })
  expect(all.popup.handleKey(key("enter"))).toEqual({ type: "run", line: "$home-assistant" })
  expect((await skillPopupFor("$rev")).popup.handleKey(key("enter"))).toEqual({
    type: "run",
    line: "$review-pr",
  })
  // With arguments it shows how the skill is used and leaves Enter to the editor.
  const args = await skillPopupFor("$deploy to prod")
  expect(args.lines()).toEqual(["  $deploy [arguments]  Ship it"])
  expect(args.popup.handleKey(key("enter"))).toBeUndefined()
})

test("$ text that names no skill leaves Enter to the editor, even beside a fuzzy match", async () => {
  expect((await skillPopupFor("$100 is the price")).popup.open).toBe(false)
  expect((await skillPopupFor("$100")).popup.open).toBe(false)
  // "$hmst" fuzzily matches home-assistant: listed, but Enter sends the text unless picked.
  const fuzzy = await skillPopupFor("$hmst")
  expect(fuzzy.lines()).toEqual(["› $home-assistant  Smart home"])
  expect(fuzzy.popup.handleKey(key("enter"))).toBeUndefined()
  fuzzy.popup.handleKey(key("down"))
  expect(fuzzy.popup.handleKey(key("enter"))).toEqual({ type: "run", line: "$home-assistant" })
  // "$HOME" is listed by its prefix, but the case says it is the variable, not the skill.
  const home = await skillPopupFor("$HOME")
  expect(home.lines()).toEqual(["› $home-assistant  Smart home"])
  expect(home.popup.handleKey(key("enter"))).toBeUndefined()
  home.popup.handleKey(key("down"))
  expect(home.popup.handleKey(key("enter"))).toEqual({ type: "run", line: "$home-assistant" })
  expect((await skillPopupFor("$home")).popup.handleKey(key("enter"))).toEqual({
    type: "run",
    line: "$home-assistant",
  })
})

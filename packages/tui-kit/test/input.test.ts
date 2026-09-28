import { describe, expect, test } from "bun:test"
import { InputParser } from "../src/input.ts"
import { type InputEvent, isNewlineKey, isSubmitKey, key, textKey } from "../src/keys.ts"
import { InputReader } from "../src/reader.ts"
import { FakeTerminal } from "../src/terminal.ts"

function parse(...chunks: string[]): InputEvent[] {
  const p = new InputParser()
  return chunks.flatMap((c) => p.feed(c))
}

/** Every split of `data` into two chunks must parse the same as the whole. */
function expectSplitSafe(data: string, expected: InputEvent[]) {
  expect(parse(data)).toEqual(expected)
  for (let i = 1; i < data.length; i++) expect(parse(data.slice(0, i), data.slice(i))).toEqual(expected)
}

const win32 = (vk: number, uc: number, cs: number, kd = 1, rc = 1) => `\x1b[${vk};0;${uc};${kd};${cs};${rc}_`

describe("legacy", () => {
  test("text, including CJK and emoji", () => {
    expect(parse("aB")).toEqual([textKey("a"), textKey("B")])
    expect(parse("你😀")).toEqual([textKey("你"), textKey("😀")])
    expect(parse(" ")).toEqual([textKey(" ")])
    expect(parse(" ")[0]).toMatchObject({ name: "space", text: " " })
  })

  test("enter, ctrl+enter, tab, backspace", () => {
    expect(parse("\r")).toEqual([key("enter")])
    expect(parse("\n")).toEqual([key("enter", { ctrl: true })])
    expect(parse("\t")).toEqual([key("tab")])
    expect(parse("\x1b[Z")).toEqual([key("tab", { shift: true })])
    expect(parse("\x7f")).toEqual([key("backspace")])
    expect(parse("\x08")).toEqual([key("backspace")])
  })

  test("ctrl+letters", () => {
    expect(parse("\x01\x03\x1a")).toEqual([
      key("a", { ctrl: true }),
      key("c", { ctrl: true }),
      key("z", { ctrl: true }),
    ])
  })

  test("arrows, home/end, delete in CSI and SS3 forms", () => {
    expect(parse("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual([key("up"), key("down"), key("right"), key("left")])
    expect(parse("\x1bOA\x1bOD")).toEqual([key("up"), key("left")])
    expect(parse("\x1b[H\x1b[F\x1bOH\x1bOF")).toEqual([key("home"), key("end"), key("home"), key("end")])
    expect(parse("\x1b[1~\x1b[4~\x1b[7~\x1b[8~")).toEqual([key("home"), key("end"), key("home"), key("end")])
    expect(parse("\x1b[3~")).toEqual([key("delete")])
    expect(parse("\x1b[5~\x1b[6~")).toEqual([key("pageup"), key("pagedown")])
  })

  test("modified arrows and delete", () => {
    expect(parse("\x1b[1;5C")).toEqual([key("right", { ctrl: true })])
    expect(parse("\x1b[1;5D")).toEqual([key("left", { ctrl: true })])
    expect(parse("\x1b[1;2A")).toEqual([key("up", { shift: true })])
    expect(parse("\x1b[1;3B")).toEqual([key("down", { alt: true })])
    expect(parse("\x1b[3;5~")).toEqual([key("delete", { ctrl: true })])
  })

  test("alt+key", () => {
    expect(parse("\x1bx")).toEqual([key("x", { alt: true })])
    expect(parse("\x1b\r")).toEqual([key("enter", { alt: true })])
    expect(parse("\x1b\x7f")).toEqual([key("backspace", { alt: true })])
    expect(parse("\x1b\x1b[A")).toEqual([key("up", { alt: true })])
  })

  test("sequences split across chunks", () => {
    expectSplitSafe("\x1b[1;5Cab\x1b[3~", [
      key("right", { ctrl: true }),
      textKey("a"),
      textKey("b"),
      key("delete"),
    ])
    expectSplitSafe("\x1bOA", [key("up")])
  })

  test("capability replies are swallowed", () => {
    expect(parse("\x1b[?1u\x1b[?2026;2$y\x1b[?62;22c")).toEqual([])
  })
})

describe("escape timeout", () => {
  test("a lone ESC stays pending until flushed", () => {
    const p = new InputParser()
    expect(p.feed("\x1b")).toEqual([])
    expect(p.pending).toBe(true)
    expect(p.flush()).toEqual([key("escape")])
    expect(p.pending).toBe(false)
  })

  test("an ESC completed by the next chunk is a sequence, not Esc", () => {
    const p = new InputParser()
    expect(p.feed("\x1b")).toEqual([])
    expect(p.feed("[A")).toEqual([key("up")])
  })

  test("a lone ESC [ or ESC O at the timeout is Alt+[ or Alt+Shift+O", () => {
    const p = new InputParser()
    expect(p.feed("\x1b[")).toEqual([])
    expect(p.flush()).toEqual([key("[", { alt: true })])
    expect(p.feed("\x1bO")).toEqual([])
    expect(p.flush()).toEqual([key("o", { alt: true, shift: true })])
    expect(parse("\x1bX")).toEqual([key("x", { alt: true, shift: true })])
  })

  test("ESC ESC is Esc twice, unless a sequence follows", () => {
    const p = new InputParser()
    expect(p.feed("\x1b\x1b")).toEqual([])
    expect(p.flush()).toEqual([key("escape"), key("escape")])
    expect([...p.feed("\x1b\x1b\x1b"), ...p.flush()]).toEqual([key("escape"), key("escape"), key("escape")])
    expect(new InputParser().flush()).toEqual([])
    expect(parse("\x1b\x1bx")).toEqual([key("escape"), key("x", { alt: true })])
    expect(parse("\x1b\x1bOA")).toEqual([key("up", { alt: true })])
    expectSplitSafe("\x1b\x1b[1;5A", [key("up", { ctrl: true, alt: true })])
  })

  test("a sequence cut short is never typed out as text", () => {
    const p = new InputParser()
    expect(p.feed("a\x1b[?62;")).toEqual([textKey("a")])
    expect(p.flush()).toEqual([])
    expect(p.pending).toBe(true)
    expect(p.feed("22c")).toEqual([])
    expect(p.pending).toBe(false)
    expect(p.feed("\x1b[1;")).toEqual([])
    expect(p.flush()).toEqual([])
    expect(p.flush(true)).toEqual([])
    expect(p.pending).toBe(false)
    expect(p.feed("b")).toEqual([textKey("b")])
  })

  test("InputReader drops a sequence that never finishes, and keeps one that does", async () => {
    const term = new FakeTerminal()
    const events: InputEvent[] = []
    const reader = new InputReader(term, (e) => events.push(e), { escapeTimeoutMs: 5, sequenceTimeoutMs: 30 })
    reader.start()
    term.send("\x1b[?62;")
    await Bun.sleep(15)
    term.send("22c")
    term.send("\x1b[1;5")
    await Bun.sleep(15)
    expect(events).toEqual([])
    await Bun.sleep(40)
    term.send("x")
    expect(events).toEqual([textKey("x")])
    reader.stop()
  })

  test("long ESC runs do not recurse", () => {
    const p = new InputParser()
    const events = [...p.feed("\x1b".repeat(100_000)), ...p.flush()]
    expect(events.length).toBe(100_000)
    expect(events.every((e) => e.type === "key" && e.name === "escape")).toBe(true)
  })

  test("InputReader emits Esc after the timeout", async () => {
    const term = new FakeTerminal()
    const events: InputEvent[] = []
    const reader = new InputReader(term, (e) => events.push(e), { escapeTimeoutMs: 20 })
    reader.start()
    term.send("\x1b")
    expect(events).toEqual([])
    await Bun.sleep(40)
    expect(events).toEqual([key("escape")])
    term.send("\x1b")
    term.send("[B")
    await Bun.sleep(40)
    expect(events).toEqual([key("escape"), key("down")])
    reader.stop()
  })
})

describe("bracketed paste", () => {
  test("emits a single paste event with normalized newlines", () => {
    expect(parse("\x1b[200~line1\r\nline2\rline3\x1b[201~")).toEqual([
      { type: "paste", text: "line1\nline2\nline3" },
    ])
  })

  test("paste content is not interpreted as keys", () => {
    expect(parse("a\x1b[200~\x1b[A\x03\x1b[201~b")).toEqual([
      textKey("a"),
      { type: "paste", text: "\x1b[A\x03" },
      textKey("b"),
    ])
  })

  test("survives any chunk split, including inside the markers", () => {
    expectSplitSafe("\x1b[200~hi 你好\x1b[201~", [{ type: "paste", text: "hi 你好" }])
  })

  test("a huge paste is handed over in 4 MiB pieces", () => {
    const p = new InputParser()
    const big = "x".repeat(4 * 1024 * 1024)
    const first = p.feed(`\x1b[200~${big}`)
    expect(first).toEqual([{ type: "paste", text: big }])
    expect(p.pasting).toBe(true)
    expect(p.feed("tail\r\x1b[201~a")).toEqual([{ type: "paste", text: "tail\n" }, textKey("a")])
  })

  test("endPaste emits what an unterminated paste collected", () => {
    const p = new InputParser()
    expect(p.feed("\x1b[200~abc\x1b[20")).toEqual([])
    expect(p.endPaste()).toEqual([{ type: "paste", text: "abc" }])
    expect(p.pasting).toBe(false)
    expect(p.feed("d")).toEqual([textKey("d")])
    expect(p.endPaste()).toEqual([])
  })

  test("InputReader ends a paste after a pause without its end marker", async () => {
    const term = new FakeTerminal()
    const events: InputEvent[] = []
    const reader = new InputReader(term, (e) => events.push(e), { pasteTimeoutMs: 20 })
    reader.start()
    term.send("\x1b[200~abc")
    await Bun.sleep(10)
    term.send("def")
    await Bun.sleep(10)
    expect(events).toEqual([])
    await Bun.sleep(25)
    term.send("g")
    expect(events).toEqual([{ type: "paste", text: "abcdef" }, textKey("g")])
    reader.stop()
  })

  test("an unfinished paste is not pending for the Esc timeout", () => {
    const p = new InputParser()
    p.feed("\x1b[200~abc")
    expect(p.pending).toBe(false)
    expect(p.flush()).toEqual([])
    expect(p.feed("\x1b[201~")).toEqual([{ type: "paste", text: "abc" }])
  })
})

describe("kitty keyboard protocol", () => {
  test("modified enter and escape", () => {
    expect(parse("\x1b[13;2u")).toEqual([key("enter", { shift: true })])
    expect(parse("\x1b[13;5u")).toEqual([key("enter", { ctrl: true })])
    expect(parse("\x1b[27u")).toEqual([key("escape")])
    expect(parse("\x1b[9;2u")).toEqual([key("tab", { shift: true })])
    expect(parse("\x1b[127;5u")).toEqual([key("backspace", { ctrl: true })])
  })

  test("ctrl+letter and release events", () => {
    expect(parse("\x1b[97;5u")).toEqual([key("a", { ctrl: true })])
    expect(parse("\x1b[97;5:3u")).toEqual([])
  })

  test("functional keys in the private-use area are named keys, never text", () => {
    expect(parse("\x1b[57358u")).toEqual([key("capslock")])
    expect(parse("\x1b[57428u\x1b[57440u")).toEqual([key("media_play"), key("volume_mute")])
    expect(parse("\x1b[57414u\x1b[57417;5u")).toEqual([key("enter"), key("left", { ctrl: true })])
    expect(parse("\x1b[57376u\x1b[57398u")).toEqual([key("f13"), key("f35")])
    expect(parse("\x1b[57441;2u\x1b[57999u\x1b[1114112u\x1b[1u")).toEqual([])
  })

  test("keypad digits and operators type their characters", () => {
    expect(parse("\x1b[57399u\x1b[57408u\x1b[57409u\x1b[57413u")).toEqual([
      textKey("0"),
      textKey("9"),
      textKey("."),
      textKey("+"),
    ])
    expect(parse("\x1b[57400;5u")).toEqual([key("1", { ctrl: true })])
  })

  test("VS Code: measured bytes", () => {
    const [enter] = parse("\r")
    const [shiftEnter] = parse("\x1b[13;2u")
    const [ctrlEnter] = parse("\x1b[13;5u")
    expect(isSubmitKey(enter!)).toBe(true)
    expect(isNewlineKey(shiftEnter!)).toBe(true)
    expect(isNewlineKey(ctrlEnter!)).toBe(true)
    expect(isSubmitKey(shiftEnter!) || isSubmitKey(ctrlEnter!)).toBe(false)
    expect(parse("\x1b[13;3u")).toEqual([key("enter", { alt: true })])
    expect(parse("\x1b[27u")).toEqual([key("escape")])
  })
})

describe("win32-input-mode", () => {
  test("measured Windows Terminal values", () => {
    expect(parse(win32(13, 13, 0x20))).toEqual([key("enter")])
    expect(parse(win32(13, 13, 0x30))).toEqual([key("enter", { shift: true })])
    expect(parse(win32(13, 13, 0x28))).toEqual([key("enter", { ctrl: true })])
    expect(parse(win32(27, 27, 0x20))).toEqual([key("escape")])
  })

  test("text, arrows and ctrl+letter", () => {
    expect(parse(win32(65, 97, 0))).toEqual([textKey("a")])
    expect(parse(win32(65, 65, 0x10))).toEqual([textKey("A", { shift: true })])
    expect(parse(win32(37, 0, 0x100))).toEqual([key("left")])
    expect(parse(win32(39, 0, 0x08))).toEqual([key("right", { ctrl: true })])
    expect(parse(win32(67, 3, 0x08))).toEqual([key("c", { ctrl: true })])
    expect(parse(win32(88, 120, 0x02))).toEqual([key("x", { alt: true })])
    expect(parse(win32(32, 32, 0))).toEqual([textKey(" ")])
    expect(parse(win32(8, 8, 0))).toEqual([key("backspace")])
    expect(parse(win32(46, 0, 0))).toEqual([key("delete")])
  })

  test("AltGr characters are plain text", () => {
    expect(parse(win32(81, 64, 0x09))).toEqual([textKey("@")])
  })

  test("ignores key-up events and standalone modifiers", () => {
    expect(parse(win32(65, 97, 0, 0))).toEqual([])
    expect(parse(win32(16, 0, 0x10) + win32(17, 0, 0x08) + win32(18, 0, 0x02))).toEqual([])
  })

  test("repeat count", () => {
    expect(parse(win32(65, 97, 0, 1, 3))).toEqual([textKey("a"), textKey("a"), textKey("a")])
  })

  test("surrogate pairs arrive as two events and are joined", () => {
    expect(parse(win32(0, 0xd83d, 0) + win32(0, 0xde00, 0))).toEqual([textKey("😀")])
    expect(parse(win32(231, 0xd83d, 0), win32(231, 0xde00, 0))).toEqual([textKey("😀")])
  })

  test("IME text with vk=0", () => {
    expect(parse(win32(0, 0x4f60, 0) + win32(0, 0x597d, 0))).toEqual([textKey("你"), textKey("好")])
  })

  test("VS Code: sequences decode but every modifier is 0", () => {
    const shiftEnter = parse(win32(13, 13, 0))
    expect(shiftEnter).toEqual([key("enter")])
  })

  test("split across chunks", () => {
    expectSplitSafe(win32(13, 13, 0x30), [key("enter", { shift: true })])
  })

  test("paste with vk=0 markers and a body of real key events", () => {
    const spell = (t: string) => [...t].map((c) => win32(0, c.charCodeAt(0), 0)).join("")
    const body =
      win32(65, 97, 0) + win32(65, 97, 0, 0) + win32(16, 0, 0x10) + win32(13, 13, 0x20) + win32(66, 98, 0)
    expectSplitSafe(spell("\x1b[200~") + body + spell("\x1b[201~"), [{ type: "paste", text: "a\nb" }])
    expect(parse(spell("\x1b[200~a\rb\x1b[201~"))).toEqual([{ type: "paste", text: "a\nb" }])
  })

  test("vk=0 characters are re-parsed as raw input", () => {
    const seq = [..."\x1b[A"].map((c) => win32(0, c.charCodeAt(0), 0)).join("")
    expect(parse(seq)).toEqual([key("up")])
  })
})

describe("key helpers", () => {
  test("newline is shift+enter or ctrl+enter; submit is plain enter", () => {
    expect(isNewlineKey(key("enter", { shift: true }))).toBe(true)
    expect(isNewlineKey(key("enter", { ctrl: true }))).toBe(true)
    expect(isNewlineKey(key("enter"))).toBe(false)
    expect(isSubmitKey(key("enter"))).toBe(true)
    expect(isSubmitKey(key("enter", { shift: true }))).toBe(false)
    expect(isSubmitKey({ type: "paste", text: "\n" })).toBe(false)
  })

  test("legacy ctrl+enter is the newline key", () => {
    expect(isNewlineKey(parse("\n")[0]!)).toBe(true)
    expect(isSubmitKey(parse("\r")[0]!)).toBe(true)
  })
})

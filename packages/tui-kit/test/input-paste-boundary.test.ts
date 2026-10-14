import { expect, test } from "bun:test"
import { discardPendingPaste } from "../src/input-paste-control.ts"
import { type InputEvent, key, textKey } from "../src/keys.ts"
import { InputReader } from "../src/reader.ts"
import { FakeTerminal } from "../src/terminal.ts"

const BEGIN = "\x1b[200~"
const END = "\x1b[201~"

for (const origin of ["main", "owned"] as const) {
  test(`unfinished ${origin} paste is discarded through its closing marker, not interpreted as keys`, () => {
    const terminal = new FakeTerminal()
    const events: { owner: string; event: InputEvent }[] = []
    let owner: string = origin
    const reader = new InputReader(terminal, (event) => events.push({ owner, event }))
    reader.start()
    try {
      terminal.send(`${BEGIN}PRIVATE`)
      discardPendingPaste(terminal)
      owner = origin === "main" ? "owned" : "main"
      terminal.send("TAIL\r\x03\x1b[A")
      terminal.send(`${END}\r${BEGIN}safe${END}`)
      expect(events).toEqual([
        { owner, event: key("enter") },
        { owner, event: { type: "paste", text: "safe" } },
      ])
    } finally {
      reader.stop()
    }
  })
}

for (let split = 1; split < END.length; split++) {
  test(`discard retains closing marker split at ${split}, even across the paste timeout`, async () => {
    const terminal = new FakeTerminal()
    const events: InputEvent[] = []
    const reader = new InputReader(terminal, (event) => events.push(event), { pasteTimeoutMs: 5 })
    reader.start()
    try {
      terminal.send(`${BEGIN}PRIVATE${END.slice(0, split)}`)
      discardPendingPaste(terminal)
      await Bun.sleep(20)
      expect(events).toEqual([])
      terminal.send(`${END.slice(split)}\r`)
      expect(events).toEqual([key("enter")])
    } finally {
      reader.stop()
    }
  })
}

test("late tail stays quarantined after timeout and reader stop/start", async () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const reader = new InputReader(terminal, (event) => events.push(event), { pasteTimeoutMs: 5 })
  reader.start()
  try {
    terminal.send(`${BEGIN}PRIVATE`)
    discardPendingPaste(terminal)
    await Bun.sleep(20)
    terminal.send("LATE\rTAIL")
    await Bun.sleep(20)
    reader.stop()
    discardPendingPaste(terminal)
    reader.start()
    terminal.send(`MORE${END}\r`)
    expect(events).toEqual([key("enter")])
  } finally {
    reader.stop()
  }
})

test("constructor registers control for directly fed probe leftovers before start", () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const reader = new InputReader(terminal, (event) => events.push(event))
  try {
    reader.feed(`${BEGIN}PRIVATE`)
    discardPendingPaste(terminal)
    reader.feed(`${END}\r`)
    expect(events).toEqual([key("enter")])
  } finally {
    reader.stop()
  }
})

test("a reentrant boundary suppresses already parsed paste events without discarding new-owner input", () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  let changed = false
  const reader = new InputReader(terminal, (event) => {
    events.push(event)
    if (!changed && event.type === "key" && event.name === "enter") {
      changed = true
      discardPendingPaste(terminal)
      terminal.send(`${BEGIN}new owner${END}`)
    }
  })
  reader.start()
  try {
    terminal.send(`\r${BEGIN}PRIVATE${END}\r`)
    expect(events).toEqual([key("enter"), { type: "paste", text: "new owner" }, key("enter")])
  } finally {
    reader.stop()
  }
})

test("a boundary in nested dispatch also invalidates the outer queued paste", () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const reader = new InputReader(terminal, (event) => {
    events.push(event)
    if (event.type === "key" && event.text === "a") terminal.send("\r")
    if (event.type === "key" && event.name === "enter") discardPendingPaste(terminal)
  })
  reader.start()
  try {
    terminal.send(`a${BEGIN}PRIVATE${END}b`)
    expect(events).toEqual([textKey("a"), key("enter"), textKey("b")])
  } finally {
    reader.stop()
  }
})

test("boundary discards queued large paste pieces and quarantines the rest", () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const reader = new InputReader(terminal, (event) => {
    events.push(event)
    if (event.type === "key" && event.name === "enter") discardPendingPaste(terminal)
  })
  reader.start()
  try {
    terminal.send(`\r${BEGIN}${"x".repeat(4 * 1024 * 1024)}`)
    terminal.send("y".repeat(4 * 1024 * 1024))
    terminal.send(`PRIVATE${END}z`)
    expect(events).toEqual([key("enter"), textKey("z")])
  } finally {
    reader.stop()
  }
})

test("a boundary leaves large pieces already delivered to the origin alone", () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const reader = new InputReader(terminal, (event) => events.push(event))
  reader.start()
  try {
    const piece = "x".repeat(4 * 1024 * 1024)
    terminal.send(`${BEGIN}${piece}`)
    expect(events).toEqual([{ type: "paste", text: piece }])
    discardPendingPaste(terminal)
    terminal.send(`PRIVATE${END}\r`)
    expect(events).toEqual([{ type: "paste", text: piece }, key("enter")])
  } finally {
    reader.stop()
  }
})

test("win32 paste framing stays quarantined when the closing report is split across timeout", async () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const reader = new InputReader(terminal, (event) => events.push(event), { pasteTimeoutMs: 5 })
  const raw = (text: string) => [...text].map((ch) => `\x1b[0;0;${ch.charCodeAt(0)};1;0;1_`).join("")
  reader.start()
  try {
    terminal.send(raw(`${BEGIN}PRIVATE`))
    discardPendingPaste(terminal)
    terminal.send("\x1b[65;0;65;1;0;1_")
    const closing = raw(END)
    terminal.send(closing.slice(0, -1))
    await Bun.sleep(20)
    expect(events).toEqual([])
    terminal.send(`${closing.slice(-1)}\r`)
    expect(events).toEqual([key("enter")])
  } finally {
    reader.stop()
  }
})

test("a boundary without a pending paste does not suppress future pastes", () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  discardPendingPaste(terminal)
  const reader = new InputReader(terminal, (event) => events.push(event))
  reader.start()
  try {
    discardPendingPaste(terminal)
    terminal.send(`${BEGIN}safe${END}`)
    expect(events).toEqual([{ type: "paste", text: "safe" }])
  } finally {
    reader.stop()
  }
})

for (let split = 1; split < BEGIN.length; split++) {
  test(`opening marker split at ${split} is still origin-scoped across timeout and focus`, async () => {
    const terminal = new FakeTerminal()
    const events: InputEvent[] = []
    const reader = new InputReader(terminal, (event) => events.push(event), {
      escapeTimeoutMs: 2,
      sequenceTimeoutMs: 5,
      pasteTimeoutMs: 5,
    })
    reader.start()
    try {
      terminal.send(BEGIN.slice(0, split))
      discardPendingPaste(terminal)
      await Bun.sleep(20)
      terminal.send(`${BEGIN.slice(split)}PRIVATE${END}\r`)
      expect(events).toEqual([key("enter")])
    } finally {
      reader.stop()
    }
  })
}

test("a paste that timed out before the ownership boundary still quarantines its late tail", async () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const reader = new InputReader(terminal, (event) => events.push(event), { pasteTimeoutMs: 5 })
  reader.start()
  try {
    terminal.send(`${BEGIN}ORIGIN`)
    await Bun.sleep(20)
    expect(events).toEqual([{ type: "paste", text: "ORIGIN" }])
    events.length = 0
    discardPendingPaste(terminal)
    terminal.send(`LATE_PRIVATE${END}\r`)
    expect(events).toEqual([key("enter")])
  } finally {
    reader.stop()
  }
})

test("timeout before focus retains a partial end marker without swallowing fresh-owner input", async () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const reader = new InputReader(terminal, (event) => events.push(event), { pasteTimeoutMs: 5 })
  reader.start()
  try {
    terminal.send(`${BEGIN}ORIGIN\x1b[20`)
    await Bun.sleep(20)
    expect(events).toEqual([{ type: "paste", text: "ORIGIN" }])
    events.length = 0
    discardPendingPaste(terminal)
    terminal.send("1~safe\r")
    expect(events).toEqual([textKey("s"), textKey("a"), textKey("f"), textKey("e"), key("enter")])
  } finally {
    reader.stop()
  }
})

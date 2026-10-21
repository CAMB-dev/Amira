import { expect, test } from "bun:test"
import { discardPendingPaste } from "../src/input-paste-control.ts"
import { type InputEvent, key } from "../src/keys.ts"
import { InputReader } from "../src/reader.ts"
import { FakeTerminal } from "../src/terminal.ts"

const BEGIN = "\x1b[200~"
const END = "\x1b[201~"

function fixture() {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const states: boolean[] = []
  const reader = new InputReader(terminal, (event) => events.push(event), {
    escapeTimeoutMs: 2,
    sequenceTimeoutMs: 5,
    pasteTimeoutMs: 5,
    onPasteState: (pending) => states.push(pending),
  })
  reader.start()
  return { terminal, events, states, reader }
}

for (let split = 1; split < BEGIN.length; split++) {
  test(`paste framing split at ${split} reports no content and ends after the payload is delivered`, () => {
    const s = fixture()
    try {
      s.terminal.send(BEGIN.slice(0, split))
      s.terminal.send(`${BEGIN.slice(split)}private text`)
      expect(s.states).toEqual([true])
      expect(s.events).toEqual([])
      s.terminal.send(`${END.slice(0, 3)}`)
      expect(s.states).toEqual([true])
      s.terminal.send(END.slice(3))
      expect(s.events).toEqual([{ type: "paste", text: "private text" }])
      expect(s.states).toEqual([true, false])
    } finally {
      s.reader.stop()
    }
  })
}

test("an empty framed paste still reports both lifecycle transitions", () => {
  const s = fixture()
  try {
    s.terminal.send(`${BEGIN}${END}`)
    expect(s.states).toEqual([true, false])
    expect(s.events).toEqual([])
  } finally {
    s.reader.stop()
  }
})

for (const text of ["", "payload"]) {
  test(`paste timeout releases readiness with ${text ? "a payload" : "no payload"}`, async () => {
    const s = fixture()
    try {
      s.terminal.send(`${BEGIN}${text}`)
      expect(s.states).toEqual([true])
      await Bun.sleep(20)
      expect(s.states).toEqual([true, false])
      expect(s.events).toEqual(text ? [{ type: "paste", text }] : [])
    } finally {
      s.reader.stop()
    }
  })
}

test("discard ends paste readiness without releasing the quarantined tail", async () => {
  const s = fixture()
  try {
    s.terminal.send(`${BEGIN}private`)
    discardPendingPaste(s.terminal)
    expect(s.states).toEqual([true, false])
    await Bun.sleep(20)
    s.terminal.send(`tail${END}\r`)
    expect(s.states).toEqual([true, false])
    expect(s.events).toEqual([key("enter")])
  } finally {
    s.reader.stop()
  }
})

test("discarded partial opening markers do not reopen paste readiness for their quarantined tail", () => {
  const s = fixture()
  try {
    s.terminal.send(BEGIN.slice(0, 4))
    discardPendingPaste(s.terminal)
    expect(s.states).toEqual([true, false])
    s.terminal.send(`${BEGIN.slice(4)}private${END}\r`)
    expect(s.states).toEqual([true, false])
    expect(s.events).toEqual([key("enter")])
  } finally {
    s.reader.stop()
  }
})

test("paste-begin callbacks can discard the whole parsed chunk before payload dispatch", () => {
  const terminal = new FakeTerminal()
  const events: InputEvent[] = []
  const states: boolean[] = []
  const reader = new InputReader(terminal, (event) => events.push(event), {
    onPasteState(pending) {
      states.push(pending)
      if (pending) discardPendingPaste(terminal)
    },
  })
  reader.start()
  try {
    terminal.send(`${BEGIN}private${END}\r`)
    expect(states).toEqual([true, false])
    expect(events).toEqual([key("enter")])
  } finally {
    reader.stop()
  }
})

test("reentrant input keeps the newer unfinished paste pending after an older frame ends", () => {
  const terminal = new FakeTerminal()
  const states: boolean[] = []
  const reader = new InputReader(
    terminal,
    (event) => {
      if (event.type === "paste" && event.text === "outer") terminal.send(`${BEGIN}inner`)
    },
    { onPasteState: (pending) => states.push(pending) },
  )
  reader.start()
  try {
    terminal.send(`${BEGIN}outer${END}`)
    expect(states).toEqual([true])
    terminal.send(END)
    expect(states).toEqual([true, false])
  } finally {
    reader.stop()
  }
})

test("stop releases readiness and restart reports an unfinished paste again", () => {
  const s = fixture()
  try {
    s.terminal.send(BEGIN)
    s.reader.stop()
    expect(s.states).toEqual([true, false])
    s.reader.start()
    expect(s.states).toEqual([true, false, true])
    s.terminal.send(END)
    expect(s.states).toEqual([true, false, true, false])
  } finally {
    s.reader.stop()
  }
})

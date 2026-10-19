import { expect, test } from "bun:test"
import type { RemoteJson, RemoteMessage, RemoteReset } from "../../src/remote/protocol.ts"
import { RemoteReplay } from "../../src/remote/replay.ts"
import { ReplayJournal } from "../../src/server/journal.ts"

type Event = Extract<RemoteMessage, { kind: "event" }>
const payload = (text: string): RemoteJson => ({ type: "fixture", text })
const reset = (reason: RemoteReset["reason"], seq = 0): RemoteReset => ({
  v: 1,
  kind: "reset",
  daemonEpoch: "epoch",
  seq,
  reason,
  snapshot: {},
})

test("capture cut is atomic, copied, ordered and replay is marked without a live overlap", () => {
  const journal = new ReplayJournal()
  const first = journal.append(payload("before"))
  const live: Event[] = []
  const source = { state: "at cut" }
  const cut = journal.open(
    undefined,
    () => source,
    (event) => live.push(event),
  )
  source.state = "mutated later"
  const after = journal.append(payload("after"))
  expect(cut.watermark).toBe(first.seq)
  expect(cut.initial).toMatchObject([{ kind: "reset", seq: first.seq, snapshot: { state: "at cut" } }])
  expect(live).toEqual([after])
  cut.close()
  const resumed = journal.open(
    { daemonEpoch: journal.daemonEpoch, after: first.seq },
    () => {
      throw new Error("No reset")
    },
    () => {},
  )
  expect(resumed.initial).toEqual([{ ...after, replay: true }])
  resumed.close()
  journal.append(payload("closed"))
  expect(live).toHaveLength(1)
})

test("bounded replay explicitly resets expired, future, foreign epoch and degraded cursors", () => {
  const journal = new ReplayJournal({ events: 2, bytes: 1024 })
  for (let i = 0; i < 3; i++) journal.append(payload(`${i}`))
  const open = (daemonEpoch: string, after: number) => {
    const cut = journal.open(
      { daemonEpoch, after },
      () => ({}),
      () => {},
    )
    cut.close()
    return cut.initial
  }
  expect(open(journal.daemonEpoch, 0)).toMatchObject([{ kind: "reset", reason: "cursor_expired", seq: 3 }])
  expect(open(journal.daemonEpoch, 4)).toMatchObject([{ reason: "future_cursor" }])
  expect(open("old-epoch", 2)).toMatchObject([{ reason: "epoch_changed" }])
  expect(open(journal.daemonEpoch, 3)).toEqual([])
  expect(open(journal.daemonEpoch, 1)).toHaveLength(2)
  journal.invalidate()
  expect(open(journal.daemonEpoch, 3)).toMatchObject([{ reason: "capture_failed" }])
  expect(() => open(journal.daemonEpoch, -1)).toThrow()
})

test("byte overflow and an oversized single event never pretend an expired cursor is replayable", () => {
  const journal = new ReplayJournal({ events: 100, bytes: 20 })
  journal.append(payload("too large"))
  const cut = journal.open(
    { daemonEpoch: journal.daemonEpoch, after: 0 },
    () => ({}),
    () => {},
  )
  expect(cut.initial).toMatchObject([{ kind: "reset", reason: "cursor_expired" }])
  cut.close()
})

test("reentrant snapshot cuts fail explicitly; bad/reentrant subscribers cannot reorder healthy delivery", () => {
  const journal = new ReplayJournal()
  expect(() =>
    journal.open(
      undefined,
      () => {
        journal.append(null)
        return {}
      },
      () => {},
    ),
  ).toThrow("Reentrant")
  const a = journal.open(
    { daemonEpoch: journal.daemonEpoch, after: 1 },
    () => ({}),
    () => {
      throw new Error("sink")
    },
  )
  const seen: number[] = []
  const b = journal.open(
    { daemonEpoch: journal.daemonEpoch, after: 1 },
    () => ({}),
    (event) => {
      if (event.seq === 2) journal.append(null)
    },
  )
  const c = journal.open(
    { daemonEpoch: journal.daemonEpoch, after: 1 },
    () => ({}),
    (event) => seen.push(event.seq),
  )
  journal.append(null)
  expect(seen).toEqual([2, 3])
  a.close()
  b.close()
  c.close()
})

test("client ignores duplicates, detects gaps/epoch changes and acknowledges only applied cursors", () => {
  const seen: { replay: boolean; seq: number }[] = []
  let fail = false
  const replay = new RemoteReplay({
    reset: () => {},
    event: (_payload, options) => {
      if (fail) throw new Error("render failed")
      seen.push(options)
    },
  })
  const event = (seq: number, replay = false): Event => ({
    v: 1,
    kind: "event",
    daemonEpoch: "epoch",
    seq,
    replay,
    payload: null,
  })
  expect(() => replay.receive(event(1))).toThrow("snapshot")
  replay.receive(reset("fresh"))
  replay.receive(event(1, true))
  expect(replay.receive(event(1))).toBe(false)
  expect(() => replay.receive(event(3))).toThrow("gap")
  expect(replay.cursor?.after).toBe(1)
  fail = true
  expect(() => replay.receive(event(2))).toThrow("render failed")
  expect(replay.acknowledgement()).toMatchObject({ id: "epoch", seq: 1 })
  fail = false
  replay.receive(event(2))
  expect(seen).toEqual([
    { replay: true, seq: 1 },
    { replay: false, seq: 2 },
  ])
  expect(() => replay.receive({ ...event(3), daemonEpoch: "restarted" })).toThrow("snapshot")
  replay.receive({ ...reset("epoch_changed"), daemonEpoch: "restarted" })
  expect(replay.cursor).toEqual({ daemonEpoch: "restarted", after: 0 })
})

test("an authoritative future-cursor reset lowers the client cursor and accepts subsequent live events", () => {
  const journal = new ReplayJournal()
  for (let i = 0; i < 10; i++) journal.append(payload(`${i}`))
  const applied: RemoteJson[] = []
  const events: Event[] = []
  const client = new RemoteReplay(
    { reset: (snapshot) => applied.push(snapshot), event: (payload) => applied.push(payload) },
    { daemonEpoch: journal.daemonEpoch, after: 100 },
  )
  const cut = journal.open(
    { daemonEpoch: journal.daemonEpoch, after: 100 },
    () => ({ authoritative: true }),
    (event) => events.push(event),
  )
  try {
    const initial = cut.initial[0]!
    expect(initial.kind).toBe("reset")
    expect(client.receive(initial)).toBe(true)
    expect(applied).toEqual([{ authoritative: true }])
    expect(client.acknowledgement()).toMatchObject({ seq: cut.watermark })
    expect(client.cursor?.after).toBe(10)
    journal.append(payload("following"))
    expect(client.receive(events[0]!)).toBe(true)
    expect(client.cursor?.after).toBe(11)
    expect(client.acknowledgement()?.seq).toBeLessThanOrEqual(journal.watermark)
    expect(client.acknowledgement()).toMatchObject({ seq: 11 })
    expect(client.receive({ ...reset("fresh", 9), daemonEpoch: journal.daemonEpoch })).toBe(false)
    expect(client.cursor?.after).toBe(11)
  } finally {
    cut.close()
  }
})

test("degraded capture cannot hide the future-cursor reset needed to repair retained client state", () => {
  const journal = new ReplayJournal()
  for (let i = 0; i < 10; i++) journal.append(null)
  journal.invalidate()
  const replay = new RemoteReplay(
    { reset: () => {}, event: () => {} },
    { daemonEpoch: journal.daemonEpoch, after: 100 },
  )
  const cut = journal.open(
    { daemonEpoch: journal.daemonEpoch, after: 100 },
    () => ({}),
    () => {},
  )
  try {
    expect(cut.initial[0]).toMatchObject({ reason: "future_cursor" })
    expect(replay.receive(cut.initial[0]!)).toBe(true)
    expect(replay.acknowledgement()?.seq).toBe(cut.watermark)
  } finally {
    cut.close()
  }
})

test("unvalidated retained cursors cannot emit acknowledgements before the attachment repairs them", () => {
  const replay = new RemoteReplay({ reset: () => {}, event: () => {} }, { daemonEpoch: "epoch", after: 100 })
  expect(replay.cursor).toEqual({ daemonEpoch: "epoch", after: 100 })
  expect(replay.acknowledgement()).toBeUndefined()
  expect(replay.receive(reset("future_cursor", 10))).toBe(true)
  expect(replay.acknowledgement()).toMatchObject({ seq: 10 })
})

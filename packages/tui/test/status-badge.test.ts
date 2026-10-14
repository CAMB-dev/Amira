import { expect, test } from "bun:test"
import { AGENT_STATUS_BADGES, type AgentStatusState, agentStatusState } from "@amira/api"
import { defaultTheme, monoTheme, Spinner, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { statusBadge, styledStatusBadge } from "../src/status-badge.ts"

const states = Object.keys(AGENT_STATUS_BADGES) as AgentStatusState[]

test("all agent states have a distinct symbol + word, even without color", () => {
  for (const state of states) {
    const badge = AGENT_STATUS_BADGES[state]
    const text = `${badge.symbol} ${badge.label}`
    expect(statusBadge(state)).toEqual([{ kind: badge.role, text }])
    expect(styledStatusBadge(state, defaultTheme)).toBe(defaultTheme[badge.role](text))
    expect(stripAnsi(styledStatusBadge(state, monoTheme))).toBe(text)
  }
  expect(agentStatusState("running")).toBe("working")
  expect(agentStatusState("error")).toBe("failed")
  expect(agentStatusState("aborted")).toBe("stopped")
  for (const state of ["queued", "idle", "paused", "done"] as const)
    expect(agentStatusState(state)).toBe(state)
})

test("working uses the shared spinner; other states do not animate", () => {
  const spinner = new Spinner()
  expect(statusBadge("working", spinner.glyph)[0]?.text).toBe("⠋ working")
  spinner.tick()
  expect(statusBadge("working", spinner.glyph)[0]?.text).toBe("⠙ working")
  for (const state of states.filter((state) => state !== "working"))
    expect(statusBadge(state, spinner.glyph)).toEqual(statusBadge(state))
})

test("optional padded badges align names at a seven-cell state column", () => {
  const before = { ...glyphs }
  try {
    for (const ascii of [false, true]) {
      setGlyphs(ascii ? { pointer: ">" } : {})
      for (const state of states) {
        const parts = statusBadge(state, "⠋", { pad: true })
        const text = parts.map((part) => part.text).join("")
        expect(text.endsWith(state.padEnd(7))).toBe(true)
        expect(visibleWidth(text)).toBe(9)
        expect(stripAnsi(styledStatusBadge(state, monoTheme, "⠋", { pad: true }))).toBe(text)
      }
    }
    expect(statusBadge("done")[0]?.text).toBe("v done")
  } finally {
    setGlyphs(before)
  }
})

test("legacy custom glyphs remain supported; explicit badge glyphs take precedence", () => {
  const before = { ...glyphs }
  try {
    setGlyphs({ subagentDone: "V", subagentFailed: "X", subagentAborted: "O" })
    expect(statusBadge("done")[0]?.text).toBe("V done")
    expect(statusBadge("failed")[0]?.text).toBe("X failed")
    expect(statusBadge("stopped")[0]?.text).toBe("O stopped")
    setGlyphs({ subagentDone: "V", statusDone: "+" })
    expect(statusBadge("done")[0]?.text).toBe("+ done")
  } finally {
    setGlyphs(before)
  }
})

test("ASCII themes get readable badges and matching animated ASCII frames", () => {
  const before = { ...glyphs }
  try {
    setGlyphs({ pointer: ">" })
    for (const state of states.filter((state) => state !== "working"))
      expect(statusBadge(state)[0]?.text).toBe(`${AGENT_STATUS_BADGES[state].ascii} ${state}`)
    expect(statusBadge("working", "⠋")[0]?.text).toBe("| working")
    expect(statusBadge("working", "⠙")[0]?.text).toBe("/ working")
    setGlyphs({ statusIdle: "O", statusStopped: "STOP" })
    expect(statusBadge("idle")[0]?.text).toBe("O idle")
    expect(statusBadge("stopped")[0]?.text).toBe("STOP stopped")
  } finally {
    setGlyphs(before)
  }
})

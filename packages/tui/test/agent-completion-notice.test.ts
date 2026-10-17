import { expect, test } from "bun:test"
import { AGENT_STATUS_BADGES } from "@amira/api"
import { defaultTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { userLines } from "../src/format.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { messageNoticeLines } from "../src/message-notice.ts"

test("legacy title glyphs cannot turn a failed completion into a successful badge", () => {
  const display = { origin: "subagent", text: "◆ Check ✓ examples ✗ explorer · 2s · 3 tok" }
  const rows = userLines(defaultTheme, { role: "user", content: [], display }, 80)
  expect(rows[0]).toContain(defaultTheme.error("✗ failed"))
  expect(stripAnsi(rows[0]!)).toBe("✗ failed Check ✓ examples · explorer · 2s · 3 tok")
  const ambiguous = { origin: "subagent", text: "◆ Check ✓ fixture · 2s ✗ explorer · 2s · 3 tok" }
  expect(userLines(defaultTheme, { role: "user", content: [], display: ambiguous }, 80)[0]).not.toContain(
    defaultTheme.success("✓ done"),
  )
})

test("legacy clean-stop notes use the same result-aware mapping as new notices", () => {
  const display = {
    origin: "subagent",
    text: "◆ Limit helper ✓ explorer · 1s · 0 tok · turn limit reached",
  }
  const rows = userLines(defaultTheme, { role: "user", content: [], display }, 100)
  expect(rows[0]).toContain(defaultTheme.warning("‖ stopped"))
  expect(stripAnsi(rows[0]!)).toBe("‖ stopped Limit helper · explorer · 1s · 0 tok · turn limit reached")
})

test("complete notice rows fit even when the badge is wider than the supplied width", () => {
  const before = { ...glyphs }
  try {
    for (const overrides of [{}, { pointer: ">" }, { statusStopped: "STOP" }]) {
      setGlyphs(overrides)
      for (const status of ["done", "failed", "stopped"] as const) {
        const display = { origin: "subagent", text: "X", notices: [{ status, text: "X" }] }
        for (const width of [0, 1, 2, 8, 12, 28])
          expect(
            userLines(defaultTheme, { role: "user", content: [], display }, width).every(
              (row) => visibleWidth(row) <= width,
            ),
          ).toBe(true)
      }
    }
  } finally {
    setGlyphs(before)
  }
})

for (const ascii of [false, true]) {
  for (const status of ["done", "failed", "stopped"] as const) {
    test(`background completion is a root ${status} badge with color and word (ASCII=${ascii})`, () => {
      const before = { ...glyphs }
      try {
        if (ascii) setGlyphs({ pointer: ">", separator: "|" })
        const text = `Do look · explorer · 2s · 3 tok${status === "done" ? "" : " · provider stopped unexpectedly"}`
        const renderedText = text.replaceAll(" · ", ` ${glyphs.separator} `)
        const message = {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Full report for the model" }],
          display: { origin: "subagent", text, notices: [{ status, text }] },
        }
        const rows = userLines(defaultTheme, message, 120)
        const badge = AGENT_STATUS_BADGES[status]
        const label = `${ascii ? badge.ascii : badge.symbol} ${badge.label}`
        expect(rows).toEqual([`${defaultTheme[badge.role](label)} ${defaultTheme.muted(renderedText)}`])
        expect(stripAnsi(rows[0]!)).toBe(`${label} ${renderedText}`)
        expect(stripAnsi(rows[0]!)).not.toMatch(/^[└├]/)
        expect(rows.join("\n")).not.toContain("Full report for the model")
      } finally {
        setGlyphs(before)
      }
    })

    test(`host notice renderer styles semantic and legacy ${status} rows (ASCII=${ascii})`, () => {
      const before = { ...glyphs }
      try {
        if (ascii) setGlyphs({ pointer: ">", separator: "|" })
        const reason = status === "done" ? "" : " · HTTP 429: slow down"
        const text = `Do look · explorer · 2s · 3 tok${reason}`
        const legacy = { done: "✓", failed: "✗", stopped: "⊘" }[status]
        const semantic = { text, origin: "subagent", notices: [{ status, text }] }
        const stored = {
          text: `◆ Do look ${legacy} explorer · 2s · 3 tok${reason}`,
          origin: "subagent",
        }
        const badge = AGENT_STATUS_BADGES[status]
        const label = `${ascii ? badge.ascii : badge.symbol} ${badge.label}`
        const expected = [
          `${defaultTheme[badge.role](label)} ${defaultTheme.muted(text.replaceAll(" · ", ` ${glyphs.separator} `))}`,
        ]
        expect(messageNoticeLines(defaultTheme, semantic)).toEqual(expected)
        expect(messageNoticeLines(defaultTheme, stored)).toEqual(expected)
      } finally {
        setGlyphs(before)
      }
    })
  }
}

test("mixed completion batches preserve each state, detail rows, and bounded wrapping", () => {
  const notices = [
    { status: "done" as const, text: "First · explorer · 2s · 3 tok" },
    { status: "failed" as const, text: "Second · coder · 2s · 3 tok · provider exploded" },
    { text: "  changes kept: 3 files · /tmp/changes.patch" },
    { status: "stopped" as const, text: "Third · reviewer · 2s · 3 tok · its commander finished" },
  ]
  const display = { text: "ignored fallback", origin: "subagent", notices }
  const rows = messageNoticeLines(defaultTheme, display, 28)
  const plain = rows.map(stripAnsi)
  expect(plain.filter((row) => /^(✓ done|✗ failed|‖ stopped) /.test(row))).toHaveLength(3)
  expect(plain.join("\n")).toContain("changes kept:")
  expect(plain.every((row) => visibleWidth(row) <= 28)).toBe(true)
  expect(
    plain.filter((row) => !/^(✓ done|✗ failed|‖ stopped) /.test(row)).every((row) => row.startsWith("  ")),
  ).toBe(true)
})

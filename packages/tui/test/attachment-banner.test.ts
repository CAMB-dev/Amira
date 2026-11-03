import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { attachmentBanner, attachmentStatus, plainLabel } from "../src/app/attachment-banner.ts"

test("a viewer gets one warning row naming the controller; a controller gets none", () => {
  const [row] = attachmentBanner(
    { role: "viewer", viewers: 0, controller: "amira-tui 0.1.0 (linux-x64)" },
    defaultTheme,
    120,
  )
  expect(stripAnsi(row!)).toContain("Read-only viewer · amira-tui 0.1.0 (linux-x64) controls this workspace")
  expect(stripAnsi(row!)).toContain("/take to take control")
  expect(row).toContain(defaultTheme.warning("x").split("x")[0]!)
  expect(attachmentBanner({ role: "controller", viewers: 3 }, defaultTheme, 120)).toEqual([])
  expect(attachmentBanner(undefined, defaultTheme, 120)).toEqual([])
  const none = attachmentBanner({ role: "viewer", viewers: 1 }, defaultTheme, 120)
  expect(stripAnsi(none[0]!)).toContain("no client controls this workspace")
  const taken = attachmentBanner(
    { role: "viewer", viewers: 0, notice: "Control was taken by amira-gui (win32-x64)." },
    defaultTheme,
    40,
  )
  expect(visibleWidth(taken[0]!)).toBeLessThanOrEqual(40)
  expect(stripAnsi(taken[0]!)).toContain("Control was taken")
})

test("status: a viewer replaces Remote connected, a controller always counts its viewers", () => {
  expect(attachmentStatus({ role: "viewer", viewers: 2 }, "connected").map((item) => item.text)).toEqual([
    "Remote viewer",
  ])
  expect(attachmentStatus({ role: "controller", viewers: 1 }, "connected").map((item) => item.text)).toEqual([
    "Remote connected",
    "1 viewer",
  ])
  expect(
    attachmentStatus({ role: "controller", viewers: 3 }, "reconnecting").map((item) => item.text),
  ).toEqual(["Remote reconnecting", "3 viewers"])
  expect(attachmentStatus(undefined, "connected")).toMatchObject([
    { text: "Remote connected", tone: "muted" },
  ])
})

test("client text from other processes cannot steer the terminal", () => {
  const banner = attachmentBanner(
    { role: "viewer", viewers: 0, controller: "evil\u001b[2J\u001b]0;title\u0007\u009b31m name\u202E" },
    defaultTheme,
    200,
  )
  expect(stripAnsi(banner[0]!)).toContain("evil[2J]0;title31m name controls")
  expect(plainLabel("evil\u001b[2J\u001b]0;title\u0007\u009b31m\n name")).toBe("evil[2J]0;title31m name")
  expect(plainLabel("x".repeat(200))).toHaveLength(96)
  // The soft hyphen and the Arabic letter mark are invisible format characters too.
  expect(plainLabel("ami­ra؜ gui")).toBe("amira gui")
})

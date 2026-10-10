import { expect, test } from "bun:test"

const formatModule = new URL("../src/format.ts", import.meta.url).href
const themeModule = new URL("../../tui-kit/src/index.ts", import.meta.url).href

/** A fresh process lets each preference initialize the cached formatter without leaking mocks. */
function capture(cycle: string | undefined, unavailable = false, hour = 20) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `
        const DateTimeFormat = Intl.DateTimeFormat
        Intl.DateTimeFormat = function(locale, options) {
          if (!locale && options.minute === undefined) {
            if (${unavailable}) throw new Error("locale data unavailable")
            return { resolvedOptions: () => ({ hourCycle: ${JSON.stringify(cycle) ?? "undefined"} }) }
          }
          const formatter = new DateTimeFormat(locale ?? "en-US", options)
          return { format: (at) => formatter.format(at).replace(/ /g, "\\u202f") }
        }
        const { localClock, timestampRoom, userLines } = await import(${JSON.stringify(formatModule)})
        const { defaultTheme, stripAnsi, visibleWidth } = await import(${JSON.stringify(themeModule)})
        const at = new Date(2026, 9, 10, ${hour}, 9).getTime()
        const rows = userLines(defaultTheme, {
          role: "user", content: [{ type: "text", text: "x".repeat(40) }],
        }, 30, at).map(stripAnsi)
        console.log(JSON.stringify({
          clock: localClock(at), room: timestampRoom(30, at), rows,
          widths: rows.map(visibleWidth),
          narrowRoom: timestampRoom(15, at), absentRoom: timestampRoom(30, undefined),
          infiniteRoom: timestampRoom(Infinity, at) === Infinity,
        }))
      `,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  return JSON.parse(result.stdout.toString())
}

for (const cycle of ["h11", "h12", "h23", "h24"]) {
  test(`clock respects the system's ${cycle} hour-cycle preference`, () => {
    const twelve = cycle === "h11" || cycle === "h12"
    const frame = capture(cycle)
    expect(frame.clock).toBe(twelve ? "8:09 PM" : "20:09")
    expect(frame.room).toBe(twelve ? 19 : 21)
  })
}

test("clock defaults to 12-hour time when the hour cycle or locale data is unavailable", () => {
  expect(capture(undefined).clock).toBe("8:09 PM")
  expect(capture(undefined, true).clock).toBe("8:09 PM")
})

test("a longer 12-hour clock reserves its actual cells plus both two-cell insets", () => {
  const frame = capture("h12", false, 22)
  expect(frame.clock).toBe("10:09 PM")
  expect(frame.room).toBe(18)
  expect(frame.rows).toEqual([`  › ${"x".repeat(14)}  10:09 PM  `, `    ${"x".repeat(26)}`])
  expect(frame.widths).toEqual([30, 30])
  expect(frame.narrowRoom).toBe(15)
  expect(frame.absentRoom).toBe(30)
  expect(frame.infiniteRoom).toBe(true)
})

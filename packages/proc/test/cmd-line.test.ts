import { expect, setDefaultTimeout, test } from "bun:test"
import { cmdCommandLine, quoteArg } from "../src/cmd-line.ts"
import { runCommand } from "../src/index.ts"

setDefaultTimeout(60_000)
const onWindows = process.platform === "win32"
const opts = () => ({ cwd: process.cwd(), timeoutMs: 30_000, signal: new AbortController().signal })

/** Arguments cmd.exe or the C runtime would mangle if they were not quoted and escaped. */
const awkward = [
  "plain",
  "with space",
  "",
  'a"b',
  "trail\\",
  "tr ail\\",
  'x\\"y',
  "a&b|c<d>e^f",
  "%PATH%",
  "%%PATH%%",
  "!PATH!",
  "(paren) [br] {c}",
  "semi;comma, eq=",
  "\\\\server\\share\\",
  "héllo 你好 🎉",
  "*?`'",
  '"&"',
  "^",
  '\\"\\\\"',
]

test("quotes only when needed, doubling backslashes only before a quote", () => {
  expect(quoteArg("C:\\a\\b")).toBe("C:\\a\\b")
  expect(quoteArg("")).toBe('""')
  expect(quoteArg("a b\\")).toBe('"a b\\\\"')
  expect(quoteArg('a\\"b')).toBe('"a\\\\\\"b"')
})

test("escapes every cmd metacharacter, quotes included", () => {
  expect(cmdCommandLine(["C:\\x y\\p.exe", "a&b", "%v%"])).toBe('^"C:\\x^ y\\p.exe^" a^&b ^%v^%')
})

test.if(onWindows)("arguments reach the program intact through cmd", async () => {
  const script = "console.log(JSON.stringify(process.argv.slice(1)))"
  const run = await runCommand([process.execPath, "-e", script, ...awkward], { ...opts(), viaCmd: true })
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(run.output)).toEqual(awkward)
})

test.if(onWindows)("through cmd, a gated command runs after the gate and keeps its exit code", async () => {
  const run = await runCommand(
    [process.execPath, "-e", "console.log(process.env.AMIRA_GATE); process.exit(7)"],
    {
      ...opts(),
      gated: true,
      viaCmd: true,
    },
  )
  expect(run).toMatchObject({ exitCode: 7, contained: true })
  expect(run.output.trim()).toBe("go")
})

test("a gate line is sent to a directly started program", async () => {
  const script = "process.stdin.once('data', (d) => { console.log(String(d).trim()); process.exit(0) })"
  const run = await runCommand([process.execPath, "-e", script], {
    ...opts(),
    gated: true,
    gateLine: "payload",
  })
  expect(run.output.trim()).toBe("payload")
})

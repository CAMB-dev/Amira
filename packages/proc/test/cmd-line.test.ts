import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnExit } from "../../../scripts/spawn-test.ts"
import { cmdArgv, cmdCommandLine, quoteArg } from "../src/cmd-line.ts"
import { ownSpawn, runCommand, stopCommands } from "./spawn-fixture.ts"

afterEach(stopCommands, SPAWN_TEST_TIMEOUT_MS)

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
  expect(cmdCommandLine(["C:\\x y\\p.exe", "a&b", "%v%", "k=v"])).toBe('^"C:\\x^ y\\p.exe^" a^&b ^%v^% k^=v')
})

test.if(onWindows)(
  "a line too long for cmd falls back to a direct spawn",
  async () => {
    const long = "x".repeat(9000)
    expect(
      cmdArgv([process.execPath, "-e", "1", long], { cwd: process.cwd(), env: process.env, gated: false }),
    ).toBeUndefined()
    const run = await runCommand([process.execPath, "-e", "console.log(process.argv[1].length)", long], {
      ...opts(),
      viaCmd: true,
    })
    expect(run.output.trim()).toBe("9000")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(onWindows)(
  "an argument with a line break falls back to a direct spawn and loses nothing",
  async () => {
    // cmd.exe ends its command line at CR or LF: everything after it would vanish, with exit 0.
    const env = process.env
    for (const broken of ["line1\nline2", "line1\rline2", "a\r\nb"]) {
      expect(
        cmdArgv([process.execPath, "-e", "1", broken], { cwd: process.cwd(), env, gated: false }),
      ).toBeUndefined()
      expect(
        cmdArgv([process.execPath, "-e", "1", broken], { cwd: process.cwd(), env, gated: true }),
      ).toBeUndefined()
    }
    const args = ["[%s]", "line1\nline2", "a\r\nb", "after"]
    const script = "console.log(JSON.stringify(process.argv.slice(1)))"
    const run = await runCommand([process.execPath, "-e", script, ...args], { ...opts(), viaCmd: true })
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.output)).toEqual(args)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(onWindows)(
  "a program path containing = and spaces runs through cmd",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "amira a=b "))
    try {
      const exe = join(dir, "hostname.exe")
      await copyFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), exe)
      const direct = await runCommand([exe], opts())
      const run = await runCommand([exe], { ...opts(), viaCmd: true })
      expect(run.exitCode).toBe(0)
      expect(run.output.trim()).toBe(direct.output.trim())
      expect(run.output.trim()).not.toBe("")
    } finally {
      await stopCommands()
      await rm(dir, { recursive: true, force: true })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(onWindows)(
  "the gate holds even when command extensions are turned off before our flags",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "amira-gate-"))
    try {
      const marker = join(dir, "ran")
      const script = `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`
      const argv = cmdArgv([process.execPath, "-e", script], { cwd: dir, env: process.env, gated: true })!
      // As if the registry disabled extensions: /e:off comes first, our /e:on must win.
      const proc = ownSpawn(
        Bun.spawn([argv[0]!, "/e:off", ...argv.slice(1)], {
          cwd: dir,
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
          windowsVerbatimArguments: true,
        }),
      )
      await Bun.sleep(1500)
      expect(existsSync(marker)).toBe(false)
      proc.stdin.write("go\n")
      await proc.stdin.end()
      expect(await waitForSpawnExit(proc, "cmd gate")).toBe(0)
      expect(existsSync(marker)).toBe(true)
    } finally {
      await stopCommands()
      await rm(dir, { recursive: true, force: true })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(onWindows)(
  "arguments reach the program intact through cmd",
  async () => {
    const script = "console.log(JSON.stringify(process.argv.slice(1)))"
    const run = await runCommand([process.execPath, "-e", script, ...awkward], { ...opts(), viaCmd: true })
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.output)).toEqual(awkward)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(onWindows)(
  "through cmd, a gated command runs after the gate and keeps its exit code",
  async () => {
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
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a gate line is sent to a directly started program",
  async () => {
    const script = "process.stdin.once('data', (d) => { console.log(String(d).trim()); process.exit(0) })"
    const run = await runCommand([process.execPath, "-e", script], {
      ...opts(),
      gated: true,
      gateLine: "payload",
    })
    expect(run.output.trim()).toBe("payload")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

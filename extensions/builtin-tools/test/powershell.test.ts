import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import "../../../packages/core/src/index.ts"
import { existsSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { prepareCommand, runCommand } from "../../../packages/proc/src/index.ts"
import { createPowershellTool, powershellDescription } from "../src/bash.ts"
import {
  encodeCommand,
  encodePowerShell,
  gatedPowerShell,
  POWERSHELL_SCRIPT,
  powershellEdition,
  powershellStartDir,
} from "../src/powershell.ts"
import { StandbyPool } from "../src/standby.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

// PowerShell starts slowly, and antivirus can stall spawns for seconds.
setDefaultTimeout(120_000)
const onWindows = process.platform === "win32"

test("the script reads the command from the gate line before running it", () => {
  const gate = POWERSHELL_SCRIPT.indexOf("[Console]::In.ReadLine()")
  expect(gate).toBeGreaterThan(0)
  expect(POWERSHELL_SCRIPT.indexOf("__amira_open $__amira")).toBeGreaterThan(gate)
  // Before the gate the process is not yet known to be in its job: it must start nothing.
  expect(POWERSHELL_SCRIPT.slice(0, gate)).not.toMatch(/Start-Process|Invoke-Expression|\.exe|&\s*\$/i)
  expect(POWERSHELL_SCRIPT).toContain("UTF8Encoding")
  expect(Buffer.from(encodePowerShell("é"), "base64").toString("utf16le")).toBe("é")
  expect(encodeCommand("你好\nx", "C:\\a b\nc")).not.toContain("\n")
  // Working directory and command are base64 each, so neither can end up in script text.
  const [dir, cmd, extra] = encodeCommand("x y", "C:\\a b").split(" ")
  expect(extra).toBeUndefined()
  expect(Buffer.from(dir ?? "", "base64").toString()).toBe("C:\\a b")
  expect(Buffer.from(cmd ?? "", "base64").toString()).toBe("x y")
  // Every PowerShell process starts outside the session directory.
  const project = "D:\\work\\project"
  const start = gatedPowerShell("pwsh").command("x", project).cwd
  expect(start).toBe(powershellStartDir())
  expect(start).not.toBe(project)
})

test("the description names the edition and its syntax", () => {
  expect(powershellEdition("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("PowerShell 7 (pwsh)")
  const legacy = powershellDescription("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe").join(
    "\n",
  )
  expect(legacy).toContain("Windows PowerShell 5.1")
  expect(legacy).toContain("`cd dir; cmd`")
  expect(legacy).not.toContain("cd dir &&")
  expect(legacy).toContain("$LASTEXITCODE")
})

/** Both editions when present, so each is tested whichever one the tool would pick. */
const editions = onWindows
  ? [
      Bun.which("pwsh"),
      Bun.which("powershell") ??
        `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ].filter((p): p is string => !!p)
  : []

for (const path of editions) {
  describe(powershellEdition(path), () => {
    const tool = createPowershellTool(path)
    const run = (command: string, signal?: AbortSignal) =>
      tool.execute({ command }, makeCtx(process.cwd(), signal))
    const native = async (command: string) => {
      const p = Bun.spawn([path, "-NoProfile", "-NonInteractive", "-Command", command], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
      const [output, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
      return { output: output.trimEnd().replaceAll("\r\n", "\n"), code }
    }

    test("runs with UTF-8 output", async () => {
      const r = await run('Write-Output "你好 héllo"; $PSVersionTable.PSEdition')
      expect(r.isError).toBeFalsy()
      expect(textOf(r)).toContain("你好 héllo")
      expect(textOf(r)).toContain("Exit code: 0")
    })

    test("reports native exit codes and failed statements as readable text", async () => {
      expect(textOf(await run("cmd /c exit 3"))).toContain("Exit code: 3")
      const failed = await run(String.raw`Get-Item C:\definitely\not\here`)
      expect(failed.isError).toBe(true)
      const text = textOf(failed)
      expect(text).toContain("Exit code: 1")
      expect(text).toContain("Get-Item: ")
      expect(text).toContain(String.raw`C:\definitely\not\here`)
      expect(text).not.toContain("CLIXML")
    })

    test("all streams come out as plain text, without CLIXML or ANSI escapes", async () => {
      const r = await run(
        "Write-Error boom; Write-Warning careful; Write-Host hi; Write-Progress -Activity a -PercentComplete 50; Write-Output done",
      )
      const text = textOf(r)
      expect(text).toContain("boom")
      expect(text).toContain("careful")
      expect(text).toContain("hi")
      expect(text).toContain("done\n\nExit code: 0")
      expect(text).not.toContain("CLIXML")
      expect(text).not.toContain("\x1b[")
    })

    test("native stderr is passed through as plain lines", async () => {
      const r = await run('cmd /c "echo from-stderr 1>&2"')
      expect(textOf(r)).toBe("from-stderr\n\nExit code: 0")
    })

    test("a syntax error is reported readably", async () => {
      const r = await run('Write-Output "unterminated')
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('Write-Output "unterminated')
      expect(textOf(r)).toContain("Exit code: 1")
    })

    test("a top-level return keeps the failure of the statement before it", async () => {
      expect(textOf(await run(String.raw`Get-Item C:\nope\x; return`))).toContain("Exit code: 1")
      expect(textOf(await run("Write-Output x; return; Write-Output y"))).toBe("x\n\nExit code: 0")
    })

    test("a top-level return exits on $? as pwsh -Command does, not on errors handled before it", async () => {
      const exit = async (command: string) => /Exit code: (\d+)$/.exec(textOf(await run(command)))?.[1]
      const missing = String.raw`Get-Item C:\definitely\not\here`
      const handled = await run(
        "try { throw 'expected' } catch { Write-Output handled }; Write-Output done; return",
      )
      expect(handled.isError).toBeFalsy()
      expect(textOf(handled)).toMatch(/^handled\r?\ndone\n\nExit code: 0$/)
      expect(await exit(`${missing} -ErrorAction SilentlyContinue; Write-Output recovered; return`)).toBe("0")
      expect(await exit(`${missing}; $x = 1; return`)).toBe("0")
      expect(await exit(`function f { ${missing} }; f; return`)).toBe("0")
      expect(await exit(`if ($true) { ${missing}; return }`)).toBe("1")
      // A returned value leaves $? as it was; a returned pipeline sets it.
      expect(await exit(`${missing}; return 'x'`)).toBe("1")
      expect(await exit(`${missing}; return (Write-Output x)`)).toBe("0")
      expect(await exit(`Write-Output a; return (${missing})`)).toBe("1")
      // Only the command's own top level: a return inside a script block or function is its own.
      expect(textOf(await run(`${missing}; & { return }; Write-Output z`))).toContain("z\n\nExit code: 0")
      // What a return records does not move the lines after it: an error there names its own line.
      expect(textOf(await run("if ($false) { return (Write-Output x) }\nthrow 'boom'"))).toMatch(
        /:2 \S+:\s*1\r?\n\+ throw 'boom'/,
      )
    })

    test("exit and throw inside the command are honoured", async () => {
      expect(textOf(await run("Write-Output before; exit 7; Write-Output after"))).toBe(
        "before\n\nExit code: 7",
      )
      const thrown = textOf(await run('Write-Output a; throw "stop here"; Write-Output b'))
      expect(thrown).toContain("stop here")
      expect(thrown).not.toContain("\nb\n")
      expect(thrown).toContain("Exit code: 1")
    })

    test("a returning try records the status after its finally blocks", async () => {
      for (const [command, code] of [
        ["try { Write-Error bad; return } finally { Write-Output cleanup }", 0],
        ["try { return } finally { Write-Error bad }", 1],
        ["try { Write-Error bad; return } finally {}", 1],
        ["try { Write-Error bad; return 'value' } finally {}", 1],
        ["try { return (Write-Output value) } finally { Write-Error bad }", 1],
        ["try { return (Write-Error bad) } finally { Write-Output cleanup }", 0],
        ["try { try { return } finally { Write-Output cleanup } } finally { Write-Error bad }", 1],
        ["try { try { return } finally { Write-Error bad } } finally { Write-Output cleanup }", 0],
        ["try { try { return } finally { Write-Error bad } } finally {}", 1],
      ] as const) {
        expect((await native(command)).code).toBe(code)
        const r = await run(command)
        expect(textOf(r)).toEndWith(`Exit code: ${code}`)
        expect(r.isError).toBe(code !== 0)
      }
    })

    test("a trap return preserves the edition's native status", async () => {
      for (const body of [
        "return",
        "return 'handled'",
        "Write-Output handled; return",
        "return (Write-Output handled)",
        "Write-Error again; return",
      ]) {
        const command = `trap { ${body} }; throw 'bad'; Write-Output unreachable`
        const { output, code } = await native(command)
        const r = await run(command)
        expect(textOf(r)).toEndWith(`Exit code: ${code}`)
        if (output) expect(textOf(r)).toContain(output)
        expect(textOf(r)).not.toContain("unreachable")
        expect(r.isError).toBe(code !== 0)
      }
    })

    test("named blocks run and report their final status", async () => {
      const legacy = powershellEdition(path) === "Windows PowerShell 5.1"
      const command = "begin { Write-Output begin } process { Write-Output process } end { Write-Output end }"
      const expected = await native(command)
      expect(expected.code).toBe(0)
      expect(expected.output).toBe(legacy ? "begin\nend" : "begin\nprocess\nend")
      const r = await run(command)
      expect(textOf(r).replaceAll("\r\n", "\n")).toBe(`${expected.output}\n\nExit code: ${expected.code}`)
      expect(textOf(await run("end { Write-Error bad }"))).toEndWith("Exit code: 1")
      expect(textOf(await run("begin { Write-Output begin }"))).toBe("begin\n\nExit code: 0")
      expect(textOf(await run("process { Write-Error bad }"))).toEndWith(`Exit code: ${legacy ? 0 : 1}`)
      expect(
        textOf(await run("param($x = 'default') begin { Write-Output $x } end { return 'end' }")),
      ).toMatch(/^default\r?\nend\n\nExit code: 0$/)
    })

    test("errors name their own line and column and show only the command's text", async () => {
      // A terminating error on the first line: the wrapper adds nothing before it.
      const first = textOf(await run("Write-Output a; throw 'boom'"))
      expect(first).toMatch(
        /^a\r?\nboom\r?\n[^\n]*:1 \S+:\s*17\r?\n\+ Write-Output a; throw 'boom'\r?\n\+ {17}~{12}\n\nExit code: 1$/,
      )
      // Nor after the last one.
      const last = textOf(await run("Write-Output a\n$null.Foo()"))
      expect(last).toMatch(/:2 \S+:\s*1\r?\n\+ \$null\.Foo\(\)\r?\n\+ ~{11}\n\nExit code: 1$/)
      // An error made terminating by the preference lands on the wrapper's dot-source: left out.
      expect(textOf(await run("$ErrorActionPreference = 'Stop'; Write-Error bad; Write-Output after"))).toBe(
        "bad\n\nExit code: 1",
      )
      for (const text of [first, last]) expect(text).not.toContain("__amira")
    })

    test("a top-level break or continue ends the command with the status before it", async () => {
      for (const flow of ["break", "continue"]) {
        const ok = `Write-Output a; ${flow}; Write-Output b`
        expect(await native(ok)).toEqual({ output: "a", code: 0 })
        expect(textOf(await run(ok))).toBe("a\n\nExit code: 0")
        const bad = `Write-Error bad; ${flow}; Write-Output b`
        expect((await native(bad)).code).toBe(1)
        const r = await run(bad)
        expect(r.isError).toBe(true)
        expect(textOf(r)).toBe("bad\n\nExit code: 1")
      }
    })

    test("declarations and dot-sourced state work as natively", async () => {
      const legacy = powershellEdition(path) === "Windows PowerShell 5.1"
      for (const command of [
        "using namespace System.Text\n[StringBuilder]::new('sb').ToString()",
        "using module @{ ModuleName = 'Microsoft.PowerShell.Utility'; ModuleVersion = '1.0' }\nWrite-Output ok",
        "class Foo { [int]$A = 3 }\nfunction g { [Foo]::new().A + 1 }\ng",
        "enum Color { Red; Green }\n[Color]::Green",
        "[CmdletBinding()] param([int]$n = 2) dynamicparam { } begin { $x = $n } process { } end { Write-Output ($x * 2) }",
        "data d { 'x' }; $d",
        "$a = 1; & { $a + 1 }; function h { $a + 2 }; h",
        "trap { Write-Output trapped; continue }; throw 'bad'; Write-Output after",
        "$input.GetType().Name.Length -gt 0; @($input).Count",
        ...(legacy ? [] : ["end { Write-Output e } clean { Write-Output c }"]),
      ]) {
        const expected = await native(command)
        expect(textOf(await run(command)).replaceAll("\r\n", "\n")).toBe(
          `${expected.output}\n\nExit code: ${expected.code}`,
        )
      }
      if (!legacy) {
        const clean = textOf(await run("end { Write-Output e } clean { Write-Error bad }"))
        expect(clean.replaceAll("\r\n", "\n")).toBe("e\nbad\n\nExit code: 1")
      }
    })

    test("a long script with a top-level return on every line compiles in linear time", async () => {
      const command = `${Array.from({ length: 5000 }, (_, i) => `$v = ${i}; if ($v -lt 0) { return }`).join("\n")}\nWrite-Output done`
      const started = performance.now()
      expect(textOf(await run(command))).toBe("done\n\nExit code: 0")
      expect(performance.now() - started).toBeLessThan(10_000)
    })

    test("quotes survive: double quotes, $ and backticks", async () => {
      expect(textOf(await run("Write-Output 'a \"b\" $c `d'"))).toContain('a "b" $c `d')
    })

    test("commands longer than -EncodedCommand allows still run", async () => {
      const r = await run(`$x = '${"a".repeat(40_000)}'; $x.Length`)
      expect(textOf(r)).toBe("40000\n\nExit code: 0")
    })

    test("each call gets a fresh process, also when a standby serves it", async () => {
      const first = textOf(await run("$global:amiraLeak = 1; $PID"))
      const second = textOf(await run("[string]($null -eq $global:amiraLeak) + ' ' + $PID"))
      expect(second).toStartWith("True ")
      expect(second.split("\n")[0]?.split(" ")[1]).not.toBe(first.split("\n")[0])
    })

    test("abort stops a long command promptly", async () => {
      const abort = new AbortController()
      const p = run("Start-Sleep -Seconds 60", abort.signal)
      setTimeout(() => abort.abort(), 3000)
      const started = performance.now()
      expect(textOf(await p)).toContain("aborted")
      expect(performance.now() - started).toBeLessThan(30_000)
    })

    describe("working directory", () => {
      const temp = tempDirs()
      afterAll(() => temp.cleanup())
      const shell = gatedPowerShell(path)
      const lf = (s: string) => s.replaceAll("\r\n", "\n")
      const runIn = (dir: string, command: string) => tool.execute({ command }, makeCtx(dir))
      /** Runs through a pool that counts cold runs and records where standbys start. */
      const countingPool = () => {
        const counts = { cold: 0, prepared: [] as string[] }
        const pool = new StandbyPool({
          prepare: (argv, opts) => {
            counts.prepared.push(opts.cwd)
            return prepareCommand(argv, opts)
          },
          run: (argv, opts) => {
            counts.cold++
            return runCommand(argv, opts)
          },
        })
        const run = (dir: string, command: string) =>
          pool.run(shell.command(command, dir), { timeoutMs: 60_000, signal: new AbortController().signal })
        return { pool, counts, run }
      }
      const special = async () => {
        const dir = join(await temp.make(), "we [x] 'q' $y `b é你 ;&(%) ~")
        await mkdir(dir)
        await writeFile(join(dir, "rel.txt"), "hi")
        return dir
      }

      test("cmdlets, .NET methods and native programs all see it, whatever its characters", async () => {
        const dir = await special()
        const r = await runIn(
          dir,
          [
            "(Get-Location).ProviderPath",
            "[Environment]::CurrentDirectory",
            "[IO.File]::Exists('rel.txt')",
            "Get-Content rel.txt",
            'cmd /c "echo native> native.txt"',
          ].join("\n"),
        )
        expect(lf(textOf(r))).toBe(`${dir}\n${dir}\nTrue\nhi\n\nExit code: 0`)
        expect(existsSync(join(dir, "native.txt"))).toBe(true)
      })

      test("a working directory that is gone fails before the command runs", async () => {
        const parent = await temp.make()
        const dir = join(parent, "gone [x] 'q' $y é")
        const marker = join(parent, "ran.txt")
        const runCold = (cwd: string) => {
          const { argv, ...spawn } = shell.command(`New-Item -ItemType File -Path '${marker}'`, cwd)
          return runCommand(argv, { ...spawn, timeoutMs: 60_000, signal: new AbortController().signal })
        }
        const gone = await runCold(dir)
        expect(gone.output.trim()).toBe(`Working directory does not exist: ${dir}`)
        expect(gone.exitCode).toBe(1)
        // An empty one must not fall back to running in the start directory.
        const empty = await runCold("")
        expect(empty.output.trim()).toBe("No working directory was given")
        expect(empty.exitCode).toBe(1)
        expect(existsSync(marker)).toBe(false)
      })

      const unc = "\\\\localhost\\C$\\Windows"
      test.if(existsSync(unc))("a UNC working directory is entered as is", async () => {
        const r = await runIn(
          unc,
          "(Get-Location).ProviderPath; [Environment]::CurrentDirectory; [IO.Directory]::Exists('System32')",
        )
        expect(lf(textOf(r))).toBe(`${unc}\n${unc}\nTrue\n\nExit code: 0`)
      })

      test("a working directory longer than MAX_PATH runs cmdlets there, or fails cleanly", async () => {
        let dir = await temp.make()
        while (dir.length < 300) dir = join(dir, "d".repeat(40))
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, "rel.txt"), "long")
        const text = lf(textOf(await runIn(dir, "(Get-Location).ProviderPath; Get-Content rel.txt")))
        // 5.1 without long paths enabled in the registry cannot enter it at all.
        if (text.startsWith("Cannot enter the working directory")) {
          expect(path.toLowerCase()).not.toContain("pwsh")
          expect(text).toEndWith("Exit code: 1")
          return
        }
        // What cannot use the directory is named: always native programs, in pwsh 7 also .NET.
        expect(text).toContain("Warning: native programs cannot start")
        expect(text.replace(/^Warning: .*\n/gm, "")).toBe(`${dir}\nlong\n\nExit code: 0`)
      })

      test("one standby serves every working directory, and it starts outside them", async () => {
        const { pool, counts, run } = countingPool()
        try {
          const a = await special()
          const b = await temp.make()
          pool.fill(shell.command("", a))
          expect((await run(a, "(Get-Location).ProviderPath")).output.trim()).toBe(a)
          expect((await run(b, "(Get-Location).ProviderPath")).output.trim()).toBe(b)
          expect(counts.cold).toBe(0)
          expect(counts.prepared).toEqual([powershellStartDir(), powershellStartDir(), powershellStartDir()])
        } finally {
          pool.dispose()
        }
      })

      test("an idle standby does not hold the session directory", async () => {
        const { pool, counts, run } = countingPool()
        try {
          const parent = await temp.make()
          let [from, to] = [join(parent, "project"), join(parent, "renamed")]
          await mkdir(from)
          pool.fill(shell.command("", from))
          // Starts the standby's replacement; it serves the next command.
          await run(from, "$null")
          // Proven once the process that runs the next command was already started before the
          // rename. A slow spawn (antivirus) can start it later; then the next attempt checks.
          let startedFirst = false
          for (let attempt = 1; attempt <= 4 && !startedFirst; attempt++) {
            await Bun.sleep(1000 * attempt)
            const before = Date.now()
            await rename(from, to)
            ;[from, to] = [to, from]
            const r = await run(
              from,
              "[DateTimeOffset]::new((Get-Process -Id $PID).StartTime).ToUnixTimeMilliseconds()",
            )
            startedFirst = Number(r.output.trim()) < before
          }
          expect(startedFirst).toBe(true)
          expect(counts.cold).toBe(0)
        } finally {
          pool.dispose()
        }
      })
    })
  })
}

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { createPowershellTool, powershellDescription } from "../src/bash.ts"
import { encodeCommand, encodePowerShell, POWERSHELL_SCRIPT, powershellEdition } from "../src/powershell.ts"
import { makeCtx, textOf } from "./util.ts"

// PowerShell starts slowly, and antivirus can stall spawns for seconds.
setDefaultTimeout(120_000)
const onWindows = process.platform === "win32"

test("the script reads the command from the gate line before running it", () => {
  const gate = POWERSHELL_SCRIPT.indexOf("[Console]::In.ReadLine()")
  expect(gate).toBeGreaterThan(0)
  expect(POWERSHELL_SCRIPT.indexOf("FromBase64String")).toBeGreaterThan(gate)
  // Before the gate the process is not yet known to be in its job: it must start nothing.
  expect(POWERSHELL_SCRIPT.slice(0, gate)).not.toMatch(/Start-Process|Invoke-Expression|\.exe|&\s*\$/i)
  expect(POWERSHELL_SCRIPT).toContain("UTF8Encoding")
  expect(Buffer.from(encodePowerShell("é"), "base64").toString("utf16le")).toBe("é")
  expect(encodeCommand("你好\nx")).not.toContain("\n")
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

    test("exit and throw inside the command are honoured", async () => {
      expect(textOf(await run("Write-Output before; exit 7; Write-Output after"))).toBe(
        "before\n\nExit code: 7",
      )
      const thrown = textOf(await run('Write-Output a; throw "stop here"; Write-Output b'))
      expect(thrown).toContain("stop here")
      expect(thrown).not.toContain("\nb\n")
      expect(thrown).toContain("Exit code: 1")
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
  })
}

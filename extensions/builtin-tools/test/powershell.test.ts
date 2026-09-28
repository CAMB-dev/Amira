import { expect, setDefaultTimeout, test } from "bun:test"
import { powershellTool } from "../src/bash.ts"
import { encodePowerShell, powershellScript } from "../src/shell.ts"
import { makeCtx, textOf } from "./util.ts"

// PowerShell starts slowly, and antivirus can stall spawns for seconds.
setDefaultTimeout(120_000)
const onWindows = process.platform === "win32"

test("the script waits for the gate, forces UTF-8 and passes exit codes through", () => {
  const script = powershellScript("Get-Date")
  expect(script.split("\n")[0]).toContain("ReadLine()")
  expect(script).toContain("UTF8Encoding")
  expect(script).toContain("Get-Date")
  expect(Buffer.from(encodePowerShell("é"), "base64").toString("utf16le")).toBe("é")
})

test.skipIf(!onWindows)("runs PowerShell with UTF-8 output", async () => {
  const r = await powershellTool.execute(
    { command: 'Write-Output "你好 héllo"; $PSVersionTable.PSEdition' },
    makeCtx(process.cwd()),
  )
  expect(r.isError).toBeFalsy()
  expect(textOf(r)).toContain("你好 héllo")
  expect(textOf(r)).toContain("Exit code: 0")
})

test.skipIf(!onWindows)("reports native exit codes and failed statements", async () => {
  const native = await powershellTool.execute({ command: "cmd /c exit 3" }, makeCtx(process.cwd()))
  expect(textOf(native)).toContain("Exit code: 3")
  const failed = await powershellTool.execute(
    { command: "Get-Item C:definitely\nothere" },
    makeCtx(process.cwd()),
  )
  expect(failed.isError).toBe(true)
  expect(textOf(failed)).toContain("Exit code: 1")
})

test.skipIf(!onWindows)("quotes survive: double quotes, $ and backticks", async () => {
  const r = await powershellTool.execute({ command: "Write-Output 'a \"b\" $c `d'" }, makeCtx(process.cwd()))
  expect(textOf(r)).toContain('a "b" $c `d')
})

test.skipIf(!onWindows)("abort stops a long command promptly", async () => {
  const abort = new AbortController()
  const ctx = makeCtx(process.cwd(), abort.signal)
  const p = powershellTool.execute({ command: "Start-Sleep -Seconds 60" }, ctx)
  setTimeout(() => abort.abort(), 3000)
  const started = performance.now()
  const r = await p
  expect(textOf(r)).toContain("aborted")
  expect(performance.now() - started).toBeLessThan(30_000)
})

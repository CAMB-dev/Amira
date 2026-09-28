import { win32 } from "node:path"
import type { Shell } from "./shell.ts"
import { StandbyPool } from "./standby.ts"

/** pwsh when installed, else Windows PowerShell. AMIRA_POWERSHELL picks one explicitly. */
export function findPowerShell(env: Record<string, string | undefined> = process.env): string {
  return env.AMIRA_POWERSHELL || Bun.which("pwsh") || Bun.which("powershell") || "powershell.exe"
}

/** The edition behind a PowerShell path, as told to the model. */
export function powershellEdition(path: string): string {
  const name = win32.basename(path).toLowerCase()
  return name === "pwsh.exe" || name === "pwsh" ? "PowerShell 7 (pwsh)" : "Windows PowerShell 5.1"
}

/**
 * The fixed script run for every PowerShell command. The command arrives as the gate line
 * (base64 UTF-8, sent once the process is in its Job Object), so it is not size-limited like
 * -EncodedCommand, and it is compiled here, after UTF-8 is set, so syntax errors are readable.
 * Every stream is rendered as text on stdout: redirected error, progress and information
 * records would otherwise come out as CLIXML. Exits with $LASTEXITCODE, or 1 when the final
 * statement failed.
 */
export const POWERSHELL_SCRIPT = [
  "$__amira = [Console]::In.ReadLine()",
  "if ($null -eq $__amira) { exit 125 }",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$ProgressPreference = 'SilentlyContinue'",
  "if (Get-Variable PSStyle -ErrorAction Ignore) { $PSStyle.OutputRendering = 'PlainText' }",
  // Errors as `Cmdlet: message`. The default views add positions inside this wrapper, and 5.1
  // wraps each native stderr line in a record of its own; those keep just the line.
  "function __amira_error($r, [switch]$At) {",
  "  if ($r.FullyQualifiedErrorId -like 'NativeCommandError*') { return $r.Exception.Message }",
  "  $c = $r.InvocationInfo.MyCommand",
  '  if ($c -is [System.Management.Automation.CmdletInfo]) { "$($c.Name): $($r.Exception.Message)" } else { $r.Exception.Message }',
  "  if ($At -and $r.InvocationInfo.PositionMessage) { $r.InvocationInfo.PositionMessage }",
  "}",
  "filter __amira_errors { if ($_ -is [System.Management.Automation.ErrorRecord]) { __amira_error $_ } else { $_ } }",
  "filter __amira_trim { $_.TrimEnd() }",
  "try {",
  '  $__amira = [scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__amira)) + "`n`$__amira_ok = `$?")',
  "} catch {",
  "  $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }",
  "  [Console]::Out.WriteLine($e.Message); exit 1",
  "}",
  "$__amira_ok = $null",
  "$__amira_threw = $false",
  "$__amira_errs = $Error.Count",
  "$global:LASTEXITCODE = 0",
  // $? after the dot-source is always true, so the command's own last line records it.
  "try { . { . $__amira } *>&1 | __amira_errors | Out-String -Stream -Width 300 | __amira_trim }",
  "catch { $__amira_threw = $true; __amira_error $_ -At | Out-String -Stream -Width 300 | __amira_trim }",
  // A top-level `return` skipped that line: failed if the latest error came from the command.
  "if ($null -eq $__amira_ok) { $__amira_ok = -not ($Error.Count -gt $__amira_errs -and \"$($Error[0].FullyQualifiedErrorId)\" -notlike 'NativeCommandError*') }",
  // 5.1 marks a native command that wrote to stderr as failed even when it exited 0.
  "if (-not $__amira_ok -and -not $global:LASTEXITCODE -and \"$($Error[0].FullyQualifiedErrorId)\" -like 'NativeCommandError*') { $__amira_ok = $true }",
  "if ($__amira_threw -or -not $__amira_ok) { if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE } else { exit 1 } }",
  "exit $global:LASTEXITCODE",
].join("\n")

/** -EncodedCommand takes base64 of UTF-16LE, which sidesteps every argument-quoting quirk. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

/** The gate line that carries a command to POWERSHELL_SCRIPT. */
export function encodeCommand(command: string): string {
  return Buffer.from(command, "utf8").toString("base64")
}

/** Gated PowerShell: nothing runs, and no command text is even read, until the job holds it. */
export function gatedPowerShell(path = findPowerShell(), label?: string): Shell {
  const argv = [
    path,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodePowerShell(POWERSHELL_SCRIPT),
  ]
  return {
    kind: "powershell",
    path,
    ...(label ? { label } : {}),
    command: (command) => ({ argv, env: { ...process.env }, gated: true, gateLine: encodeCommand(command) }),
  }
}

let cached: Promise<Shell> | undefined

/** The shell behind the powershell tool, resolved once per process. */
export function resolvePowerShell(): Promise<Shell> {
  cached ??= Promise.resolve(gatedPowerShell())
  return cached
}

/** A PowerShell process kept waiting for the powershell tool's next command. */
export const powershellStandby = new StandbyPool()

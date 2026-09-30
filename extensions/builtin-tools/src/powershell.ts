import { existsSync } from "node:fs"
import { homedir } from "node:os"
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

let startDir: string | undefined

/**
 * Where every PowerShell process starts: the user's home, which always exists and, as the
 * signed-in user's profile, cannot be renamed or deleted anyway. The process enters the
 * command's working directory only after the gate, so an idle standby never holds the session
 * directory open (Windows refuses to rename or delete a directory some process is in), and one
 * standby serves every working directory. Falls back to the Windows directory if home is gone.
 */
export function powershellStartDir(): string {
  startDir ??=
    [homedir(), process.env.SystemRoot, "C:\\Windows"].find((d) => !!d && existsSync(d)) ?? homedir()
  return startDir
}

/**
 * The fixed script run for every PowerShell command. The command and its working directory
 * arrive as the gate line (base64 UTF-8 each, sent once the process is in its Job Object), so
 * the command is not size-limited like -EncodedCommand, neither is ever spliced into script
 * text, and the command is compiled here, after UTF-8 is set, so syntax errors are readable.
 * Everything before the gate only prepares this process (a standby does it while it waits):
 * it starts nothing and dry-runs the output pipeline and the directory change (on the start
 * directory), so their first real use is already compiled. After the gate it enters the working
 * directory, for cmdlets (Set-Location) and for .NET methods and native programs (the process
 * directory); a directory it cannot enter fails the command with exit code 1 before it runs.
 * Every stream is rendered as text on stdout: redirected error, progress and information
 * records would otherwise come out as CLIXML. Exits with $LASTEXITCODE, or 1 when the final
 * statement failed.
 */
export const POWERSHELL_SCRIPT = [
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
  // The command ends with `$__amira_ok = $?`, which a top-level `return` skips, so each such
  // return records $? itself: the value `pwsh -Command` exits on. A return leaves $? as it was,
  // unless its pipeline runs commands, which set it; such a return runs in a try whose finally
  // reads it (not after: this wrapper's own filters set it as the output passes), and the try's
  // first line, a Clear-Variable that succeeds or fails silently, puts back the $? the try reset.
  // A return nested in another is left alone.
  "function __amira_top($r) {",
  "  if ($r.Parent -isnot [System.Management.Automation.Language.NamedBlockAst] -and $r.Parent -isnot [System.Management.Automation.Language.StatementBlockAst]) { return $false }",
  "  for ($p = $r.Parent; $p; $p = $p.Parent) {",
  "    if ($p -is [System.Management.Automation.Language.ReturnStatementAst]) { return $false }",
  "    if ($p -is [System.Management.Automation.Language.ScriptBlockAst]) { return $null -eq $p.Parent }",
  "  }",
  "  $false",
  "}",
  "function __amira_compile($text) {",
  "  $sb = [scriptblock]::Create($text)",
  "  $rs = @($sb.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.ReturnStatementAst] -and (__amira_top $a) }, $true))",
  "  if (-not $rs.Count) { return $sb }",
  "  for ($i = $rs.Count - 1; $i -ge 0; $i--) {",
  "    $r = $rs[$i]",
  "    $new = '$__amira_ok = $?; ' + $r.Extent.Text",
  "    if ($r.Pipeline -and $r.Pipeline.Find({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true)) {",
  "      $new = \"`$__amira_ok = `$?; try { Clear-Variable ('__amira_nx', '__amira_ok')[[int]`$__amira_ok] -ErrorAction Ignore`n$($r.Extent.Text)`n} finally { `$__amira_ok = `$? }\"",
  "    }",
  "    $text = $text.Substring(0, $r.Extent.StartOffset) + $new + $text.Substring($r.Extent.EndOffset)",
  "  }",
  "  [scriptblock]::Create($text)",
  "}",
  // Reads the gate line, `<base64 directory> <base64 command>`, and enters the directory for
  // cmdlets (Set-Location) and for .NET methods and native programs (the process directory).
  // Returns the compiled command, or the message to fail with. Warnings go straight out.
  "function __amira_open($line) {",
  "  try {",
  // Ordinal: IndexOf(string) compares by culture, and loading culture data costs ~25 ms.
  "    $at = $line.IndexOf([char]' ')",
  "    $dir = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(0, $at)))",
  '    $command = __amira_compile ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring($at + 1))) + "`n`$__amira_ok = `$?")',
  "  } catch {",
  "    $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }",
  "    return $e.Message",
  "  }",
  "  if (-not $dir) { return 'No working directory was given' }",
  "  try { Set-Location -LiteralPath $dir -ErrorAction Stop } catch {",
  "    $found = $false",
  "    try { $found = Test-Path -LiteralPath $dir -PathType Container } catch {}",
  '    if ($found -or $dir.Length -gt 258) { return "Cannot enter the working directory $($dir): $($_.Exception.Message)" }',
  '    return "Working directory does not exist: $dir"',
  "  }",
  "  $here = (Get-Location).ProviderPath",
  // pwsh 7 refuses a directory past MAX_PATH even with long paths enabled; cmdlets still work.
  "  try { [Environment]::CurrentDirectory = $here } catch {",
  "    $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }",
  '    [Console]::Out.WriteLine("Warning: .NET methods cannot use this working directory ($($e.Message)); they resolve relative paths against $([Environment]::CurrentDirectory).")',
  "  }",
  "  if ($here.Length -gt 258) {",
  "    [Console]::Out.WriteLine('Warning: native programs cannot start in a working directory longer than 258 characters.')",
  "  }",
  "  $command",
  "}",
  "$null = [scriptblock]::Create('$null')",
  ". { $null } *>&1 | __amira_errors | Out-String -Stream -Width 300 | __amira_trim",
  // A dry run on the start directory (compiling `return`), so the real one reuses the compiled functions.
  "$null = __amira_open ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.ProviderPath)) + ' cmV0dXJu')",
  "$__amira = [Console]::In.ReadLine()",
  "if ($null -eq $__amira) { exit 125 }",
  "$__amira = __amira_open $__amira",
  "if ($__amira -isnot [scriptblock]) { [Console]::Out.WriteLine($__amira); exit 1 }",
  "$__amira_ok = $null",
  "$__amira_threw = $false",
  "$__amira_errs = $Error.Count",
  "$global:LASTEXITCODE = 0",
  // $? after the dot-source is always true, so the command's own last line records it.
  "try { . { . $__amira } *>&1 | __amira_errors | Out-String -Stream -Width 300 | __amira_trim }",
  "catch { $__amira_threw = $true; __amira_error $_ -At | Out-String -Stream -Width 300 | __amira_trim }",
  // A return __amira_compile left alone skipped that line: failed if the latest error came from the command.
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

/** The gate line that carries a command and its working directory to POWERSHELL_SCRIPT. */
export function encodeCommand(command: string, cwd: string): string {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
  return `${b64(cwd)} ${b64(command)}`
}

/** Gated PowerShell: the command is not run, or even read, until the job holds the process. */
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
    command: (command, cwd) => ({
      argv,
      env: { ...process.env },
      cwd: powershellStartDir(),
      gated: true,
      gateLine: encodeCommand(command, cwd),
    }),
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

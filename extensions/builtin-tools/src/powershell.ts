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
  // The exit status is $? once the command has run: read in a finally around each script-level
  // block, which runs after the command's own finally blocks and after traps unwind (whose
  // return status differs between 5.1 and 7). The finally is added to the AST, not the text
  // (__amira_wrap), so every error still names its own line and column and shows only the
  // command's text. A top-level `return` is the exception: it is rewritten in the text, with
  // no line break, so an error after it on the same line names its line but not its column.
  "function __amira_top($r) {",
  "  if ($r.Parent -isnot [System.Management.Automation.Language.NamedBlockAst] -and $r.Parent -isnot [System.Management.Automation.Language.StatementBlockAst]) { return $false }",
  "  for ($p = $r.Parent; $p; $p = $p.Parent) {",
  // 7 restores a trap's failure as it unwinds; 5.1 keeps the status at its return.
  "    if ($p -is [System.Management.Automation.Language.TrapStatementAst] -and $PSVersionTable.PSVersion.Major -ge 6) { return $false }",
  "    if ($p -is [System.Management.Automation.Language.ReturnStatementAst]) { return $false }",
  "    if ($p -is [System.Management.Automation.Language.ScriptBlockAst]) { return $null -eq $p.Parent }",
  "  }",
  "  $false",
  "}",
  // UsingStatementAst.Copy() shares its children with the original, which no other tree accepts.
  "function __amira_using($u) {",
  "  if ($u.ModuleSpecification) {",
  "    if ($u.Alias) { return [System.Management.Automation.Language.UsingStatementAst]::new($u.Extent, $u.Alias.Copy(), $u.ModuleSpecification.Copy()) }",
  "    return [System.Management.Automation.Language.UsingStatementAst]::new($u.Extent, $u.ModuleSpecification.Copy())",
  "  }",
  "  if ($u.Alias) { return [System.Management.Automation.Language.UsingStatementAst]::new($u.Extent, $u.UsingStatementKind, $u.Alias.Copy(), $u.Name.Copy()) }",
  "  [System.Management.Automation.Language.UsingStatementAst]::new($u.Extent, $u.UsingStatementKind, $u.Name.Copy())",
  "}",
  // The block's statements and traps inside `try { } finally { $script:__amira_ok = $? }`.
  "function __amira_block($b, $ok) {",
  "  if (-not $b) { return $null }",
  "  $ss = [System.Management.Automation.Language.StatementAst[]]@(foreach ($s in $b.Statements) { $s.Copy() })",
  "  $ts = [System.Management.Automation.Language.TrapStatementAst[]]@(foreach ($t in $b.Traps) { $t.Copy() })",
  "  if (-not $ss.Count -and -not $ts.Count) { return $b.Copy() }",
  "  $body = [System.Management.Automation.Language.StatementBlockAst]::new($b.Extent, $ss, $ts)",
  "  $fin = [System.Management.Automation.Language.StatementBlockAst]::new($b.Extent, [System.Management.Automation.Language.StatementAst[]]@($ok.Copy()), $null)",
  "  $try = [System.Management.Automation.Language.TryStatementAst]::new($b.Extent, $body, [System.Management.Automation.Language.CatchClauseAst[]]@(), $fin)",
  "  $outer = [System.Management.Automation.Language.StatementBlockAst]::new($b.Extent, [System.Management.Automation.Language.StatementAst[]]@($try), $null)",
  "  [System.Management.Automation.Language.NamedBlockAst]::new($b.Extent, $b.BlockKind, $outer, $b.Unnamed)",
  "}",
  // The same script block with each named block wrapped; using, attributes and param stay as
  // they are. Extents still point into the command's text, so positions are unchanged.
  "function __amira_wrap($sb) {",
  "  $a = $sb.Ast",
  "  $ok = [System.Management.Automation.Language.Parser]::ParseInput('$script:__amira_ok = $?', [ref]$null, [ref]$null).EndBlock.Statements[0]",
  "  $us = [System.Management.Automation.Language.UsingStatementAst[]]@(foreach ($u in $a.UsingStatements) { __amira_using $u })",
  "  $at = [System.Management.Automation.Language.AttributeAst[]]@(foreach ($x in $a.Attributes) { $x.Copy() })",
  "  $pb = if ($a.ParamBlock) { $a.ParamBlock.Copy() } else { $null }",
  "  $begin = __amira_block $a.BeginBlock $ok; $process = __amira_block $a.ProcessBlock $ok",
  "  $end = __amira_block $a.EndBlock $ok; $dynamic = __amira_block $a.DynamicParamBlock $ok",
  // The clean block, and the constructor taking one, exist from 7.3 on.
  "  if ($a.PSObject.Properties['CleanBlock'] -and $a.CleanBlock) {",
  "    $ast = [System.Management.Automation.Language.ScriptBlockAst]::new($a.Extent, $us, $at, $pb, $begin, $process, $end, (__amira_block $a.CleanBlock $ok), $dynamic)",
  "  } else {",
  "    $ast = [System.Management.Automation.Language.ScriptBlockAst]::new($a.Extent, $us, $at, $pb, $begin, $process, $end, $dynamic)",
  "  }",
  "  $ast.GetScriptBlock()",
  "}",
  "function __amira_compile($text) {",
  "  $sb = [scriptblock]::Create($text)",
  // Sorted: FindAll visits named blocks in begin, process, end order, whatever their order in the text.
  "  $rs = @($sb.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.ReturnStatementAst] -and (__amira_top $a) }, $true) | Sort-Object { $_.Extent.StartOffset } -Descending)",
  // A value-only return leaves $? unchanged natively, but our output filters can change it.
  // Restore it before evaluating the value (the assignment that saved it set $? to true) and
  // before any user finally runs. Clear-Variable succeeds or fails silently according to the
  // saved status.
  "  $restore = \"Clear-Variable ('__amira_nx', '__amira_restore')[[int]`$script:__amira_return] -Scope Script -ErrorAction Ignore\"",
  "  foreach ($r in $rs) {",
  "    if ($r.Pipeline -and $r.Pipeline.Find({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true)) { continue }",
  '    $text = $text.Substring(0, $r.Extent.StartOffset) + "`$script:__amira_return = `$?; try { $restore; $($r.Extent.Text) } finally { $restore }" + $text.Substring($r.Extent.EndOffset)',
  "  }",
  "  if ($rs.Count) { $sb = [scriptblock]::Create($text) }",
  "  __amira_wrap $sb",
  "}",
  // Reads the gate line, `<base64 directory> <base64 command>`, and enters the directory for
  // cmdlets (Set-Location) and for .NET methods and native programs (the process directory).
  // Returns the compiled command, or the message to fail with. Warnings go straight out.
  "function __amira_open($line) {",
  "  try {",
  // Ordinal: IndexOf(string) compares by culture, and loading culture data costs ~25 ms.
  "    $at = $line.IndexOf([char]' ')",
  "    $dir = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(0, $at)))",
  "    $command = __amira_compile ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring($at + 1))))",
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
  "$__amira_restore = $null",
  "$__amira_threw = $false",
  "$__amira_errs = $Error.Count",
  "$global:LASTEXITCODE = 0",
  // $? after the dot-source is always true, so the command's own finally records it.
  // Like native -Command/-File, 5.1 gives process blocks no input; 7 invokes them once.
  "try { . { if ($PSVersionTable.PSVersion.Major -lt 6) { @() | . $__amira } else { . $__amira } } *>&1 | __amira_errors | Out-String -Stream -Width 300 | __amira_trim }",
  "catch { $__amira_threw = $true; __amira_error $_ -At | Out-String -Stream -Width 300 | __amira_trim }",
  // An empty block, or a return nested in another, may not have recorded a status.
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

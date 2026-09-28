import { extname, isAbsolute, win32 } from "node:path"

/**
 * Characters cmd.exe treats specially; each gets a `^` so cmd passes it through literally.
 * `=` would otherwise end the program token early. `^%` is a heuristic, as in cross-spawn: it
 * keeps `%NAME%` from expanding on the command line.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?=])/g

/** cmd refuses lines over 8191 characters; leave room for the flags. */
const MAX_CMD_LINE = 8000

/** Set by cmd from the gate line; the program sees it (see RunOptions.viaCmd). */
export const CMD_GATE_VAR = "AMIRA_GATE"

/**
 * Quotes one argument the way Bun (libuv) does for a direct spawn, so the program sees the same
 * command line either way: only when needed, and backslashes are doubled only before a quote.
 */
export function quoteArg(arg: string): string {
  if (arg === "") return '""'
  if (!/[\s"]/.test(arg)) return arg
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")
  return `"${escaped}"`
}

/**
 * The text for `cmd.exe /d /s /c "<text>"` that runs argv: each part quoted as a direct spawn
 * would, then every cmd metacharacter escaped with `^` (as the cross-spawn package does). Only
 * for .exe programs: a batch file would parse its arguments a second time.
 */
export function cmdCommandLine(argv: string[]): string {
  return argv.map((a) => quoteArg(a).replace(CMD_META, "^$1")).join(" ")
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/**
 * argv for starting argv[0] through cmd.exe, which first waits for the gate line when `gated`.
 * Must be spawned with `windowsVerbatimArguments`. Undefined when cmd cannot be used: a UNC
 * working directory (cmd would fall back to the Windows directory), a program that is missing
 * or not an .exe, an argument with a line break (cmd ends the command line there and would
 * silently drop the rest), or a line too long for cmd.
 */
export function cmdArgv(
  argv: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; gated: boolean },
): string[] | undefined {
  const [program, ...args] = argv
  if (!program || /^[\\/]{2}/.test(opts.cwd)) return undefined
  if (argv.some((a) => /[\r\n]/.test(a))) return undefined
  const resolved = isAbsolute(program)
    ? program
    : Bun.which(program, { PATH: envValue(opts.env, "PATH") ?? "", cwd: opts.cwd })
  if (!resolved || ![".exe", ".com"].includes(extname(resolved).toLowerCase())) return undefined
  const gate = opts.gated ? `set /p ${CMD_GATE_VAR}=||exit 125&` : ""
  const line = `"${gate}${cmdCommandLine([win32.normalize(resolved), ...args])}"`
  if (line.length > MAX_CMD_LINE) return undefined
  // The escaping is cmd's own, so never COMSPEC or whatever cmd.exe PATH finds. /e:on: without
  // command extensions `set /p` does not wait, and the program would start before the job holds it.
  const cmd = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
  return [cmd, "/d", "/e:on", "/v:off", "/s", "/c", line]
}

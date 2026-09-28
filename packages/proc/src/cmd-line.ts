import { extname, isAbsolute, win32 } from "node:path"

/** Characters cmd.exe treats specially; each gets a `^` so cmd passes it through literally. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

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
 * working directory (cmd would fall back to the Windows directory), or a program that is
 * missing or not an .exe.
 */
export function cmdArgv(
  argv: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; gated: boolean },
): string[] | undefined {
  const [program, ...args] = argv
  if (!program || /^[\\/]{2}/.test(opts.cwd)) return undefined
  const resolved = isAbsolute(program)
    ? program
    : Bun.which(program, { PATH: envValue(opts.env, "PATH") ?? "", cwd: opts.cwd })
  if (!resolved || ![".exe", ".com"].includes(extname(resolved).toLowerCase())) return undefined
  const gate = opts.gated ? `set /p ${CMD_GATE_VAR}=||exit 125&` : ""
  const comspec = envValue(process.env, "COMSPEC") ?? "cmd.exe"
  return [
    comspec,
    "/d",
    "/v:off",
    "/s",
    "/c",
    `"${gate}${cmdCommandLine([win32.normalize(resolved), ...args])}"`,
  ]
}

/** Wraps argv in a shell launcher, the way npx.cmd leaves the real server as a grandchild. */
export function launcherArgv(argv: string[]): string[] {
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/c", ...argv]
    : ["sh", "-c", '"$0" "$@"; :', ...argv]
}

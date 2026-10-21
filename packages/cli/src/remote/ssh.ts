import { spawn } from "node:child_process"
import type { RemoteIO } from "./connection.ts"
import { RemoteSetupError, sshExitError } from "./reconnect-failure.ts"

export interface SshSession extends RemoteIO {
  end(bytes?: Uint8Array): Promise<void>
  /** Process termination proof, independent of potentially inherited stdout/stderr handles. */
  readonly exitStatus?: Promise<number>
  /** Joins the process and its local pipe readers. */
  readonly exited: Promise<number>
  /** Bounded, terminal-safe diagnostics. Stdout remains protocol-only. */
  stderr(): string
}
export type SshLauncher = (argv: readonly string[]) => SshSession

function isControl(character: string): boolean {
  const code = character.charCodeAt(0)
  return code < 32 || (code >= 127 && code <= 159)
}

export function hasRemoteControlCharacters(value: string): boolean {
  return Array.from(value).some(isControl)
}

export function validateSshHost(host: string): string {
  if (
    host.length > 255 ||
    hasRemoteControlCharacters(host) ||
    !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9][A-Za-z0-9_.-]*|\[[a-fA-F0-9:]+\])$/.test(host)
  )
    throw new Error("Use an SSH host alias or [user@]hostname, without options or spaces")
  return host
}

export function quoteShell(value: string): string {
  if (value.includes("\0")) throw new Error("Shell arguments cannot contain NUL")
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** OpenSSH joins remote arguments into a shell command: quote the entire fixed script and operands. */
export function sshArgv(host: string, script: string, args: readonly string[] = []): string[] {
  return [
    "-T",
    "-a",
    "-o",
    "ForwardAgent=no",
    "--",
    validateSshHost(host),
    ["sh", "-c", quoteShell(script), "amira-remote", ...args.map(quoteShell)].join(" "),
  ]
}

/** The only production process launcher. Tests inject a local executable, never real SSH. */
export const launchSsh: SshLauncher = (argv) => spawnSshProcess("ssh", argv)

/** Local argv spawning, also used by offline fake-SSH fixtures. Never uses a local shell. */
export function spawnSshProcess(
  executable: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SshSession {
  const child = spawn(executable, [...argv], { stdio: "pipe", shell: false, windowsHide: true, env })
  let diagnostics = Buffer.alloc(0)
  const exitStatus = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 255))
  })
  void exitStatus.catch(() => {})
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 255))
  })
  // A caller may close before awaiting exit, or hand the pipes to a protocol connection.
  void exited.catch(() => {})
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics = Buffer.concat([diagnostics, chunk]).subarray(-16 * 1024)
  })
  child.stdin.on("error", () => {})
  const write = (bytes: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()))
    })
  return {
    input: child.stdout,
    write,
    async end(bytes) {
      if (bytes) await write(bytes)
      await new Promise<void>((resolve, reject) => {
        child.stdin.end((error?: Error | null) => (error ? reject(error) : resolve()))
      })
    },
    close() {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      child.kill()
    },
    exitStatus,
    exited,
    stderr: () =>
      Array.from(diagnostics.toString("utf8"))
        .filter((character) => character === "\n" || character === "\t" || !isControl(character))
        .join(""),
  }
}

export async function runSsh(
  launcher: SshLauncher,
  argv: readonly string[],
  input?: Uint8Array,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Uint8Array> {
  const session = launcher(argv)
  const maximum = options.maxBytes ?? 64 * 1024
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = async () => {
      const collect = async () => {
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const bytes of session.input) {
          size += bytes.length
          if (size > maximum) throw new Error("SSH response exceeds the deployment limit")
          chunks.push(bytes)
        }
        return Buffer.concat(chunks, size)
      }
      const [output, , code] = await Promise.all([collect(), session.end(input), session.exited])
      const failure = sshExitError(code, session.stderr(), "setup")
      if (failure) throw failure
      return output
    }
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RemoteSetupError(
                "transport",
                "Remote setup timed out",
                "Retrying automatically. Check the SSH connection to the remote host.",
              ),
            ),
          options.timeoutMs ?? 120_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    session.close()
    await session.exited.catch(() => {})
  }
}
